#!/usr/bin/env node
// Phone Chat tab logic (src/remote/chat-logic.js): composer state machine,
// slash and @ palettes, phone-side queue, run state, message-menu eligibility.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const L = createRequire(import.meta.url)(root + "src/remote/chat-logic.js");
const all = { prompt: true, steer: true, followUp: true, abort: true };
const legacy = { prompt: true, steer: true, followUp: false, abort: true };
const view = { prompt: false, steer: false, followUp: false, abort: false };

test("composer: idle sends, needs text", () => {
  assert.equal(L.composerState({ busy: false, draft: "", can: all }).kind, "send");
  assert.equal(L.composerState({ busy: false, draft: "  \n", can: all }).disabled, true);
  const s = L.composerState({ busy: false, draft: "hi", can: all });
  assert.deepEqual([s.kind, s.action, s.disabled, s.modes], ["send", "prompt", false, false]);
  assert.equal(L.composerState({ busy: false, draft: "hi", uploading: true, can: all }).disabled, true);
});
test("composer: running = stop without text, steer or queue with text", () => {
  const stop = L.composerState({ busy: true, draft: " ", can: all });
  assert.deepEqual([stop.kind, stop.action, stop.disabled], ["stop", "abort", false]);
  const steer = L.composerState({ busy: true, draft: "x", can: all });
  assert.deepEqual([steer.kind, steer.action, steer.modes, steer.label], ["steer", "steer", true, "Steer"]);
  const queue = L.composerState({ busy: true, draft: "x", mode: "queue", can: all });
  assert.deepEqual([queue.kind, queue.action, queue.label], ["queue", "followUp", "Queue"]);
});
test("composer: legacy desktop has no queue, view scope is locked", () => {
  const s = L.composerState({ busy: true, draft: "x", mode: "queue", can: legacy });
  assert.deepEqual([s.kind, s.action, s.modes], ["steer", "steer", false]);
  assert.equal(L.composerState({ busy: true, draft: "", can: view }).kind, "locked");
  assert.equal(L.composerState({ busy: false, draft: "x", can: view }).disabled, true);
});
test("submitPlan: request kind, fields, images, refusals", () => {
  const send = L.composerState({ busy: false, draft: "hello", can: all });
  assert.deepEqual(L.submitPlan(send, "hello", ["u1"]), { kind: "prompt", fields: { text: "hello", args: { images: ["u1"] } } });
  assert.deepEqual(L.submitPlan(send, "hello"), { kind: "prompt", fields: { text: "hello" } });
  assert.equal(L.submitPlan(send, "x".repeat(40000)), null);
  const queue = L.composerState({ busy: true, draft: "later", mode: "queue", can: all });
  assert.deepEqual(L.submitPlan(queue, "later").kind, "followUp");
  assert.deepEqual(L.submitPlan(L.composerState({ busy: true, draft: "", can: all }), ""), { kind: "abort", fields: {} });
  assert.equal(L.submitPlan(L.composerState({ busy: false, draft: "", can: all }), ""), null);
  assert.equal(L.submitPlan(L.composerState({ busy: false, draft: "x", can: view }), "x"), null);
});
test("placeholder follows the state", () => {
  assert.equal(L.composerPlaceholder({ busy: true }), "Message, steer or stop…");
  assert.equal(L.composerPlaceholder({ asking: true, busy: true }), "Reply or add instructions…");
  assert.equal(L.composerPlaceholder({ stopped: true }), "Send a new prompt…");
  assert.match(L.composerPlaceholder({ locked: true }), /View scope/);
});

