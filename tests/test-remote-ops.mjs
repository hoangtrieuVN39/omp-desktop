#!/usr/bin/env node
// Phone protocol-2 operations (app/remote-ops.js): argument checks against
// an untrusted phone, opaque project/session ids, and the mapping onto
// bridge methods — including the handler routing in app/remote-view.js.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const own = value => JSON.parse(JSON.stringify(value));

function load() {
  const window = {};
  const ctx = { window, Date, setTimeout, clearTimeout };
  for (const file of ["remote-view.js", "remote-ops.js"]) {
    runInNewContext(readFileSync(new URL(`../src/app/${file}`, import.meta.url), "utf8"), ctx);
  }
  return { ops: window.OMP_REMOTE_OPS, view: window.OMP_REMOTE_VIEW, window };
}

const snap = (extra = {}) => ({
  activeSessionId: "t1",
  sessions: [{ id: "t1", name: "Work", path: "D:\\code\\app", profile: "default", sessionFile: "D:\\s\\a.jsonl" }],
  recentProjects: [{ path: "D:\\code\\app" }, { path: "/home/me/other" }],
  profiles: [{ id: "default", name: "Default" }, { id: "work", name: "Work" }],
  models: [{ provider: "anthropic", id: "opus", name: "Opus" }],
  messages: [],
  isStreaming: false,
  ...extra,
});

test("relative paths refuse absolute, drive, parent and NUL forms", () => {
  const { ops } = load();
  for (const ok of ["src/a.rs", "a", "dir\\b.txt", "x..y"]) assert.equal(ops.relPath(ok), true, ok);
  for (const no of ["/etc/passwd", "\\\\server\\x", "C:\\a", "c:a", "../a", "a/../../b", "a\\..\\b", "", "a\0b", 7]) {
    assert.equal(ops.relPath(no), false, String(no));
  }
});

test("invalidArgs rejects malformed requests per kind and accepts well-formed ones", () => {
  const { ops } = load();
  const cases = [
    ["followUp", {}, "hi", null],
    ["followUp", {}, "  ", "invalid arguments"],
    ["prompt", { images: ["u1", "u2"] }, "x", null],
    ["prompt", { images: Array(9).fill("u") }, "x", "invalid arguments"],
    ["prompt", { images: ["../x"] }, "x", "invalid arguments"],
    ["queueRemove", { text: "a", queue: "steering" }, null, null],
    ["queueRemove", { text: "a", queue: "other" }, null, "invalid arguments"],
    ["gitReject", { path: "src/x" }, null, null],
    ["gitReject", { path: "/abs" }, null, "invalid arguments"],
    ["goalStart", { objective: "do it", tokenBudget: 1000 }, null, null],
    ["goalStart", { objective: "do it", tokenBudget: -1 }, null, "invalid arguments"],
    ["goalOp", { op: "complete" }, null, "invalid arguments"],
    ["approvalModeProject", { mode: null }, null, null],
    ["approvalModeProject", { mode: "root" }, null, "invalid arguments"],
    ["gitSwitchBranch", { name: "main", remote: "no" }, null, "invalid arguments"],
    ["newTab", { projectId: "abc" }, null, null],
    ["newTab", { projectId: "D:\\code\\app" }, null, "invalid arguments"],
    ["setModel", { provider: "anthropic", id: "" }, null, "invalid arguments"],
  ];
  for (const [kind, args, text, want] of cases) {
    assert.equal(ops.invalidArgs(kind, args, text), want, `${kind} ${JSON.stringify(args)}`);
  }
});

test("projects are named by stable opaque ids and never carry a path", () => {
  const { ops } = load();
  const list = ops.projectList(snap());
  assert.deepEqual(own(list.map(p => [p.name, p.open])), [["app", true], ["other", false]]);
  assert.equal(list[0].id, ops.opaqueId("D:\\code\\app"));
  assert.equal(ops.opaqueId("a"), ops.opaqueId("a"));
  assert.notEqual(ops.opaqueId("a"), ops.opaqueId("b"));
  assert.match(list[0].id, /^[0-9a-f]{16}$/);
});

