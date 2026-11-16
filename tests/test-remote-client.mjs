#!/usr/bin/env node
// Phone protocol, markdown safety, browser wiring, and notification routing.
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const load = path => readFileSync(root + path, "utf8");
let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); passed++; } catch (err) { failed++; console.error(`FAILED: ${label}\n  ${String(err?.stack ?? err).split("\n").slice(0, 4).join("\n  ")}`); }
}
const C = createRequire(import.meta.url)(root + "src/remote/client.js");
const initial = () => ({ device: null, tabs: [], view: null, pending: {}, error: null });
await check("reduce applies hello and tabs without mutating previous state", () => {
  const before = initial();
  const hello = C.reduce(before, { t: "hello", deviceId: "d", name: "Phone" });
  assert.deepEqual(hello.device, { id: "d", name: "Phone" });
  const tabs = [{ id: "t", title: "Work", project: "/project", busy: true, hasAsk: true }];
  assert.deepEqual(C.reduce(hello, { t: "tabs", tabs }).tabs, tabs);
  assert.deepEqual(before, initial());
});
await check("reduce replaces view wholesale, including empty messages and asks", () => {
  const inner = { tabId: "t", busy: false, messages: [], asks: [] };
  const next = C.reduce({ ...initial(), view: { obsolete: true, asks: [{ id: "old" }] } }, { t: "view", view: inner });
  assert.deepEqual(next.view, inner);
  assert.equal(C.reduce(next, { t: "view", view: null }).view, null);
});
await check("reduce clears only acknowledged pending request and preserves failed ack text", () => {
  const before = { ...initial(), pending: { a: "prompt", b: "answer" } };
  const failed = C.reduce(before, { t: "ack", reqId: "a", ok: false, error: "question no longer open" });
  assert.deepEqual(failed.pending, { b: "answer" });
  assert.equal(failed.error, "question no longer open");
  assert.deepEqual(before.pending, { a: "prompt", b: "answer" });
  assert.deepEqual(C.reduce(failed, { t: "ack", reqId: "b", ok: true }).pending, {});
});
await check("reduce stores push-key and ignores unknown messages", () => {
  const state = C.reduce(initial(), { t: "push-key", key: "abc" });
  assert.equal(state.pushKey, "abc");
  assert.equal(C.reduce(state, { t: "unknown" }), state);
});
await check("reduce stores the theme sent from the desktop", () => {
  const theme = { id: "phosphor", tone: "dark", accent: "#C4FF3F" };
  const state = C.reduce(initial(), { t: "theme", theme });
  assert.deepEqual(state.theme, theme);
});
await check("actionFor builds answer, prompt and abort frames with unique request ids", () => {
  const answer = C.actionFor("answer", { tabId: "t", askId: "q", value: true });
  assert.equal(typeof answer.reqId, "string");
  const { reqId, ...frame } = answer;
  assert.deepEqual(frame, { t: "action", tabId: "t", kind: "answer", askId: "q", value: true });
  const prompt = C.actionFor("prompt", { tabId: "t", text: "Hi" });
  assert.equal(prompt.text, "Hi");
  assert.notEqual(prompt.reqId, reqId);
  const abort = C.actionFor("abort", { tabId: "t" });
  assert.deepEqual(Object.keys(abort).sort(), ["kind", "reqId", "t", "tabId"]);
});
await check("askControls supports select, confirm, input and editor", () => {
  assert.deepEqual(C.askControls({ kind: "select", options: ["One", { label: "Two", value: "two" }] }),
    [{ label: "One", value: "One" }, { label: "Two", value: "two" }]);
  assert.deepEqual(C.askControls({ kind: "confirm" }), [{ label: "Confirm", value: true }, { label: "Deny", value: false }]);
  assert.deepEqual(C.askControls({ kind: "input" }), { input: true, multiline: false });
  assert.deepEqual(C.askControls({ kind: "editor" }), { input: true, multiline: true });
});
await check("backoff starts at one second and caps at thirty seconds", () => {
  assert.equal(C.backoff(0), 1000);
  assert.equal(C.backoff(1), 2000);
  assert.equal(C.backoff(10), 30000);
});
await check("pairCodeFromScan accepts only this origin with a #pair= fragment", () => {
  const origin = "https://phone.test:7470";
  assert.equal(C.pairCodeFromScan(`${origin}/#pair=abc`, origin).code, "abc");
  assert.equal(C.pairCodeFromScan(`${origin}/path#pair=xyz-123`, origin).code, "xyz-123");
  assert.equal(C.pairCodeFromScan("https://other.test/#pair=abc", origin).other, true);
  assert.equal(C.pairCodeFromScan("not a url", origin), null);
  assert.equal(C.pairCodeFromScan(`${origin}/#other=abc`, origin), null);
  assert.equal(C.pairCodeFromScan(`${origin}/`, origin), null);
});

// Reuse tests/test-markdown.mjs's real-library DOM-stub harness. A textarea
// decodes references without parsing user HTML into live DOM elements.
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', colon: ":", Tab: "\t", NewLine: "\n" };
const document = {
  createElement: () => {
    let value = "";
    return {
      set innerHTML(ref) {
        const m = /^&(?:#(\d+)|#[xX]([\da-fA-F]+)|([A-Za-z][A-Za-z\d]*));$/.exec(ref);
        value = !m ? ref : m[1] ? String.fromCodePoint(+m[1])
          : m[2] ? String.fromCodePoint(parseInt(m[2], 16)) : NAMED[m[3]] ?? ref;
      },
      get value() { return value; },
    };
  },
};
const markdown = vm.createContext({ document, console, URL });
markdown.window = markdown;
for (const f of ["marked.min.js", "highlight.min.js", "app/marked-setup.js"])
  vm.runInContext(load("src/" + f), markdown, { filename: f });
// VM top-level `var hljs` cannot be deleted from its contextified global.
// Expose the configured libraries through an ordinary window object so
// deleting window.hljs actually exercises the client's missing-library guard.
markdown.window = { marked: markdown.marked, hljs: markdown.hljs, OMP_MARKDOWN: markdown.OMP_MARKDOWN };
vm.runInContext(load("src/remote/client.js"), markdown);
const phone = markdown.window.OMP_REMOTE_CLIENT;
await check("phone page escapes raw HTML and neutralises javascript links", () => {
  const html = phone.renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1))');
  assert.ok(html.includes("&lt;img"), html);
  assert.doesNotMatch(html, /href="javascript:/i);
  for (const text of ["x <code> <img/src=x onerror=alert(1)>", "[x](&#106;avascript:alert(1))"])
    assert.doesNotMatch(phone.renderMarkdown(text), /<img|href="javascript:/i);
  delete markdown.window.hljs;
  assert.throws(() => phone.renderMarkdown("hello"), /highlight|hljs/i);
});
await check("phone HTML forbids inline scripts, handlers and styles and keeps PWA meta tags", () => {
  const html = load("src/remote/index.html");
  assert.doesNotMatch(html, /<script\b(?![^>]*\ssrc=)[^>]*>|<[a-z][^>]*\son[a-z]+\s*=|<style\b|\sstyle\s*=/i);
  assert.match(html, /<link rel="manifest" href="\/manifest.json">/);
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /<meta charset="utf-8">/);
});