test("slash: only a leading command without arguments opens the palette", () => {
  assert.equal(L.slashQuery("/co"), "co");
  assert.equal(L.slashQuery("/"), "");
  assert.equal(L.slashQuery("/compact now"), null);
  assert.equal(L.slashQuery("hi /co"), null);
  assert.equal(L.slashQuery(""), null);
});
test("slash: filtering ranks name prefix first, then fuzzy and description", () => {
  const cmds = [
    { name: "commit", description: "stage and commit" }, { name: "cost", description: "show spend" },
    { name: "compact", description: "free context" }, { name: "review", description: "compare changes" },
  ];
  assert.deepEqual(L.filterCommands(cmds, "co").map(c => c.name), ["commit", "cost", "compact", "review"]); // review: description only, ranked last
  assert.deepEqual(L.filterCommands(cmds, "cmt").map(c => c.name), ["commit", "compact"]);
  assert.deepEqual(L.filterCommands(cmds, "spend").map(c => c.name), ["cost"]);
  assert.equal(L.filterCommands(cmds, "").length, 4);
  assert.deepEqual(L.filterCommands(cmds, "zzz"), []);
  assert.deepEqual(L.filterCommands(null, "a"), []);
  assert.equal(L.commandText({ name: "compact" }), "/compact ");
  assert.equal(L.filterCommands(Array.from({ length: 50 }, (_, i) => ({ name: `c${i}` })), "c").length, 30);
});
test("mention: token at caret and splice", () => {
  assert.deepEqual(L.mentionToken("fix @src/au", 11), { start: 4, end: 11, query: "src/au" });
  assert.equal(L.mentionToken("mail a@b", 8), null);
  assert.equal(L.mentionToken("no at", 5), null);
  assert.deepEqual(L.mentionToken("(@x", 3), { start: 1, end: 3, query: "x" });
  assert.equal(L.mentionToken("@a @b", 2).query, "a");
  const range = L.mentionToken("fix @src/au tail", 11);
  assert.deepEqual(L.applyToken("fix @src/au tail", range, "@src/auth.ts "), { text: "fix @src/auth.ts  tail", caret: 17 });
  assert.equal(L.mentionInsert({ path: "src", isDir: true }), "@src/");
  assert.equal(L.mentionInsert({ path: "a b", isDir: true }), "@a b ");
  assert.equal(L.mentionInsert(L.fileItem("x.js")), "@x.js ");
  assert.equal(L.fileItem({}), null);
});

test("queue: items leave once their message shows up", () => {
  const user = text => ({ role: "user", text });
  let items = L.queueAdd([], { text: "next" }, [user("first")]);
  assert.equal(items.length, 1);
  assert.equal(L.queuePrune(items, [user("first")]).length, 1);
  assert.equal(L.queuePrune(items, [user("first"), user("next")]).length, 0);
  // the same text twice: the first echo clears one entry only
  items = L.queueAdd(items, { text: "next" }, [user("first")]);
  assert.equal(L.queuePrune(items, [user("next")]).length, 1);
  assert.equal(L.queuePrune(items, [user("next"), user("next")]).length, 0);
  // already sent before: the old echo does not clear it
  const again = L.queueAdd([], { text: "go" }, [user("go")]);
  assert.equal(L.queuePrune(again, [user("go")]).length, 1);
});
test("queue: cap, remove, promote, view wins", () => {
  let items = [];
  for (let i = 0; i < 20; i++) items = L.queueAdd(items, { text: `m${i}` }, []);
  assert.equal(items.length, L.MAX_QUEUE);
  const [a, b, c] = items;
  assert.deepEqual(L.queueRemoveItem(items, b).slice(0, 2), [a, c]);
  assert.deepEqual(L.queuePromoteItem(items, c).slice(0, 3), [c, a, b]);
  assert.equal(L.queuePromoteItem(items, a), items);
  assert.deepEqual(L.queueOf({ queue: [{ text: "x", queue: "steering" }, { text: " " }] }, items), [{ text: "x", queue: "steering" }]);
  assert.equal(L.queueOf({}, items), items);
});

test("runState: waiting beats running beats stopped, tool name shows", () => {
  const msgs = [{ role: "user", text: "a" }, { role: "tool", tool: { name: "bash" } }];
  assert.deepEqual(L.runState({ view: { busy: true, messages: msgs, asks: [{}] } }).text, "Waiting");
  const running = L.runState({ view: { busy: true, messages: msgs } });
  assert.deepEqual([running.id, running.text], ["running", "Running bash"]);
  assert.equal(L.runState({ view: { busy: true, messages: [{ role: "user" }] } }).text, "Thinking…");
  assert.equal(L.runState({ view: { busy: false, messages: msgs }, stopped: true }).text, "Stopped");
  assert.equal(L.runState({ tab: { status: "finished" }, view: { messages: [] } }).text, "Finished");
  assert.equal(L.runState({ tab: { hasAsk: true } }).id, "waiting");
  assert.equal(L.runState({}).text, "Idle");
});
test("tool helpers", () => {
  assert.equal(L.toolIcon("bash"), "tool-bash");
  assert.equal(L.toolIcon("edit"), "slash");
  assert.equal(L.toolIcon("read"), "tool-file");
  assert.deepEqual(L.outputTail("a\n\nb\nc\nd  \n", 2), ["c", "d"]);
  const msgs = [{ role: "user" }, { role: "tool" }];
  assert.equal(L.isLiveTool(msgs, 1, true), true);
  assert.equal(L.isLiveTool(msgs, 1, false), false);
  assert.equal(L.isLiveTool(msgs, 0, true), false);
});