test("queries map onto the bridge without exposing paths", async () => {
  const { ops } = load();
  const calls = [];
  const bridge = {
    listSavedSessions: async cwd => { calls.push(["list", cwd]); return [{ path: "D:\\s\\a.jsonl", title: "Fix", projectName: "app", messageCount: 3, cwd: "D:\\code\\app" }]; },
    openSession: async (path, profile) => { calls.push(["open", path, profile]); return "t9"; },
    resumeSession: async session => { calls.push(["resume", session.path]); return "t7"; },
    conversationTree: async (file, profile) => ({ ok: true, value: { file, profile } }),
  };
  const ctx = { bridge, deviceId: "d", tabId: "t1", snapshot: () => snap(), entry: () => snap().sessions[0] };
  const projects = await ops.run("projects", {}, null, ctx);
  assert.deepEqual(own(projects.map(p => Object.keys(p).sort())), [["id", "name", "open"], ["id", "name", "open"]]);
  const saved = await ops.run("savedSessions", { projectId: projects[0].id }, null, ctx);
  assert.deepEqual(own(calls.at(-1)), ["list", "D:\\code\\app"]);
  assert.equal(JSON.stringify(saved).includes("jsonl"), false, "no session path");
  assert.deepEqual(own(await ops.run("resumeSession", { sessionId: saved[0].id }, null, ctx)), { tabId: "t7" });
  assert.deepEqual(own(await ops.run("newTab", { projectId: projects[1].id, profile: "work" }, null, ctx)), { tabId: "t9" });
  assert.deepEqual(own(calls.at(-1)), ["open", "/home/me/other", "work"]);
  await assert.rejects(ops.run("newTab", { projectId: "0000000000000000" }, null, ctx), /unknown project/);
  await assert.rejects(ops.run("newTab", { projectId: projects[0].id, profile: "ghost" }, null, ctx), /unknown profile/);
  await assert.rejects(ops.run("resumeSession", { sessionId: "ffffffffffffffff" }, null, ctx), /unknown session/);
  assert.deepEqual(own(await ops.run("conversationTree", {}, null, ctx)), { file: "D:\\s\\a.jsonl", profile: "default" });
});

test("actions only pass values the desktop itself listed", async () => {
  const { ops } = load();
  const calls = [];
  const bridge = {
    setModel: m => calls.push(["model", m.id]),
    thinkingLevels: async () => ["off", "high"],
    setThinkingLevel: async level => calls.push(["thinking", level]),
    gitBranches: async () => ({ ok: true, value: [{ name: "main", remote: false }] }),
    gitSwitchBranch: async (name, remote) => { calls.push(["switch", name, remote]); return { ok: true, value: null }; },
    removeQueuedMessage: async () => false,
    setApprovalModeProject: async (path, mode) => { calls.push(["mode", path, mode]); return { ok: true }; },
  };
  const ctx = { bridge, deviceId: "d", tabId: "t1", snapshot: () => snap(), entry: () => snap().sessions[0] };
  await ops.run("setModel", { provider: "anthropic", id: "opus" }, null, ctx);
  await assert.rejects(ops.run("setModel", { provider: "x", id: "y" }, null, ctx), /unknown model/);
  await ops.run("setThinking", { level: "high" }, null, ctx);
  await assert.rejects(ops.run("setThinking", { level: "max" }, null, ctx), /not supported/);
  await ops.run("gitSwitchBranch", { name: "main", remote: false }, null, ctx);
  await assert.rejects(ops.run("gitSwitchBranch", { name: "evil", remote: false }, null, ctx), /unknown branch/);
  await assert.rejects(ops.run("queueRemove", { text: "a", queue: "steering" }, null, ctx), /no longer queued/);
  await ops.run("approvalModeProject", { mode: "write" }, null, ctx);
  assert.deepEqual(calls, [["model", "opus"], ["thinking", "high"], ["switch", "main", false], ["mode", "D:\\code\\app", "write"]]);
});

test("export offers omp's file to the requesting device and returns the download id", async () => {
  const { ops } = load();
  const bridge = {
    exportHtmlFile: async () => "D:\\exports\\session-1.html",
    remoteOfferDownload: async (device, path) => `${device}:${path.length}`,
  };
  const ctx = { bridge, deviceId: "dev", tabId: "t1", snapshot: () => snap(), entry: () => null };
  assert.deepEqual(own(await ops.run("exportHtml", {}, null, ctx)), { downloadId: "dev:25", name: "session-1.html" });
  bridge.exportHtmlFile = async () => null;
  await assert.rejects(ops.run("exportHtml", {}, null, ctx), /export failed/);
});

test("toolOutput returns one full tool card and caps huge output", async () => {
  const { ops } = load();
  const big = "x".repeat(500 * 1024);
  const s = snap({ messages: [{ kind: "tool", _toolCallId: "c1", tool: "bash", title: "ls", output: big, status: "done" }] });
  const ctx = { bridge: {}, deviceId: "d", tabId: "t1", snapshot: () => s, entry: () => null };
  const detail = await ops.run("toolOutput", { messageId: "c1" }, null, ctx);
  assert.equal(detail.tool, "bash");
  assert.equal(detail.truncated, true);
  assert.equal(detail.output.length, 400 * 1024);
  await assert.rejects(ops.run("toolOutput", { messageId: "nope" }, null, ctx), /no such tool card/);
});

