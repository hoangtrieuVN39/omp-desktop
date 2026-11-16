#!/usr/bin/env node
// Phone protocol-2 client layer (src/remote/protocol.js): request correlation,
// timeout, disconnect, scope gating, upload chunking, download errors, and a
// drift guard against the Rust scope/limit tables. No socket: send, clock and
// timers are injected.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const P = createRequire(import.meta.url)(root + "src/remote/protocol.js");
const C = createRequire(import.meta.url)(root + "src/remote/client.js");
let passed = 0;
async function check(label, fn) {
  try { await fn(); } catch (err) { console.error(`FAILED: ${label}`); throw err; }
  passed++;
}

// A protocol over a recording transport and a manual clock.
function harness(options = {}) {
  let time = 1_000_000;
  let timerId = 0;
  const timers = new Map();
  const sent = [];
  const h = {
    sent, timers,
    advance(ms) {
      time += ms;
      for (const [id, t] of [...timers]) if (t.at <= time && timers.delete(id)) t.fn();
    },
    proto: P.create({
      send: options.send ?? (frame => { sent.push(frame); return true; }),
      now: () => time,
      setTimer: (fn, ms) => { timers.set(++timerId, { fn, at: time + ms }); return timerId; },
      clearTimer: id => timers.delete(id),
      encode: options.encode,
    }),
    hello(extra = {}) {
      h.proto.handleFrame({ t: "hello", deviceId: "d", name: "Phone", proto: 2, caps: ["query", "scope", "upload", "download"], scope: "manage", ...extra });
    },
    last: () => sent[sent.length - 1],
  };
  return h;
}
const settled = p => { const out = { state: "pending" }; p.then(v => { out.state = "ok"; out.value = v; }, e => { out.state = "err"; out.error = e; }); return out; };
const tick = () => new Promise(r => setImmediate(r));
const bytes = n => Uint8Array.from({ length: n }, (_, i) => i % 251);

