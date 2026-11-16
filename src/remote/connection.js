// Phone transport and app store: pairing token, WebSocket with backoff, the
// connection phase, protocol-2 `proto` instance, push opt-in, tab selection
// and the legacy single-frame actions. Screens never touch the socket: they
// read `state()`, react to `subscribe`, and send through `request` / `query` /
// `action` / `selectTab`. Pure decisions live in OMP_REMOTE_CLIENT and
// OMP_REMOTE_MODEL; this module only does I/O and holds the state.
// Exposes window.OMP_REMOTE_CONNECTION = { create(options) } returning:
//   state() -> { phase, connected, scope, legacy, tabs, view, activeTabId, device, host,
//                lastSeenAt, error, pushKey, push: { state, enabled, pending },
//                pair: { busy, error, justPaired }, theme }
//   subscribe(fn) -> off      fn(state) after every change
//   onFrame(fn) -> off        fn(msg, state) after each server frame was applied
//   start() · pair(code) · retryNow() · dismissPaired()
//   selectTab(tabId) -> boolean · action(kind, fields) -> reqId | null (legacy frame)
//   request(kind, tabId, fields) -> Promise      protocol-2 action; legacy desktops fall back to
//                                                their five frames, anything else rejects
//   query(q, fields) -> Promise · setPush(on) · setError(text) · transmit(frame)
(function (root) {
  const TOKEN_KEY = "omp-remote-token";
  const LEGACY_WAIT_MS = 17000;

  function create({ onTheme } = {}) {
    const C = root.OMP_REMOTE_CLIENT, M = root.OMP_REMOTE_MODEL;
    let core = { device: null, tabs: [], view: null, pending: {}, error: null, theme: null, pushKey: undefined };
    let phase = "connecting", attempt = 0, hadConnection = false, lastSeenAt = null;
    let socket = null, token = null, selected = null, reconnectTimer = null;
    // A push tap opens `/?tab=<id>`; that id is used for the first connection only.
    let pendingTab = new URLSearchParams(root.location.search).get("tab");
    const launchTab = pendingTab;
    if (pendingTab) root.history.replaceState(null, "", root.location.pathname + root.location.hash);
    let fallbackView = null, selectReqId = null;
    let helloInfo = { proto: 0, scope: "view" };
    let push = { enabled: false, pending: false };
    let pair = { busy: false, error: null, justPaired: false };
    let cache = null;
    const subscribers = new Set(), frameListeners = new Set();
    const legacyWaiters = new Map();

    const installed = () => Boolean(root.navigator.standalone) || Boolean(root.matchMedia?.("(display-mode: standalone)").matches);
    const pushSupported = () => "PushManager" in root && "serviceWorker" in root.navigator;
    const connected = () => phase === "connected";

    function transmit(frame) {
      if (!connected() || socket?.readyState !== root.WebSocket.OPEN) return false;
      socket.send(JSON.stringify(frame));
      return true;
    }
    const proto = root.OMP_REMOTE_PROTO?.create({ send: transmit }) ?? null;

    function snapshot() {
      if (cache) return cache;
      const ps = proto?.state();
      const protoVersion = ps ? ps.proto : helloInfo.proto;
      const legacy = connected() && protoVersion < 2;
      const scope = !connected() ? "view" : legacy ? "control" : (ps ? ps.scope : helloInfo.scope);
      const isPush = M.pushState({
        installed: installed(), supported: pushSupported(), key: core.pushKey,
        enabled: push.enabled, pending: push.pending,
      });
      cache = {
        ...core, phase, connected: connected(), scope, legacy, lastSeenAt, attempt, hadConnection,
        host: M.hostName(root.location.hostname ?? root.location.host), activeTabId: selected ?? core.view?.tabId ?? null,
        push: { state: isPush, enabled: push.enabled, pending: push.pending, installed: installed() },
        pair: { ...pair }, tabCount: core.tabs.length,
      };
      return cache;
    }
    function commit(next) {
      if (next) core = { ...core, ...next };
      cache = null;
      const view = snapshot();
      for (const fn of [...subscribers]) fn(view);
    }
    const setPhase = value => { phase = value; };

    // ── requests ─────────────────────────────────────────────────────────
    function action(kind, fields = {}) {
      const gated = M.gate(snapshot(), kind);
      if (!gated.ok) { commit({ error: M.lockMessage(snapshot(), gated, kind) }); return null; }
      if (!core.view || !connected()) return null;
      const frame = C.actionFor(kind, { tabId: core.view.tabId, ...fields });
      if (!transmit(frame)) return null;
      commit({ pending: { ...core.pending, [frame.reqId]: kind }, error: null });
      return frame.reqId;
    }
    function legacyRequest(kind, tabId, fields) {
      const rejectWith = (code, message) => Promise.reject(Object.assign(new Error(message), { code }));
      if (!connected()) return rejectWith("disconnected", "not connected");
      if (!M.gate({ connected: true, legacy: true, scope: "control" }, kind).ok) return rejectWith("unsupported", M.COPY.opTooOld);
      const frame = C.actionFor(kind, { tabId, ...fields });
      return new Promise((resolve, reject) => {
        const timer = root.setTimeout(() => {
          legacyWaiters.delete(frame.reqId);
          reject(Object.assign(new Error("desktop did not answer"), { code: "timeout" }));
        }, LEGACY_WAIT_MS);
        legacyWaiters.set(frame.reqId, { resolve, reject, timer });
        if (!transmit(frame)) {
          root.clearTimeout(timer); legacyWaiters.delete(frame.reqId);
          reject(Object.assign(new Error("not connected"), { code: "disconnected" }));
        }
      });
    }
    function request(kind, tabId, fields = {}) {
      if (proto && !snapshot().legacy) return proto.action(kind, tabId, fields);
      return legacyRequest(kind, tabId, fields);
    }
    function query(q, fields = {}) {
      if (!proto || snapshot().legacy) return Promise.reject(Object.assign(new Error(M.COPY.opTooOld), { code: "unsupported" }));
      return proto.query(q, fields);
    }
    function settleLegacy(msg) {
      const entry = legacyWaiters.get(msg.reqId);
      if (!entry) return;
      legacyWaiters.delete(msg.reqId);
      root.clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.data); else entry.reject(Object.assign(new Error(msg.error || "request failed"), { code: "remote" }));
    }

    function selectTab(tabId) {
      const frame = C.selectFor(tabId);
      if (!transmit(frame)) return false;
      selected = tabId;
      selectReqId = frame.reqId;
      // The same tab keeps its view: no new view frame is coming for it.
      if (tabId !== core.view?.tabId) {
        if (core.view) fallbackView = core.view;
        commit({ view: null });
      } else commit();
      return true;
    }

    // ── socket ───────────────────────────────────────────────────────────
    function onMessage(event) {
      try {
        const msg = JSON.parse(event.data);
        lastSeenAt = Date.now();
        core = proto ? C.applyFrame(core, msg, proto) : C.reduce(core, msg);
        if (msg.t === "ack") settleLegacy(msg);
        if (msg.t === "hello") {
          setPhase("connected"); attempt = 0; hadConnection = true;
          helloInfo = { proto: Number.isInteger(msg.proto) ? msg.proto : 1, scope: M.SCOPES[msg.scope] ? msg.scope : "view" };
          const wanted = pendingTab ?? selected;
          pendingTab = null;
          if (wanted) transmit(C.selectFor(wanted));
          detectPush();
        }
        if (msg.t === "tabs") {
          // The desktop sends the folder name only; never show more than that.
          core = { ...core, tabsLoaded: true, tabs: core.tabs.map(tab => ({ ...tab, project: C.projectName(tab.project) })) };
          if (core.view && !core.tabs.some(tab => tab.id === core.view.tabId)) { core = { ...core, view: null }; selected = null; }
          if (fallbackView && !core.tabs.some(tab => tab.id === fallbackView.tabId)) fallbackView = null;
        }
        if (msg.t === "view") { fallbackView = null; selectReqId = null; selected = core.view?.tabId ?? null; }
        if (msg.t === "theme") onTheme?.(core.theme);
        if (msg.t === "ack") {
          if (msg.reqId && msg.reqId === selectReqId) {
            selectReqId = null;
            if (!msg.ok && !core.view && fallbackView && core.tabs.some(tab => tab.id === fallbackView.tabId)) {
              core = { ...core, view: fallbackView };
              selected = fallbackView.tabId;
              fallbackView = null;
            }
          }
          if (msg.kind === "push") {
            push = { pending: false, enabled: msg.ok ? true : push.enabled };
          }
        }
        commit();
        for (const fn of [...frameListeners]) fn(msg, snapshot());
      } catch (err) {
        commit({ error: err.message });
      }
    }

    function onClose(event) {
      const code = event.code;
      const previous = attempt;
      proto?.disconnect();
      for (const [, entry] of legacyWaiters) { root.clearTimeout(entry.timer); entry.reject(Object.assign(new Error("connection lost"), { code: "disconnected" })); }
      legacyWaiters.clear();
      selectReqId = null;
      push = { ...push, pending: false };
      const next = M.phaseAfterClose({ code, attempt: previous, hadConnection });
      if (code === 4401) {
        token = null;
        push = { enabled: false, pending: false };
        root.localStorage.removeItem(TOKEN_KEY);
        pair = { ...pair, error: "revoked" };
      }
      setPhase(next);
      commit({ device: null, pending: {} });
      // The reconnect timer is scheduled last: nothing may start a timer after it.
      if (code !== 4401) reconnectTimer = root.setTimeout(() => { reconnectTimer = null; connect(); }, C.backoff(attempt++));
    }

    function connect() {
      if (!token) return;
      if (phase !== "reconnecting" && phase !== "offline") setPhase("connecting");
      commit();
      socket = new root.WebSocket(`wss://${root.location.host}/ws`);
      socket.onopen = () => socket.send(JSON.stringify({ t: "auth", token }));
      socket.onmessage = onMessage;
      socket.onclose = onClose;
      socket.onerror = () => {};
    }
    // The banner's Retry (and coming back to the foreground): skip the backoff.
    function retryNow() {
      if (!token || connected()) return;
      if (reconnectTimer) { root.clearTimeout(reconnectTimer); reconnectTimer = null; }
      connect();
    }
    root.document.addEventListener("visibilitychange", () => {
      if (!root.document.hidden && (phase === "reconnecting" || phase === "offline")) retryNow();
    });

    // ── pairing ──────────────────────────────────────────────────────────
    async function pairWith(code) {
      if (!token) setPhase("unpaired");
      pair = { busy: true, error: null, justPaired: false };
      commit();
      try {
        const response = await root.fetch("/pair", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, name: root.navigator.userAgent.slice(0, 120) }) });
        if (!response.ok) {
          pair = { busy: false, error: M.pairFailureKind(response.status), justPaired: false };
          commit();
          return false;
        }
        const paired = await response.json();
        token = paired.token;
        root.localStorage.setItem(TOKEN_KEY, token);
        pair = { busy: false, error: null, justPaired: true };
        connect();
        return true;
      } catch {
        pair = { busy: false, error: M.pairFailureKind(0), justPaired: false };
        commit();
        return false;
      }
    }
    const setPairError = kind => { pair = { ...pair, error: kind }; commit(); };
    const dismissPaired = () => { pair = { ...pair, justPaired: false }; commit(); };

    async function start() {
      try {
        const code = new URLSearchParams(root.location.hash.slice(1)).get("pair");
        if (code) {
          const paired = await pairWith(code);
          root.history.replaceState(null, "", root.location.pathname);
          // An expired or used code must not hide a token this phone already has.
          if (paired) return;
        }
        token = root.localStorage.getItem(TOKEN_KEY);
        if (token) { pair = { ...pair, error: null }; connect(); }
        else { setPhase("unpaired"); commit(); }
      } catch (err) {
        setPhase("offline");
        commit({ error: err.message });
      }
    }

    // ── notifications ────────────────────────────────────────────────────
    // An existing subscription (an earlier opt-in) shows as on; never registers a worker.
    async function detectPush() {
      try {
        if (!pushSupported() || !installed() || push.enabled) return;
        const registration = await root.navigator.serviceWorker.getRegistration?.();
        const sub = registration && await registration.pushManager.getSubscription();
        if (sub && root.Notification?.permission === "granted") { push = { ...push, enabled: true }; commit(); }
      } catch { /* detection only; the switch stays off */ }
    }
    async function setPush(on) {
      if (!connected()) return;
      if (!on) {
        try {
          const registration = await root.navigator.serviceWorker.getRegistration?.();
          await (await registration?.pushManager.getSubscription())?.unsubscribe();
        } catch { /* the desktop forgets the endpoint below either way */ }
        transmit({ t: "push-unsubscribe" });
        push = { enabled: false, pending: false };
        commit();
        return;
      }
      if (!core.pushKey) return;
      push = { ...push, pending: true };
      commit();
      try {
        const permission = await root.Notification.requestPermission();
        if (permission !== "granted") throw new Error("Notification permission was not granted");
        const registration = await root.navigator.serviceWorker.register("/sw.js");
        // Wait for activation before pushManager.subscribe on a first visit.
        const ready = await root.navigator.serviceWorker.ready;
        const key = core.pushKey.replace(/-/g, "+").replace(/_/g, "/");
        const applicationServerKey = Uint8Array.from(root.atob(key), char => char.charCodeAt(0));
        const sub = await registration.pushManager.getSubscription()
          || await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        if (!transmit({ t: "push-subscribe", sub: sub.toJSON() })) throw new Error("Connection lost; enable notifications again after reconnecting");
      } catch (err) { push = { ...push, pending: false }; commit({ error: err.message }); return; }
      commit();
    }

    return {
      state: snapshot, start, pair: pairWith, retryNow, dismissPaired, setPairError, selectTab, action, request, query, setPush, launchTab,
      setError: text => commit({ error: text }), transmit, proto,
      subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
      onFrame(fn) { frameListeners.add(fn); return () => frameListeners.delete(fn); },
      installed,
    };
  }

  root.OMP_REMOTE_CONNECTION = { create };
})(typeof window !== "undefined" ? window : globalThis);
