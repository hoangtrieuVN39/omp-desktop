// Phone protocol-2 client layer: request correlation, scope/capability state,
// image upload, download. No DOM, socket or timers of its own: the transport
// (`send`), the clock and the timer are injected, so tests drive it directly.
// The scope tables mirror `src-tauri/src/remote/scope.rs` and the limits
// `src-tauri/src/remote/transfers.rs`; tests/test-remote-protocol.mjs reads
// both Rust files and fails when they drift.
(function (root) {
  const LEVEL = { view: 0, control: 1, manage: 2 };

  const ACTIONS = {
    select: "view",
    prompt: "control", steer: "control", abort: "control", answer: "control",
    followUp: "control", queueRemove: "control", queuePromote: "control",
    queueSendNow: "control", stopRetry: "control", subagentSteer: "control",
    subagentCancel: "control", exportHtml: "control",
    setModel: "manage", setThinking: "manage", compact: "manage", goalStart: "manage",
    goalOp: "manage", openProject: "manage", newTab: "manage", resumeSession: "manage",
    closeTab: "manage", renameTab: "manage", switchProfile: "manage", branchAt: "manage",
    forkAt: "manage", gitAccept: "manage", gitReject: "manage", gitSwitchBranch: "manage",
    approvalRevoke: "manage", approvalModeProject: "manage",
  };
  const QUERIES = [
    "projects", "profiles", "savedSessions", "models", "thinkingLevels", "commands",
    "files", "toolOutput", "gitStatus", "gitFile", "gitLog", "gitBranches", "readFile",
    "prStatus", "subagentTranscript", "usage", "approvalRules", "approvalModes",
    "conversationTree",
  ];
  // What a protocol-1 desktop (no `proto` in its hello) understands.
  const LEGACY_ACTIONS = ["select", "prompt", "steer", "abort", "answer"];

  const LIMITS = {
    uploadMimes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
    maxUploadBytes: 1536 * 1024,
    maxChunkBytes: 256 * 1024,
    maxUploads: 8,
    maxPending: 16, // requests in flight per socket
    maxArgsBytes: 32 * 1024,
    maxIdLength: 64,
  };
  // The desktop answers within 15 s (`hub::ACTION_TIMEOUT`); wait a little longer
  // so its own "desktop did not answer" ack wins the race over ours.
  const REQUEST_TIMEOUT_MS = 17000;
  const UPLOAD_TIMEOUT_MS = 20000;
  const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

  function fail(code, message, extra) {
    return Object.assign(new Error(message), { code }, extra);
  }

  // Binary → base64 in slices, so a 256 KiB chunk never blows the argument limit.
  function encodeBase64(bytes) {
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x2000) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
    }
    return root.btoa(text);
  }

  const own = (table, key) => typeof key === "string" && Object.hasOwn(table, key);
  const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

  function create(options) {
    const {
      send,
      now = Date.now,
      setTimer = (fn, ms) => root.setTimeout(fn, ms),
      clearTimer = id => root.clearTimeout(id),
      encode = encodeBase64,
      timeoutMs = REQUEST_TIMEOUT_MS,
      uploadTimeoutMs = UPLOAD_TIMEOUT_MS,
    } = options;
    const listeners = new Set();
    const pending = new Map(); // reqId → { resolve, reject, timer }
    const waiters = new Map(); // uploadId → { op, resolve, reject, timer }
    const held = new Set(); // uploads begun and not yet consumed or cancelled
    let counter = 0;
    let connection = { connected: false, proto: 0, caps: [], scope: "view" };

    const snapshot = () => ({ ...connection, caps: connection.caps.slice(), legacy: connection.connected && connection.proto < 2 });
    function setConnection(next) {
      connection = { ...connection, ...next };
      const view = snapshot();
      for (const listener of [...listeners]) listener(view);
    }
    const nextId = prefix => `${prefix}${now().toString(36)}-${++counter}`;
    const legacy = () => connection.connected && connection.proto < 2;

    function hasCap(name) {
      return connection.connected && connection.proto >= 2 && connection.caps.includes(name);
    }
    // Whether the action kind is both known and allowed to this device now.
    function can(kind) {
      if (!connection.connected) return false;
      if (legacy()) return LEGACY_ACTIONS.includes(kind);
      const needed = own(ACTIONS, kind) ? ACTIONS[kind] : undefined;
      return needed !== undefined && LEVEL[connection.scope] >= LEVEL[needed];
    }
    const canQuery = name => hasCap("query") && QUERIES.includes(name);
    const canUpload = () => hasCap("upload") && can("prompt");
    const canDownload = () => hasCap("download");

    // Refusal reason for a request that can't go out, else null.
    function refusal(allowed, known) {
      if (!connection.connected) return fail("disconnected", "not connected");
      if (legacy()) return fail("unsupported", "this desktop is too old for that request");
      if (!known) return fail("unknown", "unknown request");
      if (!allowed) return fail("not-allowed", "not allowed");
      if (pending.size >= LIMITS.maxPending) return fail("busy", "busy");
      return null;
    }
    function argsProblem(args) {
      if (args === undefined) return null;
      if (!isPlainObject(args) || JSON.stringify(args).length > LIMITS.maxArgsBytes) {
        return fail("bad-request", "bad request");
      }
      return null;
    }

    function request(frame, problem) {
      if (problem) return Promise.reject(problem);
      return new Promise((resolve, reject) => {
        const timer = setTimer(() => {
          pending.delete(frame.reqId);
          reject(fail("timeout", "desktop did not answer"));
        }, timeoutMs);
        pending.set(frame.reqId, { resolve, reject, timer });
        if (send(frame) === false) {
          clearTimer(timer);
          pending.delete(frame.reqId);
          reject(fail("disconnected", "not connected"));
        }
      });
    }

    // Resolves with the ack's `data` (undefined when the desktop sent none).
    function action(kind, tabId, fields = {}) {
      const { text, askId, value, args } = fields;
      const problem = refusal(can(kind), own(ACTIONS, kind)) || argsProblem(args);
      const frame = { t: "action", reqId: nextId("p"), tabId, kind };
      if (text !== undefined) frame.text = text;
      if (askId !== undefined) frame.askId = askId;
      if (value !== undefined) frame.value = value;
      if (args !== undefined) frame.args = args;
      return request(frame, problem);
    }

    function query(q, fields = {}) {
      const { tabId, args } = fields;
      const problem = refusal(canQuery(q), QUERIES.includes(q)) || argsProblem(args);
      const frame = { t: "query", reqId: nextId("p"), q };
      if (tabId !== undefined) frame.tabId = tabId;
      if (args !== undefined) frame.args = args;
      return request(frame, problem);
    }

    function settle(msg) {
      const entry = typeof msg.reqId === "string" ? pending.get(msg.reqId) : undefined;
      if (!entry) return false;
      pending.delete(msg.reqId);
      clearTimer(entry.timer);
      if (msg.ok) entry.resolve(msg.data);
      else entry.reject(fail("remote", msg.error || "request failed"));
      return true;
    }

    function settleUpload(msg) {
      const entry = waiters.get(msg.uploadId);
      // Acks of ops nobody waits for (cancel) are consumed silently.
      if (!entry || entry.op !== msg.op) return true;
      waiters.delete(msg.uploadId);
      clearTimer(entry.timer);
      if (msg.ok) entry.resolve();
      else entry.reject(fail("upload", msg.error || "upload failed"));
      return true;
    }

    // Feed every server frame. Returns true when the frame answered one of our
    // requests (the caller then skips its own reducer for it); hello and scope
    // update the capability state and return false so the page still sees them.
    function handleFrame(msg) {
      switch (msg && msg.t) {
        case "hello":
          setConnection({
            connected: true,
            proto: Number.isInteger(msg.proto) ? msg.proto : 1,
            caps: Array.isArray(msg.caps) ? msg.caps.filter(c => typeof c === "string") : [],
            scope: own(LEVEL, msg.scope) ? msg.scope : "view",
          });
          return false;
        case "scope":
          if (own(LEVEL, msg.scope)) setConnection({ scope: msg.scope });
          return false;
        case "ack":
        case "result":
          return settle(msg);
        case "upload":
          return settleUpload(msg);
        default:
          return false;
      }
    }

    // The socket closed: nothing in flight can be answered any more.
    function disconnect() {
      for (const entry of pending.values()) {
        clearTimer(entry.timer);
        entry.reject(fail("disconnected", "connection lost"));
      }
      pending.clear();
      for (const entry of waiters.values()) {
        clearTimer(entry.timer);
        entry.reject(fail("disconnected", "connection lost"));
      }
      waiters.clear();
      held.clear(); // the desktop drops a closed device's open uploads with it
      setConnection({ connected: false, proto: 0, caps: [], scope: "view" });
    }

    function step(frame, op) {
      return new Promise((resolve, reject) => {
        const timer = setTimer(() => {
          waiters.delete(frame.uploadId);
          reject(fail("timeout", "desktop did not answer"));
        }, uploadTimeoutMs);
        waiters.set(frame.uploadId, { op, resolve, reject, timer });
        if (send(frame) === false) {
          clearTimer(timer);
          waiters.delete(frame.uploadId);
          reject(fail("disconnected", "not connected"));
        }
      });
    }

    function uploadProblem(image) {
      if (!canUpload()) return refusal(false, true);
      const bytes = image && image.bytes;
      if (!image || !ArrayBuffer.isView(bytes)) return fail("bad-request", "bad request");
      if (!LIMITS.uploadMimes.includes(image.mime)) return fail("unsupported-type", "unsupported image type");
      if (bytes.byteLength === 0) return fail("bad-request", "empty image");
      if (bytes.byteLength > LIMITS.maxUploadBytes) return fail("too-large", "image too large");
      if (held.size >= LIMITS.maxUploads) return fail("too-many", "too many uploads");
      return null;
    }

    function cancelUpload(uploadId) {
      const entry = waiters.get(uploadId);
      if (entry) {
        waiters.delete(uploadId);
        clearTimer(entry.timer);
        entry.reject(fail("cancelled", "upload cancelled"));
      }
      held.delete(uploadId);
      send({ t: "upload-cancel", uploadId });
    }

    // Sends `{mime, bytes}` in order-acked chunks. Resolves with the uploadId to
    // name in a prompt's `args.images`. The returned promise has `uploadId` and
    // `cancel()`. `onProgress({sent, total})` runs after each acked chunk.
    function uploadImage(image, onProgress) {
      const problem = uploadProblem(image);
      if (problem) return Object.assign(Promise.reject(problem), { uploadId: null, cancel: () => false });
      const bytes = new Uint8Array(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
      const uploadId = nextId("u");
      let cancelled = false, finished = false;
      held.add(uploadId);
      const run = (async () => {
        try {
          await step({ t: "upload-begin", uploadId, mime: image.mime, size: bytes.length }, "begin");
          for (let seq = 0, at = 0; at < bytes.length; seq++) {
            if (cancelled) throw fail("cancelled", "upload cancelled");
            const slice = bytes.subarray(at, at + LIMITS.maxChunkBytes);
            await step({ t: "upload-chunk", uploadId, seq, data: encode(slice) }, "chunk");
            at += slice.length;
            if (onProgress) onProgress({ sent: at, total: bytes.length });
          }
          if (cancelled) throw fail("cancelled", "upload cancelled");
          await step({ t: "upload-end", uploadId }, "end");
          finished = true;
          return uploadId;
        } catch (error) {
          // Free the desktop's slot; a dead socket has already dropped it.
          if (held.delete(uploadId) && error.code !== "disconnected") send({ t: "upload-cancel", uploadId });
          throw error;
        }
      })();
      const cancel = () => {
        if (finished) { cancelUpload(uploadId); return true; }
        if (cancelled) return false;
        cancelled = true;
        const entry = waiters.get(uploadId);
        if (entry) {
          waiters.delete(uploadId);
          clearTimer(entry.timer);
          entry.reject(fail("cancelled", "upload cancelled"));
        }
        return true;
      };
      return Object.assign(run, { uploadId, cancel });
    }

    // Forget uploads a prompt has taken (the desktop hands each over once).
    function consumeUploads(ids) {
      for (const id of ids || []) held.delete(id);
    }

    return {
      handleFrame, disconnect, action, query, uploadImage, cancelUpload, consumeUploads,
      can, canQuery, canUpload, canDownload,
      state: snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      pendingCount: () => pending.size,
      openUploads: () => held.size,
    };
  }

  // The finished file of an `exportHtml` action. Served once to the device that
  // asked for it; the Bearer header is what a plain link could not send.
  async function download(downloadId, token, fetchImpl) {
    const doFetch = fetchImpl || (root.fetch && root.fetch.bind(root));
    if (typeof downloadId !== "string" || !ID_PATTERN.test(downloadId)) throw fail("bad-request", "bad request");
    if (!token || !doFetch) throw fail("not-allowed", "not allowed");
    let response;
    try {
      response = await doFetch(`/download/${downloadId}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store", credentials: "omit",
      });
    } catch (error) {
      throw fail("network", "download failed: network error", { cause: error });
    }
    if (response.status === 403) throw fail("forbidden", "download not allowed", { status: 403 });
    if (response.status === 404) throw fail("not-found", "download expired or already taken", { status: 404 });
    if (!response.ok) throw fail("http", `download failed (${response.status})`, { status: response.status });
    return response.blob();
  }

  const proto = { create, download, encodeBase64, ACTIONS, QUERIES, LEGACY_ACTIONS, LIMITS, REQUEST_TIMEOUT_MS };
  if (typeof window !== "undefined") window.OMP_REMOTE_PROTO = proto;
  if (typeof module !== "undefined" && module.exports) module.exports = proto;
})(typeof window !== "undefined" ? window : globalThis);