// ---- correlation -----------------------------------------------------------
await check("action frame carries only given fields and resolves from its ack's data", async () => {
  const h = harness(); h.hello();
  const out = settled(h.proto.action("prompt", "tab1", { text: "hi", args: { images: ["u1"] } }));
  const frame = h.last();
  assert.deepEqual({ ...frame, reqId: "x" }, { t: "action", reqId: "x", tabId: "tab1", kind: "prompt", text: "hi", args: { images: ["u1"] } });
  assert.equal(h.proto.pendingCount(), 1);
  assert.equal(h.proto.handleFrame({ t: "ack", reqId: frame.reqId, ok: true, data: { n: 1 } }), true);
  await tick();
  assert.deepEqual(out.value, { n: 1 });
  assert.equal(h.proto.pendingCount(), 0);
  assert.equal(h.timers.size, 0, "timer cleared on answer");
});
await check("answer fields askId/value are sent, undefined ones are not", () => {
  const h = harness(); h.hello();
  h.proto.action("answer", "t", { askId: "a1", value: false }).catch(() => {});
  const f = h.last();
  assert.equal(f.askId, "a1");
  assert.equal(f.value, false);
  assert.equal("text" in f, false);
  assert.equal("args" in f, false);
});
await check("query frame omits absent tabId/args and resolves from result", async () => {
  const h = harness(); h.hello();
  const out = settled(h.proto.query("models", { tabId: "t" }));
  assert.deepEqual({ ...h.last(), reqId: "x" }, { t: "query", reqId: "x", q: "models", tabId: "t" });
  settled(h.proto.query("projects"));
  assert.deepEqual({ ...h.last(), reqId: "x" }, { t: "query", reqId: "x", q: "projects" });
  h.proto.handleFrame({ t: "result", reqId: h.sent[0].reqId, ok: true, data: [1, 2] });
  await tick();
  assert.deepEqual(out.value, [1, 2]);
});
await check("reqIds are unique, short enough for the server and answers settle the right request", async () => {
  const h = harness(); h.hello();
  const a = settled(h.proto.action("abort", "t"));
  const b = settled(h.proto.action("abort", "t"));
  const [fa, fb] = h.sent;
  assert.notEqual(fa.reqId, fb.reqId);
  assert.ok(fa.reqId.length <= 64 && /^[\w-]+$/.test(fa.reqId));
  h.proto.handleFrame({ t: "ack", reqId: fb.reqId, ok: false, error: "question no longer open" });
  await tick();
  assert.equal(a.state, "pending");
  assert.equal(b.state, "err");
  assert.equal(b.error.message, "question no longer open");
  assert.equal(b.error.code, "remote");
});
await check("unknown, null and push acks are not consumed so the page reducer still sees them", () => {
  const h = harness(); h.hello();
  assert.equal(h.proto.handleFrame({ t: "ack", reqId: "nope", ok: true }), false);
  assert.equal(h.proto.handleFrame({ t: "ack", reqId: null, kind: "push", ok: true }), false);
  assert.equal(h.proto.handleFrame({ t: "tabs", tabs: [] }), false);
  assert.equal(h.proto.handleFrame({ t: "result", ok: true }), false);
});
await check("applyFrame skips the reducer for answered requests, feeds it the rest", () => {
  const h = harness(); h.hello();
  settled(h.proto.action("abort", "t"));
  const state = { device: null, tabs: [], view: null, pending: { [h.last().reqId]: "abort" }, error: null };
  const same = C.applyFrame(state, { t: "ack", reqId: h.last().reqId, ok: false, error: "boom" }, h.proto);
  assert.equal(same, state, "no global error banner for a request its caller handles");
  const next = C.applyFrame(state, { t: "tabs", tabs: [{ id: "x" }] }, h.proto);
  assert.deepEqual(next.tabs, [{ id: "x" }]);
  assert.deepEqual(C.applyFrame(state, { t: "tabs", tabs: [] }, null).tabs, []);
});
await check("a request times out after 17 s, a late ack is ignored", async () => {
  const h = harness(); h.hello();
  const out = settled(h.proto.query("usage"));
  h.advance(16_999); await tick();
  assert.equal(out.state, "pending");
  h.advance(1); await tick();
  assert.equal(out.state, "err");
  assert.equal(out.error.code, "timeout");
  assert.equal(h.proto.pendingCount(), 0);
  assert.equal(h.proto.handleFrame({ t: "result", reqId: h.last().reqId, ok: true, data: 1 }), false);
});
await check("timeout is above the desktop's 15 s ack clock", () => {
  assert.ok(P.REQUEST_TIMEOUT_MS > 15_000 && P.REQUEST_TIMEOUT_MS <= 20_000);
});
await check("disconnect rejects every pending request and upload wait, then blocks new ones", async () => {
  const h = harness(); h.hello();
  const a = settled(h.proto.action("abort", "t"));
  const q = settled(h.proto.query("usage"));
  const up = settled(h.proto.uploadImage({ mime: "image/png", bytes: bytes(10) }));
  h.proto.disconnect(); await tick();
  for (const out of [a, q, up]) { assert.equal(out.state, "err"); assert.equal(out.error.code, "disconnected"); }
  assert.equal(h.proto.pendingCount(), 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.proto.state().connected, false);
  const late = settled(h.proto.action("abort", "t")); await tick();
  assert.equal(late.error.code, "disconnected");
  assert.equal(h.sent.filter(f => f.t === "upload-cancel").length, 0, "nothing to cancel on a dead socket");
});
await check("a transport that refuses the frame rejects at once and leaves nothing pending", async () => {
  const h = harness({ send: () => false }); h.hello();
  const out = settled(h.proto.action("abort", "t")); await tick();
  assert.equal(out.error.code, "disconnected");
  assert.equal(h.proto.pendingCount(), 0);
  assert.equal(h.timers.size, 0);
});
await check("at most 16 requests are in flight", async () => {
  const h = harness(); h.hello();
  for (let i = 0; i < 16; i++) settled(h.proto.query("usage"));
  const out = settled(h.proto.query("usage")); await tick();
  assert.equal(out.error.code, "busy");
  assert.equal(h.sent.length, 16);
});
await check("args must be an object within 32 KiB", async () => {
  const h = harness(); h.hello();
  for (const args of ["x", [1], null, { big: "a".repeat(40_000) }]) {
    const out = settled(h.proto.action("prompt", "t", { text: "x", args })); await tick();
    assert.equal(out.error.code, "bad-request", JSON.stringify(args).slice(0, 20));
  }
  assert.equal(h.sent.length, 0);
});