test("the handler validates, runs and returns query data; images reach the prompt", async () => {
  const { view } = load();
  const results = [];
  const sent = [];
  const bridge = {
    activeSessionId: "t1",
    activateSession: async () => {},
    remoteActionResult: async (...args) => results.push(args),
    remoteTakeUpload: async (device, id) => (device === "d" && id === "u1" ? { mimeType: "image/png", data: "AAA" } : null),
    send: async (text, images) => { sent.push([text, images]); return true; },
    gitBrowserStatus: async () => ({ ok: true, value: { files: ["a"] } }),
  };
  const status = { listening: true, devices: [{ id: "d", connected: true }] };
  const handle = view.makeActionHandler(bridge, () => snap(), () => status);
  await handle({ reqId: "q1", deviceId: "d", tabId: "t1", kind: "gitStatus", query: true, args: null });
  await handle({ reqId: "q2", deviceId: "d", tabId: "t1", kind: "gitFile", query: true, args: { path: "../x" } });
  await handle({ reqId: "a1", deviceId: "d", tabId: "t1", kind: "prompt", text: "look", args: { images: ["u1"] } });
  await handle({ reqId: "a2", deviceId: "d", tabId: "t1", kind: "prompt", text: "look", args: { images: ["u2"] } });
  await handle({ reqId: "a3", deviceId: "d", tabId: "", kind: "projects", query: true, args: null });
  const plain = results.map(r => JSON.parse(JSON.stringify(r)));
  assert.deepEqual(plain[0], ["q1", true, null, { files: ["a"] }]);
  assert.deepEqual(plain[1], ["q2", false, "invalid arguments"]);
  assert.deepEqual(plain[2], ["a1", true]);
  assert.deepEqual(plain[3], ["a2", false, "image upload missing"]);
  assert.equal(plain[4][1], true, "a tab-less query needs no tab");
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [["look", [{ type: "image", data: "AAA", mimeType: "image/png" }]]]);
});

test("a desktop tab switch while an op awaits stops its side effect", async () => {
  const { view } = load();
  let active = "t1";
  let releaseBranches;
  const calls = [];
  const results = [];
  const bridge = {
    get activeSessionId() { return active; },
    activateSession: async () => {},
    remoteActionResult: async (...args) => results.push(JSON.parse(JSON.stringify(args))),
    gitBranches: () => new Promise(resolve => { releaseBranches = () => resolve({ ok: true, value: [{ name: "main", remote: false }] }); }),
    gitSwitchBranch: async (...args) => { calls.push(["switch", ...args]); return { ok: true, value: null }; },
    thinkingLevels: () => new Promise(resolve => { releaseBranches = () => resolve(["high"]); }),
    setThinkingLevel: async level => calls.push(["thinking", level]),
  };
  const status = { listening: true, devices: [{ id: "d", connected: true }] };
  const snapshotFor = () => snap({ activeSessionId: active });
  const handle = view.makeActionHandler(bridge, snapshotFor, () => status);

  const pending = handle({ reqId: "b1", deviceId: "d", tabId: "t1", kind: "gitSwitchBranch", args: { name: "main", remote: false } });
  while (!releaseBranches) await new Promise(r => setTimeout(r, 1));
  active = "t2"; // the desktop user switches A → B while the branch list loads
  releaseBranches();
  await pending;
  assert.deepEqual(calls, [], "no branch switch on tab B's project");
  assert.deepEqual(results.at(-1), ["b1", false, "tab not available"]);

  active = "t1"; releaseBranches = null;
  const pending2 = handle({ reqId: "k1", deviceId: "d", tabId: "t1", kind: "setThinking", args: { level: "high" } });
  while (!releaseBranches) await new Promise(r => setTimeout(r, 1));
  active = "t2";
  releaseBranches();
  await pending2;
  assert.deepEqual(calls, [], "no thinking change on tab B");
  assert.deepEqual(results.at(-1), ["k1", false, "tab not available"]);
});

test("branch and fork resolve the persisted entry by message timestamp and never guess", async () => {
  const { ops } = load();
  const calls = [];
  const tree = { entries: [
    { id: "e-user", kind: "user", ts: 1000, text: "fix it", inCurrent: true },
    { id: "e-old", kind: "user", ts: 1000, text: "other file", inCurrent: false },
    { id: "e-asst", kind: "assistant", ts: 2000, text: "done", inCurrent: true },
  ] };
  const bridge = {
    conversationTree: async () => ({ ok: true, value: tree }),
    branchAt: async id => { calls.push(["branch", id]); return { ok: true, text: "fix it" }; },
    forkAt: async id => { calls.push(["fork", id]); return { ok: true }; },
  };
  const s = snap({ messages: [
    { kind: "user", id: "user:1000", ts: 1000, text: "fix it" },
    { kind: "assistant", id: "assistant:2000", ts: 2000, text: "done" },
    { kind: "user", text: "no timestamp yet" },
  ] });
  const ctx = { bridge, deviceId: "d", tabId: "t1", snapshot: () => s, entry: () => s.sessions[0] };
  assert.deepEqual(own(await ops.run("branchAt", { entryId: "user:1000" }, null, ctx)), { text: "fix it" });
  await ops.run("forkAt", { entryId: "assistant:2000" }, null, ctx);
  assert.deepEqual(calls, [["branch", "e-user"], ["fork", "e-asst"]], "the entry of the current file, not the same-ts one of another");
  await assert.rejects(ops.run("branchAt", { entryId: "user:7" }, null, ctx), /unknown message/);
  await assert.rejects(ops.run("branchAt", { entryId: "user:2" }, null, ctx), /can’t be branched yet/);
  assert.equal(calls.length, 2, "an unresolved message never reaches omp");
  assert.deepEqual(own(await ops.run("branchAt", { entryId: "e-user" }, null, ctx)), { text: "fix it" }, "a real entry id of the current file is accepted as is");
});
