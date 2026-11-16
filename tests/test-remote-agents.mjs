#!/usr/bin/env node
// Phone Agents screens' pure logic (src/remote/agents-model.js): subagent status
// mapping and grouping by task call, totals and summary, number formatting, the
// plan summary, the task-card fallback and the subagent transcript mapper.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const A = require("../src/remote/agents-model.js");
const Icons = require("../src/remote/icons.js");
let passed = 0;
function check(label, fn) {
  try { fn(); } catch (err) { console.error(`FAILED: ${label}`); throw err; }
  passed++;
}

check("formatters: tokens, cost and duration", () => {
  assert.equal(A.fmtTokens(18200), "18.2k");
  assert.equal(A.fmtTokens(9400), "9.4k");
  assert.equal(A.fmtTokens(2000), "2k");
  assert.equal(A.fmtTokens(120000), "120k");
  assert.equal(A.fmtTokens(950), "950");
  assert.equal(A.fmtTokens(3_100_000), "3.1M");
  assert.equal(A.fmtTokens(undefined), null);
  assert.equal(A.fmtCost(0.211), "$0.21");
  assert.equal(A.fmtCost(0.021), "$0.021");
  assert.equal(A.fmtCost(0), "$0.00");
  assert.equal(A.fmtCost(null), null);
  assert.equal(A.fmtDuration(58000), "58s");
  assert.equal(A.fmtDuration(102000), "1m 42s");
  assert.equal(A.fmtDuration(130000), "2m 10s");
  assert.equal(A.fmtDuration(3_900_000), "1h 05m");
  assert.equal(A.fmtDuration(null), null);
});

check("status mapping: every status has an icon the phone set draws", () => {
  const cases = { running: "running", pending: "running", completed: "done", failed: "failed", aborted: "stopped", weird: "idle" };
  for (const [raw, id] of Object.entries(cases)) assert.equal(A.statusOf(raw).id, id, raw);
  for (const entry of Object.values(A.STATUS)) assert.ok(Icons.PATHS[entry.icon], `icon ${entry.icon}`);
});

const sub = (id, extra = {}) => ({ id, index: 0, agent: "explore", description: id, status: "running", parentToolCallId: "c1", startedAt: 1000, ...extra });

check("mapAgent: nested progress, flat fields, context share, live elapsed from the clock", () => {
  const a = A.mapAgent({ ...sub("x"), progress: { tokens: 18200, cost: 0.21, durationMs: 90000, contextTokens: 6, contextWindow: 10, currentTool: "grep", currentToolArgs: "on('close')" } }, 1000 + 102000);
  assert.equal(a.title, "explore · x");
  assert.equal(a.tokens, 18200);
  assert.equal(a.cost, 0.21);
  assert.equal(a.elapsed, 102000);
  assert.equal(a.context, 0.6);
  assert.equal(a.currentTool, "grep");
  assert.equal(a.callId, "c1");
  const done = A.mapAgent({ ...sub("y", { status: "completed", endedAt: 6000, tokens: 5 }) }, 99999);
  assert.equal(done.elapsed, 5000);
  assert.equal(done.tokens, 5);
  assert.equal(done.context, null);
  assert.equal(A.isLive(done), false);
});

check("build: groups by task call, nested agents follow their parent, header totals", () => {
  const view = {
    messages: [{ id: "c1", role: "tool", tool: { name: "task", summary: "Audit reconnect paths", output: "" } }],
    subagents: [
      sub("b", { index: 1, status: "completed", cost: 0.27 }),
      sub("a", { index: 0, cost: 0.21 }),
      sub("a.kid", { index: 0, status: "failed", cost: 0.1, parentToolCallId: "nested-call" }),
      sub("z", { index: 0, parentToolCallId: "c2", status: "aborted" }),
    ],
  };
  const built = A.build(view, 5000);
  assert.equal(built.source, "subagents");
  assert.equal(built.groups.length, 2);
  const [first, second] = built.groups;
  assert.equal(first.callId, "c1");
  assert.equal(first.title, "task · Audit reconnect paths");
  assert.deepEqual(first.rows.map(r => [r.agent.id, r.depth]), [["a", 0], ["a.kid", 1], ["b", 0]]);
  assert.equal(second.title, "task");
  assert.deepEqual(built.totals, { total: 4, running: 1, done: 1, failed: 1, stopped: 1, cost: 0.58, hasCost: true });
  assert.deepEqual(A.summaryParts(built.totals).map(p => p.text), ["1 running", "1 done", "1 failed", "1 stopped", "$0.58"]);
});

check("build: without view.subagents the task tool cards stand in, not actionable", () => {
  const view = {
    busy: true,
    messages: [
      { id: "m1", role: "user", text: "go" },
      { id: "t1", role: "tool", tool: { name: "task", summary: "Scan", output: "done text" } },
      { id: "t2", role: "tool", tool: { name: "bash", summary: "ls", output: "" } },
      { id: "t3", role: "tool", tool: { name: "task", summary: "Review", output: "" } },
    ],
  };
  const built = A.build(view, 0);
  assert.equal(built.source, "cards");
  assert.deepEqual(built.agents.map(a => [a.id, a.status.id, a.actionable]), [["t1", "done", false], ["t3", "running", false]]);
  assert.equal(built.groups.length, 2);
  assert.equal(A.build({ messages: [] }, 0).source, "none");
  assert.equal(A.build(null, 0).source, "none");
});

check("plan: counts done and abandoned as done, drops empty phases", () => {
  assert.equal(A.plan(undefined), null);
  assert.equal(A.plan([{ name: "Empty", tasks: [] }]), null);
  const plan = A.plan([
    { name: "Phase 1 · Protocol", tasks: [{ content: "Add resume frame", status: "completed" }, { content: "Old idea", status: "abandoned" }, { content: "Write tests", status: "in_progress" }, { content: "Docs", status: "pending" }] },
    { name: "Phase 2", tasks: [{ content: "", status: "pending" }, { content: "Ship", status: "bogus" }] },
  ]);
  assert.equal(plan.title, "Plan · 2 of 5 done");
  assert.deepEqual(plan.phases[0].tasks.map(t => t.state.id), ["done", "done", "active", "todo"]);
  assert.equal(plan.phases[0].tasks[1].abandoned, true);
  assert.equal(plan.phases[1].tasks.length, 1);
  assert.equal(plan.phases[1].tasks[0].state.id, "todo");
});

check("transcript: user/assistant text, tool calls and clipped results; thinking skipped; newest kept", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "find it" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Looking" }, { type: "toolCall", name: "grep", arguments: { pattern: "close", path: "src" } }] },
    { role: "toolResult", toolName: "grep", content: [{ type: "text", text: "1\n2\n3\n4\n5" }], isError: false },
    { role: "toolResult", toolName: "bash", content: "boom", isError: true },
    { role: "system", content: "ignored" },
  ];
  const { entries, hidden } = A.transcript(messages);
  assert.equal(hidden, 0);
  assert.deepEqual(entries.map(e => e.kind), ["user", "assistant", "call", "result", "result"]);
  assert.equal(entries[2].text, "pattern close · path src");
  assert.equal(entries[3].text, "1\n2\n3\n4");
  assert.equal(entries[3].more, true);
  assert.equal(entries[4].error, true);
  const cut = A.transcript(messages, 2);
  assert.equal(cut.hidden, 3);
  assert.equal(cut.entries.length, 2);
  assert.deepEqual(A.transcript(undefined), { entries: [], hidden: 0 });
});

console.log(`remote agents: ${passed} checks passed`);