// ---- scope and capabilities --------------------------------------------------
await check("nothing is allowed before hello", async () => {
  const h = harness();
  assert.equal(h.proto.can("select"), false);
  assert.equal(h.proto.canQuery("models"), false);
  assert.equal(h.proto.canUpload(), false);
  const out = settled(h.proto.action("select", "t")); await tick();
  assert.equal(out.error.code, "disconnected");
});
await check("view scope: select and queries only; control adds prompts; manage everything", () => {
  const h = harness(); h.hello({ scope: "view" });
  assert.equal(h.proto.can("select"), true);
  assert.equal(h.proto.can("prompt"), false);
  assert.equal(h.proto.can("setModel"), false);
  assert.equal(h.proto.canQuery("gitLog"), true);
  assert.equal(h.proto.canUpload(), false);
  h.proto.handleFrame({ t: "scope", scope: "control" });
  assert.equal(h.proto.can("prompt"), true);
  assert.equal(h.proto.can("exportHtml"), true);
  assert.equal(h.proto.can("closeTab"), false);
  assert.equal(h.proto.canUpload(), true);
  h.proto.handleFrame({ t: "scope", scope: "manage" });
  for (const kind of Object.keys(P.ACTIONS)) assert.equal(h.proto.can(kind), true, kind);
});
await check("a scope frame downgrades live and notifies subscribers; junk scope is ignored", () => {
  const h = harness(); h.hello();
  const seen = [];
  const off = h.proto.subscribe(s => seen.push(s.scope));
  h.proto.handleFrame({ t: "scope", scope: "view" });
  assert.equal(h.proto.can("prompt"), false);
  h.proto.handleFrame({ t: "scope", scope: "root" });
  h.proto.handleFrame({ t: "scope", scope: "constructor" });
  assert.equal(h.proto.state().scope, "view");
  off();
  h.proto.handleFrame({ t: "scope", scope: "manage" });
  assert.deepEqual(seen, ["view"]);
});
await check("a refused request never reaches the socket", async () => {
  const h = harness(); h.hello({ scope: "view" });
  const a = settled(h.proto.action("prompt", "t", { text: "x" }));
  const b = settled(h.proto.action("nope", "t"));
  const c = settled(h.proto.query("nope"));
  const d = settled(h.proto.action("constructor", "t"));
  await tick();
  assert.equal(a.error.code, "not-allowed");
  assert.equal(a.error.message, "not allowed");
  assert.equal(b.error.message, "unknown request");
  assert.equal(c.error.message, "unknown request");
  assert.equal(d.error.message, "unknown request");
  assert.equal(h.sent.length, 0);
});
await check("hello without proto (old desktop) is legacy: only protocol-1 actions", async () => {
  const h = harness();
  h.proto.handleFrame({ t: "hello", deviceId: "d", name: "Phone" });
  assert.equal(h.proto.state().legacy, true);
  for (const kind of ["select", "prompt", "steer", "abort", "answer"]) assert.equal(h.proto.can(kind), true, kind);
  for (const kind of ["followUp", "setModel", "exportHtml"]) assert.equal(h.proto.can(kind), false, kind);
  assert.equal(h.proto.canQuery("models"), false);
  assert.equal(h.proto.canUpload(), false);
  assert.equal(h.proto.canDownload(), false);
  const q = settled(h.proto.query("models"));
  const a = settled(h.proto.action("followUp", "t", { text: "x" }));
  const u = settled(h.proto.uploadImage({ mime: "image/png", bytes: bytes(5) }));
  await tick();
  for (const out of [q, a, u]) assert.equal(out.error.code, "unsupported");
  assert.equal(h.sent.length, 0);
  // proto 1 explicitly behaves the same, and ignores a scope it never had
  h.proto.handleFrame({ t: "hello", deviceId: "d", name: "Phone", proto: 1, scope: "view" });
  assert.equal(h.proto.can("prompt"), true);
});
await check("hello caps gate queries, uploads and downloads", () => {
  const h = harness(); h.hello({ caps: ["query"] });
  assert.equal(h.proto.canQuery("usage"), true);
  assert.equal(h.proto.canUpload(), false);
  assert.equal(h.proto.canDownload(), false);
  h.hello({ caps: [], scope: "bogus" });
  assert.equal(h.proto.canQuery("usage"), false);
  assert.equal(h.proto.state().scope, "view", "unknown scope fails safe to view");
});
await check("hello and scope frames are not consumed; state is a copy", () => {
  const h = harness();
  assert.equal(h.proto.handleFrame({ t: "hello", deviceId: "d", name: "n", proto: 2, caps: ["query"], scope: "control" }), false);
  const s = h.proto.state();
  s.caps.push("upload");
  assert.deepEqual(h.proto.state().caps, ["query"]);
});