const ok = () => ({ ok: true, label: "" });
const locked = () => ({ ok: false, label: "Needs Manage" });
const thread = [
  { id: "u1", role: "user", text: "fix it" },
  { id: "a1", role: "assistant", text: "looking" },
  { id: "t1", role: "tool", text: "" },
  { id: "a2", role: "assistant", text: "Fixed." },
  { id: "u2", role: "user", text: "thanks" },
  { id: "a3", role: "assistant", text: "Welcome." },
];
test("menu: user message offers branch + copy, idle and unlocked", () => {
  const menu = L.messageMenu({ messages: thread, index: 0, busy: false, gate: ok });
  assert.deepEqual(menu.entries.map(e => [e.id, e.locked]), [["branch", false], ["copy", false]]);
  assert.equal(menu.entries[0].entryId, "u1");
  assert.equal(menu.entries[0].kind, "branchAt");
  assert.equal(menu.heading, null);
});
test("menu: only a turn's final answer can be forked", () => {
  assert.deepEqual(L.messageMenu({ messages: thread, index: 1, busy: false, gate: ok }).entries.map(e => e.id), ["copy"]);
  const final = L.messageMenu({ messages: thread, index: 3, busy: false, gate: ok });
  assert.deepEqual(final.entries.map(e => e.id), ["fork", "copy"]);
  assert.equal(final.heading, "Final answer · turn 1");
  assert.equal(L.messageMenu({ messages: thread, index: 5, busy: false, gate: ok }).heading, "Final answer · turn 2");
});
test("menu: busy locks branch with the idle explanation; running tail is not final", () => {
  const busy = L.messageMenu({ messages: thread, index: 0, busy: true, gate: ok });
  assert.equal(busy.entries[0].locked, true);
  assert.match(busy.entries[0].note, /idle/);
  assert.equal(L.isFinalAnswer(thread, 5, true), false);
  assert.equal(L.isFinalAnswer(thread, 3, true), true);
  assert.deepEqual(L.messageMenu({ messages: thread, index: 5, busy: true, gate: ok }).entries.map(e => e.id), ["copy"]);
});
test("menu: scope lock keeps the entry with its chip, bad ids drop it", () => {
  const menu = L.messageMenu({ messages: thread, index: 0, busy: false, gate: locked });
  assert.deepEqual([menu.entries[0].locked, menu.entries[0].lockLabel, menu.entries[0].scopeLocked], [true, "Needs Manage", true]);
  const synthetic = [{ id: "user:3", role: "user", text: "x", idSynthetic: true }, { id: "a b", role: "user", text: "y" }];
  assert.deepEqual(L.messageMenu({ messages: synthetic, index: 0, busy: false, gate: ok }).entries.map(e => e.id), ["copy"]);
  assert.deepEqual(L.messageMenu({ messages: synthetic, index: 1, busy: false, gate: ok }).entries.map(e => e.id), ["copy"]);
  assert.equal(L.entryIdOf({ entryId: "e-9", id: "x y" }), "e-9");
  assert.equal(L.messageMenu({ messages: [{ role: "tool" }], index: 0, busy: false, gate: ok }), null);
  assert.equal(L.messageMenu({ messages: thread, index: 9, busy: false, gate: ok }), null);
});

test("diffPreview counts changed lines of a unified diff and previews the first ones", async () => {
  const L = (await import("node:module")).createRequire(import.meta.url)("../src/remote/chat-logic.js");
  const out = L.diffPreview("--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n context\n-old one\n+new one\n+new two\n-old two\n-old three");
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { add: 2, rm: 3, lines: [
    { kind: "rm", text: "old one" }, { kind: "add", text: "new one" }, { kind: "add", text: "new two" }, { kind: "rm", text: "old two" } ] });
  assert.equal(L.diffPreview("just text output"), null);
  assert.equal(L.diffPreview(""), null);
  assert.equal(L.diffPreview("+++ b/x\n--- a/x"), null, "headers alone are not changes");
});

test("planStrip, contextLine and modelChip read only what the desktop published", async () => {
  const L = (await import("node:module")).createRequire(import.meta.url)("../src/remote/chat-logic.js");
  const strip = L.planStrip({ todos: [{ name: "P", tasks: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }, { content: "x", status: "abandoned" }] }] });
  assert.deepEqual(JSON.parse(JSON.stringify(strip)), { done: 1, total: 3, current: "b", pct: 33 });
  assert.equal(L.planStrip({}), null);
  assert.deepEqual(JSON.parse(JSON.stringify(L.contextLine({ context: { pct: 61.6, cost: "$1.84" } }))), { pct: 62, cost: "$1.84" });
  assert.equal(L.contextLine({ context: {} }), null);
  assert.equal(L.modelChip({ model: { name: "Claude Opus" }, thinkingLevel: "high" }), "Opus · high");
  assert.equal(L.modelChip({ model: { id: "gpt-codex" }, thinkingLevel: "off" }), "codex");
  assert.equal(L.modelChip({}), "Model & modes");
});