// Browser APIs are unavailable in Node. Keep real phone modules;
// fake only DOM, network, storage and service-worker boundaries.
let focused = null;
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.listeners = {}; this.value = ""; this.disabled = false;
    this.hidden = false; this._text = "";
    this.style = { removeProperty() {}, setProperty() {} };
    const classes = new Set();
    this.classList = {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      toggle: (c, force) => { if (force) classes.add(c); else classes.delete(c); },
      contains: c => classes.has(c),
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  set innerHTML(value) { this.markup = value; }
  get firstElementChild() { return this.children[0]; }
  pause() {}
  async play() {}
  srcObject = null;
  append(...nodes) { for (const n of nodes) n.parent = this; this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ""; for (const n of nodes) n.parent = this; this.children = nodes; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  removeAttribute(name) { delete this[name]; }
  getAttribute(name) { return this[name]; }
  hasAttribute(name) { return this[name] !== undefined; }
  setAttribute(name, value) { assert.notEqual(name, "style"); this[name] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  async emit(name) { return this.listeners[name]?.({ preventDefault() {}, target: this }); }
  focus() { focused = this; }
  // Just enough selector support (tag, .class, [attr], [attr="v"], comma lists) for the phone modules.
  matches(selector) {
    return selector.split(",").some(part => {
      const sel = part.trim();
      const tag = /^[a-z][a-z0-9]*/i.exec(sel)?.[0];
      if (tag && this.tagName !== tag) return false;
      for (const m of sel.matchAll(/\.([\w-]+)/g)) if (!String(this.className ?? "").split(/\s+/).includes(m[1])) return false;
      for (const m of sel.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
        if (this[m[1]] === undefined) return false;
        if (m[2] !== undefined && String(this[m[1]]) !== m[2]) return false;
      }
      return true;
    });
  }
  querySelectorAll(selector) { return descendants(this).slice(1).filter(n => n.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest() { return null; }
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const ackLast = async b => { const f = b.frames.filter(x => x.t === "action").at(-1); await b.message({ t: "ack", reqId: f.reqId, ok: true }); await flush(); };
function browser({ pair = false, token = "saved-token", standalone = true, pairStatus = 200 } = {}) {
  const app = new Element("main");
  const windowHandlers = {}, docHandlers = {};
  const frames = [], sockets = [], timers = [], requests = [], registrations = [];
  const storage = new Map(token ? [["omp-remote-token", token]] : []);
  const location = { protocol: "https:", host: "phone.test:7470", pathname: "/", search: "?tab=t", hash: pair ? "#pair=code" : "" };
  const registration = { pushManager: {
    async getSubscription() { return null; },
    async subscribe(options) { assert.equal(options.userVisibleOnly, true); assert.ok(options.applicationServerKey.length); return { toJSON: () => ({ endpoint: "https://push.test", keys: { auth: "a", p256dh: "p" } }) }; },
  } };
  const navigator = { userAgent: "Test Phone", standalone, serviceWorker: {
    async register(path) { registrations.push(path); return registration; },
    ready: Promise.resolve(registration),
  } };
  class WebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); }
    send(raw) { frames.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
  }
  const resizers = [];
  class ResizeObserver { constructor(fn) { resizers.push(fn); } observe() {} }
  const ctx = vm.createContext({ console, URL, URLSearchParams, Uint8Array, atob, navigator, location, WebSocket, ResizeObserver,
    PushManager: class {}, Notification: { requestPermission: async () => "granted" },
    matchMedia: () => ({ matches: standalone }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    document: {
      hidden: false, addEventListener(name, fn) { (docHandlers[name] ??= []).push(fn); },
      get activeElement() { return focused; },
      createElement: tag => new Element(tag),
      createElementNS: (_ns, tag) => new Element(tag),
      getElementById: id => id === "app" ? app : null,
      documentElement: Object.assign(new Element("html"), { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 }),
    },
    addEventListener(name, fn) { (windowHandlers[name] ??= []).push(fn); },
    history: { replaceState(_state, _title, url) { const next = new URL(url, "https://phone.test:7470/"); location.search = next.search; location.hash = next.hash; requests.push(["history", url]); } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async (url, options) => { requests.push([url, JSON.parse(options.body)]); return { ok: pairStatus === 200, status: pairStatus, json: async () => ({ token: "paired-token", deviceId: "d" }) }; },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
  });
  ctx.window = ctx;
  vm.runInContext(load("src/app/accent.js"), ctx);
  vm.runInContext(load("src/app/scroll-pin.js"), ctx);
  vm.runInContext(load("src/remote/client.js"), ctx);
  // Markdown safety itself uses the actual vendored libraries above.
  ctx.OMP_REMOTE_CLIENT.renderMarkdown = text => "SAFE:" + text;
  // Load the phone modules in the order index.html does, so the page and this test cannot drift.
  const indexHtml = fs.readFileSync(new URL("../src/remote/index.html", import.meta.url), "utf8");
  const skip = new Set(["marked.min.js", "highlight.min.js", "marked-setup.js", "accent.js", "scroll-pin.js", "jsQR.js", "client.js"]);
  for (const [, f] of indexHtml.matchAll(/<script src="\/([^"]+)"/g)) {
    if (skip.has(f)) continue;
    const path = fs.existsSync(new URL("../src/remote/" + f, import.meta.url)) ? "src/remote/" + f : "src/app/" + f;
    vm.runInContext(load(path), ctx, { filename: f });
  }
  const nodes = () => descendants(app);
  const button = text => nodes().find(n => n.tagName === "button" && n.textContent === text);
  const message = async data => { sockets.at(-1).onmessage({ data: JSON.stringify(data) }); await flush(); };
  const connect = async () => { await flush(); sockets.at(-1).onopen(); await message({ t: "hello", deviceId: "d", name: "Phone" }); };
  const scrollBox = nodes().find(n => n.className === "r-chat-scroll");
  Object.assign(scrollBox, { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 });
  const key = (name, extra = {}) => { for (const fn of docHandlers.keydown || []) fn({ key: name, preventDefault() {}, ...extra }); };
  const tab = id => nodes().find(n => n.tagName === "button" && n["data-tab-id"] === id && /r-tab-row/.test(n.className));
  const control = label => nodes().find(n => n.tagName === "button" && n["aria-label"] === label);
  const resize = () => { for (const fn of resizers) fn(); };
  return { app, nodes, button, tab, control, resize, message, connect, sockets, frames, storage, timers, requests, registrations, ctx, windowHandlers, scrollBox, docHandlers, key };
}
const view = (busy = false) => ({ t: "view", view: { tabId: "t", busy, messages: [
  { id: "u", role: "user", text: "<img user>" },
  { id: "a", role: "assistant", text: "**reply**" },
  { id: "x", role: "tool", tool: { name: "read", summary: "<tool>", output: "<output>" } },
  { id: "h", role: "thinking", text: "secret thinking" },
], asks: [{ id: "q", kind: "confirm", title: "<Question>", message: "Allow?" }] } });
await check("a failed #pair= code falls back to the stored token and keeps it", async () => {
  const b = browser({ pair: true, token: "saved-token", pairStatus: 410 });
  await b.connect();
  assert.ok(b.requests.some(r => r[0] === "/pair"), "the code was tried");
  assert.equal(b.storage.get("omp-remote-token"), "saved-token");
  assert.equal(b.ctx.location.hash, "", "the spent code leaves the URL");
  assert.deepEqual(b.frames[0], { t: "auth", token: "saved-token" });
});
await check("a failed #pair= code without a stored token stays unpaired", async () => {
  const b = browser({ pair: true, token: null, pairStatus: 410 });
  await b.connect().catch(() => {});
  assert.equal(b.sockets.length, 0, "no socket without a token");
  assert.equal(b.storage.get("omp-remote-token"), undefined);
});
await check("pairing exchanges fragment, stores token, removes fragment, then authenticates first", async () => {
  const b = browser({ pair: true, token: null });
  await b.connect();
  assert.deepEqual(b.requests.find(r => r[0] === "/pair"), ["/pair", { code: "code", name: "Test Phone" }]);
  assert.equal(b.storage.get("omp-remote-token"), "paired-token");
  assert.equal(b.ctx.location.hash, "");
  assert.deepEqual(b.frames[0], { t: "auth", token: "paired-token" });
  assert.deepEqual({ ...b.frames[1], reqId: undefined }, { t: "select", tabId: "t", reqId: undefined });
  assert.ok(b.frames[1].reqId);
  assert.equal(b.sockets[0].url, "wss://phone.test:7470/ws");
});

await check("transcript and asks use text nodes; only assistant markdown receives rendered HTML", async () => {
  const b = browser(); await b.connect(); await b.message(view());
  assert.ok(b.app.textContent.includes("<img user>"));
  assert.ok(b.app.textContent.includes("<Question>"));
  assert.ok(!b.app.textContent.includes("secret thinking"), "model reasoning never reaches the phone");
  assert.deepEqual(b.nodes().filter(n => n.markup !== undefined).map(n => n.markup), ["SAFE:**reply**"]);
  await b.button("No").emit("click"); await flush();
  assert.equal(b.frames.at(-1).kind, "answer");
  assert.equal(b.frames.at(-1).value, false);
  assert.equal(b.frames.at(-1).askId, "q");
});

await check("streaming views preserve live question input nodes and answer their current text", async () => {
  const b = browser(); await b.connect();
  const inner = { ...view(true).view, asks: [{ id: "input", kind: "input", title: "Name", message: "Enter name" }] };
  await b.message({ t: "view", view: inner });
  const input = b.nodes().find(n => n.tagName === "input" && /r-ask-input/.test(n.className));
  input.value = "<typed>"; await input.emit("input");
  await b.message({ t: "view", view: { ...inner, messages: [] } });
  assert.equal(b.nodes().find(n => n.tagName === "input" && /r-ask-input/.test(n.className)), input, "a streaming update keeps the field");
  await b.button("Answer").emit("click"); await flush();
  assert.equal(b.frames.at(-1).value, "<typed>");
  await b.message({ t: "view", view: { ...inner, asks: [] } });
  assert.ok(!b.nodes().some(n => n.tagName === "input" && /r-ask-input/.test(n.className)));
});

await check("composer sends prompt, steers with a draft while busy, stops with an empty one", async () => {
  const b = browser(); await b.connect(); await b.message(view());
  const draft = b.nodes().find(n => n.tagName === "textarea");
  assert.match(draft.placeholder, /…$/); assert.equal(draft["enterkeyhint"], "send");
  assert.ok(b.control("Send").disabled, "empty idle draft disables send");
  draft.value = "hello"; await draft.emit("input"); await b.control("Send").emit("click"); await flush();
  assert.equal(b.frames.at(-1).kind, "prompt"); assert.equal(b.frames.at(-1).text, "hello");
  assert.equal(draft.value, "hello", "the draft stays until the desktop accepts it");
  await ackLast(b);
  assert.equal(draft.value, "", "an accepted draft is cleared");
  await b.message(view(true));
  assert.ok(b.control("Stop the running turn").className.includes("is-stop"), "busy and empty draft shows stop");
  draft.value = "redirect"; await draft.emit("input");
  assert.ok(b.control("Steer — insert into the running turn").className.includes("is-steer"));
  await b.control("Steer — insert into the running turn").emit("click"); await flush();
  assert.equal(b.frames.at(-1).kind, "steer"); assert.equal(b.frames.at(-1).text, "redirect");
  await ackLast(b);
  draft.value = "   "; await draft.emit("input");
  await b.control("Stop the running turn").emit("click"); await flush(); assert.equal(b.frames.at(-1).kind, "abort");
});
await check("a pinned reader follows a shrinking transcript box; an unpinned one stays", async () => {
  const b = browser(); await b.connect();
  const root = b.scrollBox;
  await b.message(view());
  root.clientHeight = 300; b.resize();
  assert.equal(root.scrollTop, 700, "pinned: jumps to the new bottom");
  root.scrollTop = 100; root.listeners.scroll();
  root.clientHeight = 200; b.resize();
  assert.equal(root.scrollTop, 100, "unpinned: not moved");
});
await check("disconnect retries with backoff; revoked token stops reconnect and disables actions", async () => {
  const b = browser(); await b.connect(); await b.message(view(true));
  b.sockets[0].onclose({ code: 1006 });
  assert.equal(b.timers.at(-1).delay, 1000);
  assert.ok(b.control("Stop the running turn").disabled);
  b.timers.at(-1).fn(); await b.connect();
  b.sockets.at(-1).onclose({ code: 4401 });
  assert.equal(b.storage.has("omp-remote-token"), false);
  assert.match(b.app.textContent, /This phone was removed/);
  assert.ok(b.button("Scan again"), "the pairing screen takes over");
  assert.equal(b.timers.length, 1);
});
await check("tab removal clears view and prevents stale actions", async () => {
  const b = browser(); await b.connect();
  await b.message({ t: "tabs", tabs: [{ id: "t", title: "Tab", project: "Project", busy: true, hasAsk: true }] });
  await b.message(view()); await b.message({ t: "tabs", tabs: [] });
  assert.ok(b.control("Send").disabled);
  assert.ok(!b.app.textContent.includes("<img user>"));
});
await check("push opt-in registers worker and sends subscription only on user gesture", async () => {
  const b = browser(); await b.connect(); await b.message({ t: "push-key", key: "AQID" });
  assert.equal(b.registrations.length, 0);
  await b.nodes().find(n => n.className === "r-link-chip").emit("click");
  const sw = () => b.nodes().find(n => n["aria-label"] === "Push notifications" && n.role === "switch");
  assert.equal(sw()["aria-checked"], "false");
  assert.equal(b.registrations.length, 0, "opening the screen never registers the worker");
  await sw().emit("click"); await flush();
  assert.deepEqual(b.registrations, ["/sw.js"]);
  assert.deepEqual(b.frames.at(-1), { t: "push-subscribe", sub: { endpoint: "https://push.test", keys: { auth: "a", p256dh: "p" } } });
  assert.equal(sw().disabled, true, "pending until ack");
  await b.message({ t: "ack", reqId: null, kind: "push", ok: false, error: "bad subscription" });
  assert.equal(sw().disabled, false, "failed ack re-enables the switch for a retry");
  assert.equal(sw()["aria-checked"], "false");
  await sw().emit("click"); await flush();
  await b.message({ t: "ack", reqId: null, kind: "push", ok: true, error: null });
  assert.equal(sw()["aria-checked"], "true", "enabled after positive ack");
  await sw().emit("click"); await flush();
  assert.deepEqual(b.frames.at(-1), { t: "push-unsubscribe" });
  assert.equal(sw()["aria-checked"], "false", "switching off unsubscribes");
  await sw().emit("click"); await flush();
  await b.message({ t: "ack", reqId: null, kind: "push", ok: true, error: null });
  b.sockets.at(-1).onclose({ code: 4401 });
  b.ctx.OMP_REMOTE_UI.setGate(null); b.ctx.OMP_REMOTE_UI.navigate("connection");
  assert.equal(sw()["aria-checked"], "false", "4401 revocation resets the notification switch");
  const tab = browser({ standalone: false }); await tab.connect(); await tab.message({ t: "push-key", key: "AQID" });
  await tab.nodes().find(n => n.className === "r-link-chip").emit("click");
  assert.ok(!tab.nodes().some(n => n.role === "switch"), "a Safari tab has no push switch");
  assert.ok(tab.app.textContent.includes("Add to Home Screen"), "it explains how to get notifications");
});
await check("service worker displays minimal payload and focuses selected tab or opens encoded URL", async () => {
  const handlers = {}, shown = [], opened = [], navigated = [];
  let windows = [], claimed = 0;
  const self = { addEventListener: (name, fn) => { handlers[name] = fn; },
    registration: { showNotification: async (...args) => shown.push(args) },
    clients: { matchAll: async () => windows, openWindow: async url => opened.push(url), claim: async () => { claimed++; } } };
  const ctx = vm.createContext({ self, URL, encodeURIComponent });
  vm.runInContext(load("src/remote/sw.js"), ctx);
  let work;
  handlers.push({ data: { json: () => ({ title: "OMP · Tab", body: "Question waiting", tag: "t", tab: "t /?" }) }, waitUntil(p) { work = p; } });
  await work;
  assert.equal(shown[0][0], "OMP · Tab");
  assert.equal(shown[0][1].data.tab, "t /?");
  const event = { notification: { data: { tab: "t /?" }, close() {} }, waitUntil(p) { work = p; } };
  handlers.notificationclick(event); await work;
  assert.deepEqual(opened, ["/?tab=t%20%2F%3F"]);
  windows = [{ navigate: async url => navigated.push(url), focus: async () => {} }];
  handlers.notificationclick(event); await work;
  assert.deepEqual(navigated, ["/?tab=t%20%2F%3F"]);
  let activated; handlers.activate({ waitUntil(p) { activated = p; } }); await activated;
  assert.equal(claimed, 1, "the worker claims open pages on activation");
  opened.length = 0;
  windows = [{ navigate: async () => { throw new Error("uncontrolled client"); }, focus: async () => {} }];
  handlers.notificationclick(event); await work;
  assert.deepEqual(opened, ["/?tab=t%20%2F%3F"], "a rejected navigate falls back to a new window");
});
await check("?tab= selects once; a later reconnect follows the current selection", async () => {
  const b = browser(); await b.connect();
  assert.deepEqual(b.requests.find(r => r[0] === "history"), ["history", "/"]);
  assert.deepEqual(b.frames.filter(f => f.t === "select").map(f => f.tabId), ["t"]);
  await b.message({ t: "view", view: { ...view().view, tabId: "other" } });
  b.sockets[0].onclose({ code: 1006 }); b.timers.at(-1).fn(); await b.connect();
  assert.deepEqual(b.frames.filter(f => f.t === "select").map(f => f.tabId), ["t", "other"]);
  const none = browser(); await none.connect();
  none.sockets[0].onclose({ code: 1006 }); none.timers.at(-1).fn(); await none.connect();
  assert.deepEqual(none.frames.filter(f => f.t === "select").map(f => f.tabId), ["t"], "a stale ?tab= is not replayed");
});

await check("opening a tab jumps to the end; new content keeps it pinned", async () => {
  const b = browser(); await b.connect();
  const root = b.scrollBox;
  await b.message(view());
  assert.equal(root.scrollTop, 500, "first render of a tab jumps to the bottom");
  root.scrollHeight = 1400;
  await b.message({ t: "view", view: { ...view().view, messages: [...view().view.messages, { id: "b", role: "assistant", text: "more" }] } });
  assert.equal(root.scrollTop, 900, "a pinned view follows new content");
  assert.equal(b.button("Newest").hidden, true);
});
await check("scrolling up keeps the position and shows Newest, which jumps back", async () => {
  const b = browser(); await b.connect();
  const root = b.scrollBox;
  await b.message(view());
  root.scrollTop = 100; root.listeners.scroll();
  assert.equal(b.button("Newest").hidden, false);
  root.scrollHeight = 1400;
  await b.message({ t: "view", view: { ...view().view, messages: [...view().view.messages, { id: "b", role: "assistant", text: "more" }] } });
  assert.equal(root.scrollTop, 100, "an unpinned reader is not moved");
  assert.equal(b.button("Newest").hidden, false);
  await b.button("Newest").emit("click");
  assert.equal(root.scrollTop, 900);
  assert.equal(b.button("Newest").hidden, true);
});
await check("switching to another tab jumps to its end even when scrolled up", async () => {
  const b = browser(); await b.connect();
  const root = b.scrollBox;
  await b.message(view());
  root.scrollTop = 100; root.listeners.scroll();
  await b.message({ t: "view", view: { ...view().view, tabId: "other" } });
  assert.equal(root.scrollTop, 500);
  assert.equal(b.button("Newest").hidden, true);
});

await check("dialog asks send one answer per question with options or custom text", async () => {
  const b = browser(); await b.connect();
  const questions = [
    { id: "a", question: "Pick one", options: [{ label: "X" }, { label: "Y" }], multi: false },
    { id: "b", question: "Pick any", options: [{ label: "P" }, { label: "Q" }], multi: true },
  ];
  await b.message({ t: "view", view: { ...view().view, asks: [{ id: "d", kind: "dialog", title: "T", message: "", questions }] } });
  await b.button("Answer 2 questions").emit("click");
  const send = () => b.nodes().find(n => n.tagName === "button" && /r-dialog-send/.test(n.className));
  assert.equal(send().disabled, true, "an unanswered pick-one question cannot be sent");
  await b.button("X").emit("click"); await b.button("P").emit("click"); await b.button("Q").emit("click");
  assert.equal(b.button("X")["aria-checked"], "true");
  assert.equal(b.button("Y")["aria-checked"], "false");
  const text = b.nodes().find(n => n.tagName === "input" && /r-dialog-custom/.test(n.className));
  text.value = " custom "; await text.emit("input");
  assert.equal(send().disabled, false);
  await send().emit("click"); await flush();
  assert.deepEqual(b.frames.at(-1).value, [
    { id: "a", selectedOptions: ["X"] },
    { id: "b", selectedOptions: ["P", "Q"], customInput: "custom" },
  ]);
});

await check("pick-any answers keep option order whatever order the buttons were pressed", async () => {
  const b = browser(); await b.connect();
  const questions = [{ id: "b", question: "Pick any", options: [{ label: "P" }, { label: "Q" }, { label: "R" }], multi: true }];
  await b.message({ t: "view", view: { ...view().view, asks: [{ id: "d", kind: "dialog", title: "T", message: "", questions }] } });
  await b.button("Answer 1 question").emit("click");
  await b.button("R").emit("click"); await b.button("P").emit("click"); await b.button("Q").emit("click");
  await b.nodes().find(n => n.tagName === "button" && /r-dialog-send/.test(n.className)).emit("click"); await flush();
  assert.deepEqual(b.frames.at(-1).value, [{ id: "b", selectedOptions: ["P", "Q", "R"] }]);
});
// Rust's build_action drops a frame without a non-empty reqId, so every
// select and action the phone builds must carry a unique one.
await check("every select and action frame carries a unique non-empty reqId", async () => {
  const b = browser(); await b.connect();
  await b.message({ t: "tabs", tabs: [{ id: "t", title: "One", project: "" }, { id: "u", title: "Two", project: "" }] });
  await b.message(view());
  await b.tab("u").emit("click");
  await b.message({ t: "view", view: { ...view().view, tabId: "u" } });
  const draft = b.nodes().find(n => n.tagName === "textarea");
  draft.value = "hello"; await draft.emit("input"); await b.control("Send").emit("click"); await flush(); await ackLast(b);
  await b.message({ t: "view", view: { ...view().view, tabId: "u", busy: true } });
  await b.control("Stop the running turn").emit("click"); await flush();
  await b.button("No").emit("click"); await flush();
  const sent = b.frames.filter(f => f.t === "select" || f.t === "action");
  assert.ok(sent.filter(f => f.t === "select").length >= 2, "connect and tab click both select");
  assert.ok(sent.some(f => f.kind === "prompt") && sent.some(f => f.kind === "answer"));
  for (const frame of sent) assert.ok(typeof frame.reqId === "string" && frame.reqId !== "", JSON.stringify(frame));
  assert.equal(new Set(sent.map(f => f.reqId)).size, sent.length, "request ids are unique");
});

await check("clicking the active tab keeps its view; another tab clears it until the new view arrives", async () => {
  const b = browser(); await b.connect();
  await b.message({ t: "tabs", tabs: [{ id: "t", title: "One", project: "" }, { id: "u", title: "Two", project: "" }] });
  await b.message(view());
  await b.tab("t").emit("click");
  assert.ok(b.app.textContent.includes("<img user>"), "the view stays");
  assert.equal(b.control("Send").disabled, true, "idle with an empty draft cannot send");
  const draft = b.nodes().find(n => n.tagName === "textarea");
  draft.value = "hi"; await draft.emit("input");
  assert.equal(b.control("Send").disabled, false, "a draft enables send");
  draft.value = ""; await draft.emit("input");
  await b.tab("u").emit("click");
  assert.ok(!b.app.textContent.includes("<img user>"));
  assert.ok(b.control("Send").disabled);
  const selectReq = b.frames.filter(f => f.t === "select").at(-1).reqId;
  await b.message({ t: "ack", reqId: selectReq, ok: false, error: "tab not available" });
  assert.ok(b.app.textContent.includes("<img user>"), "failed select ack restores the previous tab view");
  draft.value = "recover me"; await draft.emit("input"); await b.control("Send").emit("click"); await flush();
  const promptReq = b.frames.filter(f => f.t === "action").at(-1).reqId;
  assert.equal(draft.value, "recover me", "the draft stays while the desktop has not answered");
  await b.message({ t: "ack", reqId: promptReq, ok: false, error: "desktop could not deliver" }); await flush();
  assert.equal(draft.value, "recover me", "a rejected prompt keeps the draft");
});
await check("trackShown marks only unseen ids and forgets ids that left the view", () => {
  const first = C.trackShown(new Set(), [{ id: "a" }, { id: "b" }]);
  assert.deepEqual([...first.fresh], ["id:a", "id:b"]);
  const second = C.trackShown(first.shown, [{ id: "b" }, { id: "c" }]);
  assert.deepEqual([...second.fresh], ["id:c"]);
  assert.deepEqual([...second.shown], ["id:b", "id:c"]);
});
await check("repinFor follows the desktop rule: tab change and own prompts jump, echoed steers and streaming do not", () => {
  const P = (() => { const w = {}; new Function("window", load("src/app/scroll-pin.js"))(w); return w.OMP_SCROLL_PIN; })();
  const v = (tabId, messages) => ({ tabId, messages });
  const u = (id, extra = {}) => ({ id, role: "user", ...extra });
  const prev = { tabId: "t", lastId: "u1" };
  assert.equal(C.repinFor(P, prev, v("other", [u("u1")])), true);
  assert.equal(C.repinFor(P, prev, v("t", [u("u1"), { id: "a", role: "assistant" }])), false);
  assert.equal(C.repinFor(P, prev, v("t", [u("u1"), u("u2")])), true);
  assert.equal(C.repinFor(P, prev, v("t", [u("u1"), u("u2", { echo: true })])), false);
  assert.equal(C.repinFor(P, prev, v("t", [])), true);
  assert.equal(C.repinFor(P, prev, null), false);
});

await check("a streaming update replays the fade-in only on new rows", async () => {
  const b = browser();
  await b.connect();
  await b.message(view());
  const rows = () => b.nodes().find(n => n.className === "r-chat-rows").children;
  assert.ok(rows().length >= 3 && rows().every(r => !r.classList.contains("is-new")), "the first render does not animate");
  const next = view();
  next.view.messages.push({ id: "a2", role: "assistant", text: "more" });
  await b.message(next);
  assert.equal(rows().filter(r => r.classList.contains("is-new")).length, 1, "only the new row fades in");
});

await check("scan: cancel stops the camera and shows the scan button again", async () => {
  const b = browser({ token: null });
  let stopped = 0;
  b.ctx.navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }) };
  await flush();
  await b.button("Scan QR code").emit("click");
  await flush();
  assert.equal(b.button("Scan QR code"), undefined, "the scan button gives way to Cancel scan");
  assert.ok(b.button("Cancel scan"));
  await b.button("Cancel scan").emit("click");
  assert.equal(stopped, 1);
  assert.ok(b.button("Scan QR code"));
  assert.equal(b.button("Cancel scan"), undefined);
});
const callout = b => b.nodes().filter(n => n.className === "r-callout-text").map(n => n.textContent).join(" | ");
await check("scan: denial in the installed app points to iOS settings, not Safari", async () => {
  const b = browser({ token: null });
  b.ctx.navigator.mediaDevices = { getUserMedia: async () => { throw new Error("denied"); } };
  await flush();
  await b.button("Scan QR code").emit("click");
  await flush();
  assert.match(callout(b), /Camera access is off/);
  assert.match(callout(b), /iOS Settings/);
  assert.doesNotMatch(callout(b), /Safari/);
  assert.ok(b.button("Scan again"));
  const tab = browser({ token: null, standalone: false });
  tab.ctx.navigator.mediaDevices = { getUserMedia: async () => { throw new Error("denied"); } };
  await flush();
  await tab.button("Scan QR code").emit("click"); await flush();
  assert.match(callout(tab), /browser settings/);
  assert.match(tab.app.textContent, /Add to Home Screen/, "a browser tab is told to install the app");
});
await check("projectName keeps only the last path segment", () => {
  assert.equal(C.projectName("/Users/me/work/omp-desktop"), "omp-desktop");
  assert.equal(C.projectName("/Users/me/work/omp-desktop///"), "omp-desktop");
  assert.equal(C.projectName("C:\\Users\\me\\proj\\"), "proj");
  assert.equal(C.projectName("C:\\Users/me\\mixed"), "mixed");
  assert.equal(C.projectName("plain"), "plain");
  assert.equal(C.projectName("/"), "");
  assert.equal(C.projectName(""), "");
  assert.equal(C.projectName(undefined), "");
});
await check("otherQuestionCount ignores the active tab and tabs without a question", () => {
  const tabs = [{ id: "a", hasAsk: true }, { id: "b", hasAsk: true }, { id: "c", hasAsk: false }, { id: "d" }];
  assert.equal(C.otherQuestionCount(tabs, "a"), 1);
  assert.equal(C.otherQuestionCount(tabs, "c"), 2);
  assert.equal(C.otherQuestionCount(tabs, null), 2);
  assert.equal(C.otherQuestionCount([], "a"), 0);
  assert.equal(C.otherQuestionCount(undefined, "a"), 0);
});
const sheetTabs = [
  { id: "t", title: "Work", project: "/Users/me/omp-desktop/", busy: true, hasAsk: false },
  { id: "u", title: "Other", project: "side", busy: false, hasAsk: true },
];
const calm = tabs => tabs.map(t => ({ ...t, hasAsk: false }));
// A protocol-2 desktop: its hello names the scope and the capabilities.
const connect2 = async (b, scope, caps = ["query"]) => {
  await flush(); b.sockets.at(-1).onopen();
  await b.message({ t: "hello", deviceId: "d", name: "Phone", proto: 2, caps, scope });
};
const waitingCard = (b, id) => b.nodes().find(n => n["data-tab-id"] === id && /r-wait/.test(n.className));
const byClass = (b, cls) => b.nodes().find(n => n.className === cls);
const toastText = b => b.nodes().filter(n => /^r-toast /.test(n.className)).map(n => n.textContent).join("|");
await check("Sessions: open tabs show the folder name only and their status; waiting tabs get their own block and the nav badge", async () => {
  const b = browser(); await b.connect();
  await b.message({ t: "tabs", tabs: sheetTabs }); await b.message(view());
  const row = b.tab("t");
  assert.ok(row.textContent.includes("omp-desktop") && row.textContent.includes("Running") && row.textContent.includes("On desktop"));
  assert.ok(!b.app.textContent.includes("/Users"), "the full path never shows");
  assert.equal(b.tab("u"), undefined, "a waiting tab is not an open-tab row");
  assert.ok(waitingCard(b, "u").textContent.includes("Question waiting"));
  const badge = () => b.nodes().filter(n => n.className === "r-nav-badge")[1]; // Sessions, Chat, Review, Agents
  assert.equal(badge().hidden, false); assert.equal(badge().textContent, "1");
  await b.message({ t: "tabs", tabs: calm(sheetTabs) });
  assert.equal(badge().hidden, true);
  assert.ok(b.tab("u"), "once its question is answered the tab is a plain open tab");
  assert.equal(waitingCard(b, "u"), undefined);
  assert.equal(byClass(b, "r-link-chip").textContent, "phone", "the chip names the desktop host");
});
await check("Sessions: tapping a tab selects it with a reqId, opens Chat and warns once that the desktop follows", async () => {
  const b = browser(); await b.connect();
  await b.message({ t: "tabs", tabs: [{ id: "t", title: "A", project: "p" }, { id: "u", title: "B", project: "p" }, { id: "v", title: "C", project: "p" }] });
  await b.message(view());
  await b.tab("u").emit("click");
  const select = b.frames.filter(f => f.t === "select").at(-1);
  assert.equal(select.tabId, "u"); assert.ok(select.reqId);
  assert.equal(b.ctx.OMP_REMOTE_UI.current().id, "chat");
  assert.ok(toastText(b).includes("Opening this tab also switches the desktop to it."));
  b.ctx.OMP_REMOTE_UI.navigate("sessions");
  const before = toastText(b);
  await b.tab("v").emit("click");
  assert.equal(toastText(b), before, "the hint shows once per session");
});
await check("quick reply answers a confirm question from the Sessions list; a view-only phone gets a lock instead", async () => {
  const b = browser(); await b.connect();
  await b.message({ t: "tabs", tabs: [{ id: "t", title: "Work", project: "p", hasAsk: true }] }); await b.message(view());
  await b.button("Yes").emit("click"); await flush();
  const sent = b.frames.at(-1);
  assert.deepEqual([sent.t, sent.kind, sent.value, sent.askId, sent.tabId], ["action", "answer", true, "q", "t"]);
  const v = browser(); await connect2(v, "view", []);
  await v.message({ t: "tabs", tabs: [{ id: "t", title: "Work", project: "p", hasAsk: true }] }); await v.message(view());
  assert.equal(v.button("Yes"), undefined, "a view-only phone has no answer buttons");
  assert.ok(waitingCard(v, "t").textContent.includes("Needs Control"));
  assert.ok(!v.frames.some(f => f.kind === "answer"), "nothing the scope forbids is sent");
});
await check("sheets: long press opens the menu; Esc, backdrop and swipe close it; focus goes in and comes back", async () => {
  const b = browser(); await connect2(b, "control");
  await b.message({ t: "tabs", tabs: calm(sheetTabs) }); await b.message(view());
  const row = b.tab("t");
  const selects = () => b.frames.filter(f => f.t === "select").length;
  const dialog = () => b.nodes().find(n => n.role === "dialog");
  const closing = () => dialog().classList.contains("is-closing");
  const settle = () => { for (const t of b.timers.filter(t => t.delay === 200)) t.fn(); };
  const openMenu = async () => { row.focus(); await row.listeners.pointerdown({ clientX: 1, clientY: 1 }); b.timers.findLast(t => t.delay === 450).fn(); };
  const before = selects();
  await openMenu();
  assert.equal(dialog()["aria-modal"], "true"); assert.equal(focused, dialog(), "focus moves into the sheet");
  assert.equal(byClass(b, "r-nav").hidden, false);
  await row.emit("click");
  assert.equal(selects(), before, "the click that ends a long press does not open the tab");
  b.key("Escape"); assert.ok(closing()); settle();
  assert.equal(dialog(), undefined); assert.equal(focused, row, "focus returns to the opener");
  await openMenu(); await byClass(b, "r-scrim").emit("click"); assert.ok(closing()); settle();
  await openMenu();
  const grip = byClass(b, "r-sheet-handle"); dialog().offsetHeight = 400;
  grip.listeners.pointerdown({ clientY: 10 }); grip.listeners.pointermove({ clientY: 15 }); grip.listeners.pointerup({ clientY: 15 });
  assert.equal(closing(), false, "a short drag springs back");
  grip.listeners.pointerdown({ clientY: 10 }); grip.listeners.pointermove({ clientY: 150 }); grip.listeners.pointerup({ clientY: 150 });
  assert.ok(closing(), "a drag past a quarter of the sheet closes it");
  settle();
  assert.equal(dialog(), undefined);
});
await check("session menu: locked rows say what they need and send nothing; other modules' entries appear only when registered", async () => {
  const b = browser(); await connect2(b, "control");
  await b.message({ t: "tabs", tabs: calm(sheetTabs) }); await b.message(view());
  const row = b.tab("t");
  const openMenu = async () => { await row.listeners.pointerdown({ clientX: 1, clientY: 1 }); b.timers.findLast(t => t.delay === 450).fn(); };
  const entry = action => b.nodes().find(n => n["data-action"] === action);
  await openMenu();
  assert.ok(entry("tree") && entry("export"), "the tree and export screens are registered by their modules");
  for (const action of ["compact", "rename", "profile", "close"]) {
    assert.equal(entry(action)["aria-disabled"], "true", action);
    assert.ok(entry(action).textContent.includes("Needs Manage"), action);
  }
  const frames = b.frames.length;
  await entry("compact").emit("click");
  assert.ok(toastText(b).includes("This phone has Control. Compact needs Manage — change it on the desktop."), toastText(b));
  assert.equal(b.frames.length, frames, "a locked entry never reaches the socket");
  b.key("Escape"); for (const t of b.timers.filter(t => t.delay === 200)) t.fn();
  const screen = () => ({ el: b.ctx.document.createElement("section") });
  b.ctx.OMP_REMOTE_UI.registerScreen("tree", screen); b.ctx.OMP_REMOTE_UI.registerScreen("export", screen); // stand-ins: the real ones draw SVG
  await openMenu();
  assert.ok(entry("tree")); assert.equal(entry("export")["aria-disabled"], undefined, "Control may export");
  assert.equal(entry("tree")["aria-disabled"], undefined, "reading the tree needs no scope");
  await entry("tree").emit("click");
  assert.deepEqual([b.ctx.OMP_REMOTE_UI.current().id, b.ctx.OMP_REMOTE_UI.current().params.tabId], ["tree", "t"]);
});
await check("closing a tab asks first, sends closeTab only on confirm, and a failure offers Retry", async () => {
  const b = browser(); await connect2(b, "manage");
  await b.message({ t: "tabs", tabs: calm(sheetTabs) }); await b.message(view());
  const openMenu = async () => { await b.tab("t").listeners.pointerdown({ clientX: 1, clientY: 1 }); b.timers.findLast(t => t.delay === 450).fn(); };
  await openMenu();
  await b.nodes().find(n => n["data-action"] === "close").emit("click"); await flush();
  assert.ok(b.app.textContent.includes("Close Work?"));
  assert.ok(b.app.textContent.includes("The agent is running. Closing stops it."));
  const frames = b.frames.length;
  await b.button("Cancel").emit("click"); await flush();
  assert.equal(b.frames.length, frames, "Cancel sends nothing");
  await openMenu();
  await b.nodes().find(n => n["data-action"] === "close").emit("click"); await flush();
  await b.button("Stop and close").emit("click"); await flush();
  const sent = b.frames.at(-1);
  assert.deepEqual([sent.t, sent.kind, sent.tabId], ["action", "closeTab", "t"]);
  assert.ok(sent.reqId);
  await b.message({ t: "ack", reqId: sent.reqId, ok: false, error: "desktop did not answer" });
  assert.ok(toastText(b).includes("Desktop didn’t answer"));
  await b.button("Retry").emit("click"); await flush();
  const again = b.frames.at(-1);
  assert.equal(again.kind, "closeTab"); assert.notEqual(again.reqId, sent.reqId);
  await b.message({ t: "ack", reqId: again.reqId, ok: true });
});
await check("new session: pick a desktop-listed project, create via newTab, then follow the new tab; failure stays inline", async () => {
  const b = browser(); await connect2(b, "manage");
  await b.message({ t: "tabs", tabs: calm(sheetTabs) }); await b.message(view());
  await b.control("New session").emit("click");
  const queries = b.frames.filter(f => f.t === "query" && (f.q === "projects" || f.q === "profiles"));
  assert.deepEqual(queries.map(q => q.q).sort(), ["profiles", "projects"]);
  assert.ok(queries.every(q => !("tabId" in q)), "projects and profiles are tab-less");
  const answer = (q, data) => b.message({ t: "result", reqId: queries.find(f => f.q === q).reqId, ok: true, data });
  await answer("projects", [{ id: "p1", name: "api-server", open: true }, { id: "p2", name: "docs", open: false }]);
  await answer("profiles", [{ id: "work", name: "work" }]);
  const rows = b.nodes().filter(n => n["data-project-id"]);
  assert.equal(rows.length, 2);
  assert.ok(b.button("Start in api-server"), "the most recent desktop-listed project is selected by default");
  await rows[1].emit("click");
  await rows[0].emit("click");
  await b.button("Start in api-server").emit("click"); await flush();
  const sent = b.frames.at(-1);
  assert.deepEqual([sent.kind, sent.tabId, sent.args], ["newTab", "t", { projectId: "p1" }]);
  assert.ok(b.button("Starting omp…").disabled);
  await b.message({ t: "ack", reqId: sent.reqId, ok: false, error: "omp 0.9.1 < required 0.10.0" });
  assert.ok(b.app.textContent.includes("omp didn’t start") && b.app.textContent.includes("omp 0.9.1 < required 0.10.0"));
  await b.button("Try again").emit("click"); await flush();
  const retry = b.frames.at(-1);
  assert.equal(retry.kind, "newTab");
  await b.message({ t: "ack", reqId: retry.reqId, ok: true, data: { tabId: "n" } }); await flush();
  assert.equal(b.frames.filter(f => f.t === "select").at(-1).tabId, "n", "the phone follows the new tab");
  assert.equal(b.nodes().find(n => n.role === "dialog" && !n.classList.contains("is-closing")), undefined, "the sheet closes");
  const view_only = browser(); await connect2(view_only, "view");
  await view_only.message({ t: "tabs", tabs: sheetTabs }); await view_only.message(view());
  const locked = view_only.control("New session. Needs Manage");
  assert.ok(locked, "the locked plus names the scope it needs");
  const count = view_only.frames.length;
  await locked.emit("click");
  assert.equal(view_only.frames.length, count);
  assert.ok(toastText(view_only).includes("View only"));
});
await check("saved sessions: loaded with the active tab, searchable, resumed with Manage and locked without", async () => {
  const b = browser(); await connect2(b, "manage");
  await b.message({ t: "tabs", tabs: calm(sheetTabs) }); await b.message(view());
  const q = b.frames.find(f => f.t === "query" && f.q === "savedSessions");
  assert.equal(q.tabId, "t", "the query rides on the active tab, so the desktop does not switch");
  await b.message({ t: "result", reqId: q.reqId, ok: true, data: [
    { id: "s1", title: "Tailscale relay latency", project: "omp-desktop", updatedAt: new Date(Date.now() - 3600_000).toISOString() },
    { id: "s2", title: "Push payload privacy", project: "docs" },
  ] });
  const rows = () => b.nodes().filter(n => n["data-session-id"]);
  assert.equal(rows().length, 2); assert.ok(rows()[0].textContent.includes("omp-desktop · 1h"));
  const search = b.nodes().find(n => n.tagName === "input" && n["aria-label"] === "Search saved sessions");
  search.value = "payload"; await search.emit("input");
  assert.deepEqual(rows().map(n => n["data-session-id"]), ["s2"]);
  search.value = "zzz"; await search.emit("input");
  assert.ok(b.app.textContent.includes("No matches"));
  search.value = ""; await search.emit("input");
  await rows()[0].emit("click"); await flush();
  const sent = b.frames.at(-1);
  assert.deepEqual([sent.kind, sent.tabId, sent.args], ["resumeSession", "t", { sessionId: "s1" }]);
  await b.message({ t: "ack", reqId: sent.reqId, ok: true, data: { tabId: "r" } });
  assert.equal(b.frames.filter(f => f.t === "select").at(-1).tabId, "r");
  const c = browser(); await connect2(c, "control");
  await c.message({ t: "tabs", tabs: calm(sheetTabs) }); await c.message(view());
  await c.message({ t: "result", reqId: c.frames.find(f => f.q === "savedSessions").reqId, ok: true, data: [{ id: "s1", title: "Old", project: "p" }] });
  const locked = c.nodes().find(n => n["data-session-id"]);
  assert.ok(locked.textContent.includes("Needs Manage"));
  const count = c.frames.length;
  await locked.emit("click"); await flush();
  assert.equal(c.frames.length, count, "Control cannot resume");
});
await check("banners: reconnecting, then offline with Retry that skips the backoff; revoked hands over to pairing", async () => {
  const b = browser(); await b.connect();
  const banner = () => b.nodes().find(n => /^r-banner /.test(n.className));
  assert.equal(banner(), undefined);
  b.sockets[0].onclose({ code: 1006 });
  assert.ok(banner().textContent.includes("Reconnecting"));
  b.timers.at(-1).fn(); await flush();
  b.sockets.at(-1).onclose({ code: 4503 });
  assert.ok(banner().textContent.includes("Desktop offline"));
  const sockets = b.sockets.length;
  await b.button("Retry").emit("click");
  assert.equal(b.sockets.length, sockets + 1, "Retry reconnects at once");
  await b.message({ t: "hello", deviceId: "d", name: "Phone" });
  assert.equal(banner(), undefined, "the banner leaves with the connection");
});
await check("Connection screen: desktop state, device, scope and links only to registered screens", async () => {
  const b = browser(); await connect2(b, "control");
  await b.message({ t: "tabs", tabs: calm(sheetTabs) });
  await byClass(b, "r-link-chip").emit("click");
  const text = () => b.app.textContent;
  assert.ok(text().includes("Connected") && text().includes("Live. 2 open tabs."));
  assert.ok(text().includes("Scope") && text().includes("Settings › Paired phones"));
  const current = b.nodes().find(n => n.className === "r-scope-cell is-current");
  assert.ok(current.textContent.startsWith("Control"));
  assert.ok(text().includes("Approval rules") && text().includes("Usage"), "both screens are registered");
  b.ctx.OMP_REMOTE_UI.registerScreen("approval-rules", () => ({ el: b.ctx.document.createElement("section") })); // stand-in
  await b.nodes().filter(n => String(n.className).startsWith("r-link-row")).find(n => n.textContent.includes("Approval rules")).emit("click");
  assert.equal(b.ctx.OMP_REMOTE_UI.current().id, "approval-rules");
  b.ctx.OMP_REMOTE_UI.back();
  await b.control("Back").emit("click");
  assert.equal(b.ctx.OMP_REMOTE_UI.current().id, "chat", "back lands on the tab root (the test page opens from a push tap on ?tab=, so Chat)");
});
await check("pairing: a fresh phone sees steps and no nav; after pairing it shows the scope and Continue (or Turn on notifications)", async () => {
  const fresh = browser({ token: null });
  assert.ok(fresh.app.textContent.includes("Pair with your desktop") && fresh.app.textContent.includes("Settings › Remote access › Pair phone"));
  assert.equal(byClass(fresh, "r-nav").hidden, true, "no bottom nav while pairing");
  const b = browser({ pair: true, token: null });
  await flush(); b.sockets.at(-1).onopen();
  await b.message({ t: "hello", deviceId: "d", name: "Phone", proto: 2, caps: [], scope: "view" });
  assert.match(callout(b), /Paired with phone/);
  assert.match(callout(b), /Scope: View only\./);
  await b.button("Continue").emit("click");
  assert.equal(byClass(b, "r-nav").hidden, false, "continuing leaves the gate");
  assert.equal(b.ctx.OMP_REMOTE_UI.current().id, "chat", "a ?tab= launch lands on Chat");
  const p = browser({ pair: true, token: null });
  await flush(); p.sockets.at(-1).onopen();
  await p.message({ t: "hello", deviceId: "d", name: "Phone", proto: 2, caps: [], scope: "control" });
  await p.message({ t: "push-key", key: "AQID" });
  await p.button("Turn on notifications").emit("click"); await flush(); await flush(); await flush();
  assert.deepEqual(p.registrations, ["/sw.js"], "the opt-in follows a tap");
  assert.equal(byClass(p, "r-nav").hidden, false);
  const bad = browser({ pair: true, token: null, pairStatus: 410 });
  await flush();
  assert.match(callout(bad), /expired or was already used/);
  assert.ok(bad.button("Scan again"));
});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const fakeStream = counter => ({ getTracks: () => [{ stop: () => counter.stopped++ }] });
const noDenial = b => !b.app.textContent.includes("Camera access is off");
await check("scan race: a camera that arrives after Cancel is stopped and no denial is shown", async () => {
  const b = browser({ token: null }); const counter = { stopped: 0 }; const gum = deferred();
  b.ctx.navigator.mediaDevices = { getUserMedia: () => gum.promise };
  await flush();
  b.button("Scan QR code").emit("click");
  await b.button("Cancel scan").emit("click");
  gum.resolve(fakeStream(counter)); await flush();
  assert.equal(counter.stopped, 1, "the late stream's tracks are stopped");
  assert.ok(b.button("Scan QR code"));
  assert.equal(b.button("Cancel scan"), undefined);
  assert.ok(noDenial(b), "no error after cancel");
});
await check("scan race: a late camera error after Cancel shows no denial; Cancel during play stops once", async () => {
  const b = browser({ token: null }); const gum = deferred();
  b.ctx.navigator.mediaDevices = { getUserMedia: () => gum.promise };
  await flush();
  b.button("Scan QR code").emit("click");
  await b.button("Cancel scan").emit("click");
  gum.reject(new Error("denied")); await flush();
  assert.ok(noDenial(b));
  const counter = { stopped: 0 }, play = deferred();
  const c = browser({ token: null });
  c.ctx.navigator.mediaDevices = { getUserMedia: async () => fakeStream(counter) };
  c.nodes().find(n => n.tagName === "video").play = () => play.promise;
  await flush();
  c.button("Scan QR code").emit("click"); await flush();
  await c.button("Cancel scan").emit("click");
  assert.equal(counter.stopped, 1);
  play.reject(new Error("AbortError")); await flush();
  assert.equal(counter.stopped, 1);
  assert.ok(noDenial(c));
  assert.ok(c.button("Scan QR code"));
});
await check("scan race: a second scan tap replaces the first scan without leaking a stream", async () => {
  const b = browser({ token: null }); const first = { stopped: 0 }, second = { stopped: 0 };
  const pending = [deferred(), deferred()]; let call = 0;
  b.ctx.navigator.mediaDevices = { getUserMedia: () => pending[call++].promise };
  await flush();
  // The pairing screen swaps its button for Cancel scan on the first tap, so a
  // second start can only come from the scanner itself (a double tap before render).
  const scan = b.button("Scan QR code");
  scan.emit("click"); scan.emit("click");
  pending[0].resolve(fakeStream(first)); pending[1].resolve(fakeStream(second)); await flush();
  assert.equal(first.stopped, 1, "the replaced scan's stream is stopped");
  assert.equal(second.stopped, 0, "the live scan keeps its camera");
  await b.button("Cancel scan").emit("click");
  assert.equal(second.stopped, 1);
});
await check("trackShown keys rows by id, else role and text, and tracks open asks", () => {
  assert.equal(C.messageKey({ id: "a", role: "user", text: "x" }), C.messageKey({ id: "a", role: "user", text: "y" }));
  assert.notEqual(C.messageKey({ role: "user", text: "x" }), C.messageKey({ role: "assistant", text: "x" }));
  assert.notEqual(C.messageKey({ role: "user", text: "x" }), C.messageKey({ role: "user", text: "y" }));
  const first = C.trackShown(new Set(), [{ role: "user", text: "hi" }], [{ id: "q" }]);
  assert.equal(first.fresh.size, 2);
  const second = C.trackShown(first.shown, [{ role: "user", text: "hi" }], [{ id: "q" }, { id: "r" }]);
  assert.deepEqual([...second.fresh], ["ask:r"], "existing rows and asks do not fade again");
  assert.equal(C.trackShown(second.shown, [], []).shown.size, 0, "keys that left are forgotten");
});

await check("an id-less row keeps its identity when its position changes; the old ask does not re-render", async () => {
  const b = browser(); await b.connect();
  const rows = () => b.nodes().find(n => n.className === "r-chat-rows").children;
  await b.message({ t: "view", view: { tabId: "t", busy: false, messages: [{ role: "user", text: "hello" }], asks: [{ id: "q", kind: "confirm", title: "One", message: "" }] } });
  const user = rows()[0], ask = b.nodes().find(n => n["data-ask-id"] === "q");
  await b.message({ t: "view", view: { tabId: "t", busy: false, messages: [{ role: "assistant", text: "before" }, { role: "user", text: "hello" }],
    asks: [{ id: "q", kind: "confirm", title: "One", message: "" }, { id: "r", kind: "confirm", title: "Two", message: "" }] } });
  assert.equal(rows().at(-1), user, "the same text keeps its element");
  assert.equal(b.nodes().filter(n => n["data-ask-id"]).length, 2);
  assert.ok(!user.classList.contains("is-new"), "no replayed fade");
});
await check("production-shaped synthetic ids: a row whose index shifts keeps its fade key", () => {
  const synthetic = (index, role, text) => ({ id: `${role}:${index}`, idSynthetic: true, role, text });
  const first = C.trackShown(new Set(), [synthetic(0, "user", "hello"), synthetic(1, "assistant", "hi")]);
  const second = C.trackShown(first.shown, [synthetic(1, "user", "hello"), synthetic(2, "assistant", "hi"), synthetic(3, "assistant", "new")]);
  assert.deepEqual([...second.fresh], [C.messageKey({ role: "assistant", text: "new" })], "only the new row is fresh");
  assert.equal(C.messageKey({ id: "user:0", idSynthetic: true, role: "user", text: "a" }), C.messageKey({ id: "user:9", idSynthetic: true, role: "user", text: "a" }));
  assert.equal(C.messageKey({ id: "real", role: "user", text: "a" }), "id:real", "a real id still wins");
});
if (failed) { console.error(`remote-client: ${failed} failed, ${passed} passed`); process.exit(1); }
console.log(`remote-client: ${passed} checks passed`);