// ---- uploads -------------------------------------------------------------------
// Acks every upload frame like the desktop does; `fail(op, seq)` makes one fail.
function ackAll(h, { fail } = {}) {
  const original = h.proto;
  const replies = [];
  return frame => {
    if (!frame.t.startsWith("upload-")) return;
    const op = frame.t.slice(7);
    const bad = fail && fail(op, frame.seq);
    replies.push(() => original.handleFrame({ t: "upload", uploadId: frame.uploadId, op, ok: !bad, error: bad || null }));
    queueMicrotask(() => replies.shift()?.());
  };
}
function uploadHarness(failure) {
  let h;
  const sent = [];
  const hook = { fn: null };
  h = harness({ send: frame => { sent.push(frame); hook.fn?.(frame); return true; } });
  h.sent = sent;
  hook.fn = ackAll(h, { fail: failure });
  h.hello({ scope: "control" });
  return h;
}
const chunks = h => h.sent.filter(f => f.t === "upload-chunk");
await check("upload sends begin, ordered chunks of at most 256 KiB, end; returns the uploadId", async () => {
  const h = uploadHarness();
  const data = bytes(256 * 1024 * 2 + 5);
  const progress = [];
  const id = await h.proto.uploadImage({ mime: "image/jpeg", bytes: data }, p => progress.push(p));
  const [begin, ...rest] = h.sent;
  assert.deepEqual(begin, { t: "upload-begin", uploadId: id, mime: "image/jpeg", size: data.length });
  assert.deepEqual(rest.map(f => f.t), ["upload-chunk", "upload-chunk", "upload-chunk", "upload-end"]);
  assert.deepEqual(chunks(h).map(f => f.seq), [0, 1, 2]);
  assert.ok(chunks(h).every(f => f.uploadId === id));
  const joined = Buffer.concat(chunks(h).map(f => Buffer.from(f.data, "base64")));
  assert.equal(Buffer.compare(joined, Buffer.from(data)), 0, "reassembles byte for byte");
  assert.deepEqual(chunks(h).map(f => Buffer.from(f.data, "base64").length), [262144, 262144, 5]);
  assert.deepEqual(progress.map(p => p.sent), [262144, 524288, 524293]);
  assert.ok(id.length <= 64 && /^[\w-]+$/.test(id));
  assert.equal(h.proto.openUploads(), 1, "held until a prompt takes it");
  h.proto.consumeUploads([id]);
  assert.equal(h.proto.openUploads(), 0);
});
await check("chunk boundaries: exactly one chunk at 256 KiB, two at +1, six at the 1.5 MiB cap", async () => {
  for (const [size, expected] of [[1, 1], [P.LIMITS.maxChunkBytes, 1], [P.LIMITS.maxChunkBytes + 1, 2], [P.LIMITS.maxUploadBytes, 6]]) {
    const h = uploadHarness();
    await h.proto.uploadImage({ mime: "image/png", bytes: bytes(size) });
    assert.equal(chunks(h).length, expected, `size ${size}`);
    assert.equal(chunks(h).reduce((n, f) => n + Buffer.from(f.data, "base64").length, 0), size);
  }
});
await check("a typed-array view uploads only its own bytes", async () => {
  const h = uploadHarness();
  const big = bytes(100);
  await h.proto.uploadImage({ mime: "image/png", bytes: big.subarray(10, 20) });
  assert.equal(h.sent[0].size, 10);
  assert.deepEqual([...Buffer.from(chunks(h)[0].data, "base64")], [...big.subarray(10, 20)]);
});
await check("client-side limits: type, size, emptiness, count; nothing is sent", async () => {
  const h = uploadHarness();
  const cases = [
    [{ mime: "image/svg+xml", bytes: bytes(5) }, "unsupported-type"],
    [{ mime: "image/png", bytes: bytes(P.LIMITS.maxUploadBytes + 1) }, "too-large"],
    [{ mime: "image/png", bytes: new Uint8Array(0) }, "bad-request"],
    [{ mime: "image/png", bytes: "abc" }, "bad-request"],
    [null, "bad-request"],
  ];
  for (const [image, code] of cases) {
    const out = settled(h.proto.uploadImage(image)); await tick();
    assert.equal(out.error.code, code, code);
  }
  assert.equal(h.sent.length, 0);
  for (let i = 0; i < P.LIMITS.maxUploads; i++) await h.proto.uploadImage({ mime: "image/webp", bytes: bytes(3) });
  const ninth = settled(h.proto.uploadImage({ mime: "image/webp", bytes: bytes(3) })); await tick();
  assert.equal(ninth.error.code, "too-many");
  h.proto.cancelUpload(h.sent.find(f => f.t === "upload-begin").uploadId);
  await h.proto.uploadImage({ mime: "image/webp", bytes: bytes(3) });
});
await check("view scope cannot upload", async () => {
  const h = uploadHarness();
  h.proto.handleFrame({ t: "scope", scope: "view" });
  const out = settled(h.proto.uploadImage({ mime: "image/png", bytes: bytes(5) })); await tick();
  assert.equal(out.error.code, "not-allowed");
  assert.equal(h.sent.length, 0);
});
await check("a failed chunk ack stops the upload, reports the desktop's text and cancels", async () => {
  const h = uploadHarness((op, seq) => op === "chunk" && seq === 1 && "chunk out of order");
  const out = settled(h.proto.uploadImage({ mime: "image/png", bytes: bytes(P.LIMITS.maxChunkBytes * 3) }));
  await tick(); await tick(); await tick();
  assert.equal(out.state, "err");
  assert.equal(out.error.message, "chunk out of order");
  assert.equal(out.error.code, "upload");
  assert.deepEqual(chunks(h).map(f => f.seq), [0, 1], "no chunk after the failed one");
  assert.equal(h.sent.some(f => f.t === "upload-end"), false);
  assert.equal(h.sent.at(-1).t, "upload-cancel");
  assert.equal(h.proto.openUploads(), 0);
});
await check("a refused begin (too many on the desktop) fails before any chunk", async () => {
  const h = uploadHarness(op => op === "begin" && "too many uploads");
  const out = settled(h.proto.uploadImage({ mime: "image/png", bytes: bytes(10) }));
  await tick(); await tick();
  assert.equal(out.error.message, "too many uploads");
  assert.equal(chunks(h).length, 0);
  assert.equal(h.proto.openUploads(), 0);
});
await check("an upload ack that never comes times out", async () => {
  const h = harness(); h.hello({ scope: "control" });
  const out = settled(h.proto.uploadImage({ mime: "image/png", bytes: bytes(10) }));
  h.advance(19_999); await tick();
  assert.equal(out.state, "pending");
  h.advance(1); await tick();
  assert.equal(out.error.code, "timeout");
  assert.equal(h.sent.at(-1).t, "upload-cancel");
  assert.equal(h.proto.openUploads(), 0);
});
await check("cancel mid-upload rejects with cancelled, sends upload-cancel once, ignores the stray ack", async () => {
  const h = harness(); h.hello({ scope: "control" });
  const job = h.proto.uploadImage({ mime: "image/png", bytes: bytes(P.LIMITS.maxChunkBytes * 2) });
  const out = settled(job);
  h.proto.handleFrame({ t: "upload", uploadId: job.uploadId, op: "begin", ok: true });
  await tick();
  assert.equal(h.sent.at(-1).t, "upload-chunk");
  assert.equal(job.cancel(), true);
  await tick();
  assert.equal(out.error.code, "cancelled");
  assert.equal(h.sent.filter(f => f.t === "upload-cancel").length, 1);
  assert.equal(h.sent.filter(f => f.t === "upload-chunk").length, 1);
  assert.equal(h.proto.handleFrame({ t: "upload", uploadId: job.uploadId, op: "cancel", ok: true }), true);
  assert.equal(h.proto.handleFrame({ t: "upload", uploadId: job.uploadId, op: "chunk", ok: true }), true, "late chunk ack consumed, not applied");
  assert.equal(h.proto.openUploads(), 0);
  assert.equal(job.cancel(), false);
});
await check("cancelling a finished upload frees its desktop slot", async () => {
  const h = uploadHarness();
  const job = h.proto.uploadImage({ mime: "image/png", bytes: bytes(10) });
  const id = await job;
  assert.equal(h.proto.openUploads(), 1);
  assert.equal(job.cancel(), true);
  assert.deepEqual(h.sent.at(-1), { t: "upload-cancel", uploadId: id });
  assert.equal(h.proto.openUploads(), 0);
});
await check("two uploads in parallel keep their acks apart", async () => {
  const h = harness(); h.hello({ scope: "control" });
  const a = h.proto.uploadImage({ mime: "image/png", bytes: bytes(5) });
  const b = h.proto.uploadImage({ mime: "image/gif", bytes: bytes(5) });
  assert.notEqual(a.uploadId, b.uploadId);
  h.proto.handleFrame({ t: "upload", uploadId: b.uploadId, op: "begin", ok: false, error: "unsupported image type" });
  h.proto.handleFrame({ t: "upload", uploadId: a.uploadId, op: "begin", ok: true });
  const sa = settled(a), sb = settled(b); await tick();
  assert.equal(sb.error.message, "unsupported image type");
  assert.equal(sa.state, "pending");
  assert.equal(h.sent.filter(f => f.t === "upload-chunk").length, 1);
  assert.equal(h.sent.find(f => f.t === "upload-chunk").uploadId, a.uploadId);
});

// ---- download ------------------------------------------------------------------
const response = (status, body = "x") => ({ status, ok: status >= 200 && status < 300, blob: async () => ({ blob: body }) });
await check("download fetches /download/<id> with the Bearer header and returns the blob", async () => {
  const calls = [];
  const blob = await P.download("abc-123_X", "tok", async (url, init) => { calls.push([url, init]); return response(200, "html"); });
  assert.deepEqual(blob, { blob: "html" });
  assert.equal(calls[0][0], "/download/abc-123_X");
  assert.equal(calls[0][1].headers.Authorization, "Bearer tok");
  assert.equal(calls[0][1].credentials, "omit");
});
await check("download maps 403, 404, other statuses and network failures", async () => {
  const run = status => P.download("id1", "tok", async () => response(status));
  await assert.rejects(run(403), e => e.code === "forbidden" && e.status === 403);
  await assert.rejects(run(404), e => e.code === "not-found" && /expired or already taken/.test(e.message));
  await assert.rejects(run(500), e => e.code === "http" && e.message === "download failed (500)");
  await assert.rejects(P.download("id1", "tok", async () => { throw new TypeError("offline"); }), e => e.code === "network" && e.cause instanceof TypeError);
});
await check("download refuses ids that could escape the path and a missing token without fetching", async () => {
  let fetched = 0;
  const f = async () => { fetched++; return response(200); };
  for (const id of ["", "../x", "a/b", "a?b", "a b", "x".repeat(65), undefined])
    await assert.rejects(P.download(id, "tok", f), e => e.code === "bad-request", String(id));
  await assert.rejects(P.download("id1", "", f), e => e.code === "not-allowed");
  assert.equal(fetched, 0);
});

// ---- drift guard against Rust -------------------------------------------------------
const rust = path => readFileSync(root + "src-tauri/src/remote/" + path, "utf8");
await check("ACTIONS and QUERIES match scope.rs exactly", () => {
  const scope = rust("scope.rs");
  const actions = scope.match(/pub const ACTIONS[^=]*=\s*&\[([\s\S]*?)\n\];/)[1];
  const rustActions = Object.fromEntries([...actions.matchAll(/\("(\w+)",\s*Scope::(\w+)\)/g)].map(m => [m[1], m[2].toLowerCase()]));
  assert.ok(Object.keys(rustActions).length > 20);
  assert.deepEqual(P.ACTIONS, rustActions);
  const queries = scope.match(/pub const QUERIES[^=]*=\s*&\[([\s\S]*?)\];/)[1];
  assert.deepEqual(P.QUERIES, [...queries.matchAll(/"(\w+)"/g)].map(m => m[1]));
});
await check("upload limits and mime list match transfers.rs", () => {
  const t = rust("transfers.rs");
  assert.equal(P.LIMITS.maxUploadBytes, 1536 * 1024);
  assert.match(t, /MAX_UPLOAD_BYTES: usize = 1536 \* 1024;/);
  assert.match(t, /MAX_CHUNK_BYTES: usize = 256 \* 1024;/);
  assert.match(t, /MAX_UPLOADS_PER_DEVICE: usize = 8;/);
  assert.equal(P.LIMITS.maxChunkBytes, 256 * 1024);
  assert.equal(P.LIMITS.maxUploads, 8);
  const mimes = [...t.match(/UPLOAD_MIME: \[&str; \d\] = \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(P.LIMITS.uploadMimes, mimes);
});
await check("legacy actions are the protocol-1 set the page already knows", () => {
  const known = ["select", "prompt", "steer", "abort", "answer"];
  assert.deepEqual(P.LEGACY_ACTIONS, known);
  for (const kind of known) assert.ok(kind in P.ACTIONS);
});
await check("base64 encoder handles a payload above one slice and empty input", () => {
  const data = bytes(70_000);
  assert.equal(P.encodeBase64(data), Buffer.from(data).toString("base64"));
  assert.equal(P.encodeBase64(new Uint8Array(0)), "");
});

console.log(`remote protocol: ${passed} checks passed`);
