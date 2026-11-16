#!/usr/bin/env node
// Phone conversation tree (src/remote/tree-model.js) on top of the desktop's
// own model (app/conversation-tree.js, loaded the way the phone page loads it):
// rows, cache badges, branch tabs, lane geometry, detail lines, the Branch lock
// and the opaque session id of a tree file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const T = require("../src/remote/tree-model.js");
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const win = {};
const sandbox = { window: win, Date, Number, Math };
for (const file of ["app/conversation-tree-graph.js", "app/conversation-tree.js", "app/remote-view.js", "app/remote-ops.js"]) runInNewContext(read(`src/${file}`), sandbox);
const { buildModel } = win.OMP_CONV_TREE;

let passed = 0;
function check(label, fn) {
  try { fn(); } catch (err) { console.error(`FAILED: ${label}`); throw err; }
  passed++;
}

const MIN = 60000, T0 = Date.parse("2026-10-03T10:00:00Z");
const CUR = "s/2026-10-03T10-00-00-000Z_cur.jsonl", BR = "s/2026-10-03T11-00-00-000Z_b.jsonl";
const entry = o => ({ ts: null, at: null, text: null, agent: false, usage: null, firstKeptId: null, firstKeptExact: false, label: null, inCurrent: true, ...o });
const usage = (o = {}) => ({ input: 0, output: 10, cacheRead: 1000, cacheWrite: 100, ttl: 3600, costRead: 0.001, costWrite: 0.0004, ...o });
const user = (id, parentId, ts, text = id, o = {}) => entry({ id, parentId, kind: "user", ts, text, ...o });
const asst = (id, parentId, ts, o = {}) => entry({ id, parentId, kind: "assistant", ts, usage: usage(), text: `reply ${id}`, ...o });
const hhmm = ms => `t${ms}`;

// p1 → a1 → p2 → a2 (current), and a side branch p1 → a1 → p3 → a3 (another file).
const tree = {
  files: [
    { path: CUR, cwd: null, title: null, leafId: "a2", current: true },
    { path: BR, cwd: null, title: "Storage try", leafId: "a3", current: false },
  ],
  entries: [
    user("p1", null, T0, "Login redirect loops\nafter token refresh"),
    asst("a1", "p1", T0 + 1000),
    user("p2", "a1", T0 + 10 * MIN, "Run the whole auth suite"),
    asst("a2", "p2", T0 + 10 * MIN + 1000),
    user("p3", "a1", T0 + 20 * MIN, "Use the OS keychain", { inCurrent: false }),
    asst("a3", "p3", T0 + 20 * MIN + 1000, { inCurrent: false }),
  ],
};
const now = T0 + 25 * MIN;

check("prepare: rows in order with ordinals, one-line text, cache chip and price", () => {
  const view = T.prepare(tree, { now, buildModel, hhmm });
  const prompts = view.rows.filter(r => r.kind === "prompt");
  assert.equal(prompts.length, 3);
  assert.equal(view.prompts, 3);
  assert.equal(prompts[0].text, "Login redirect loops after token refresh");
  assert.match(prompts[0].fullText, /\n/);
  assert.ok(["warm", "expiring", "partial", "cold", "unknown"].includes(prompts[0].chip.state));
  for (const p of prompts) assert.ok(p.chip.text && p.chip.glyph);
  assert.ok(view.lanes >= 2, "a fork needs a second lane");
});

check("prepare: branch tabs list Current first, then the other tip with its file title and prompt count", () => {
  const view = T.prepare(tree, { now, buildModel, hhmm });
  assert.equal(view.branches[0].label, "Current");
  assert.equal(view.branches[0].current, true);
  assert.equal(view.branches.length, 2);
  assert.equal(view.branches[1].label, "Storage try");
  assert.equal(view.branches[1].count, 1);
  assert.equal(view.branchCount, 2);
  const tips = view.rows.filter(r => r.currentTip || r.branchHead);
  assert.deepEqual(tips.map(r => [r.id, r.currentTip, r.branchHead]).sort(), [["p2", true, false], ["p3", false, true]]);
  const head = tips.find(r => r.id === "p3");
  assert.equal(head.openFile, BR);
  assert.equal(head.sessionId, T.opaqueId(BR));
  assert.equal(view.rows.find(r => r.id === "p2").sessionId, null);
});

check("opaqueId matches the desktop's remote-ops opaqueId", () => {
  for (const path of ["D:\\Users\\me\\.omp\\sessions\\2026-10-03T10-00-00-000Z_cur.jsonl", "/home/me/a b/ü.jsonl", ""]) {
    assert.equal(T.opaqueId(path), win.OMP_REMOTE_OPS.opaqueId(path));
  }
});

check("prepare: a compaction row and an unusable tree", () => {
  const withCompaction = {
    files: [{ path: CUR, cwd: null, title: null, leafId: "a2", current: true }],
    entries: [
      user("p1", null, T0), asst("a1", "p1", T0 + 1000),
      entry({ id: "c1", parentId: "a1", kind: "compaction", ts: T0 + 5000, firstKeptId: "p1", firstKeptExact: true }),
      user("p2", "c1", T0 + 6000), asst("a2", "p2", T0 + 7000),
    ],
  };
  const view = T.prepare(withCompaction, { now, buildModel, hhmm });
  assert.deepEqual(view.rows.map(r => r.kind), ["prompt", "compaction", "prompt"]);
  assert.equal(view.rows[1].label, `Compacted · t${T0 + 5000}`);
  assert.equal(T.prepare(null, { now, buildModel }), null);
  assert.equal(T.prepare({ files: [] }, { now, buildModel }), null);
  const empty = T.prepare({ files: [], entries: [] }, { now, buildModel });
  assert.deepEqual([empty.rows.length, empty.branches.length], [0, 0]);
});

check("cacheChip: minutes left for warm and expiring, plain words otherwise", () => {
  assert.deepEqual(T.cacheChip("warm", now + 22 * MIN - 1, now), { state: "warm", glyph: "●", text: "warm · 22 min" });
  assert.equal(T.cacheChip("expiring", now + 6 * MIN, now).text, "expiring · 6 min");
  assert.equal(T.cacheChip("cold", null, now).text, "cold");
  assert.equal(T.cacheChip("partial", now + MIN, now).text, "partial");
  assert.equal(T.cacheChip("warm", now - 1, now).text, "warm");
  assert.deepEqual(T.cacheChip("???", null, now), { state: "unknown", glyph: "?", text: "unknown" });
});

check("detail: cache sentence and the price against a cold re-ask", () => {
  const warm = T.detail({ kind: "prompt", state: "warm", until: now + 24 * MIN, price: 0.03, coldPrice: 0.29 }, now);
  assert.deepEqual(warm, { cache: "Cache warm for 24 more min", now: "~$0.03", cold: "~$0.29", coldOnly: false });
  const cold = T.detail({ kind: "prompt", state: "cold", until: null, price: 0.29, coldPrice: 0.29 }, now);
  assert.deepEqual(cold, { cache: "Cache cold", now: "~$0.29", cold: null, coldOnly: true });
  assert.equal(T.detail({ kind: "prompt", state: "partial", anchorOrdinal: 15, price: 0.1, coldPrice: 0.3 }, now).cache, "Cache warm up to prompt #15");
  assert.equal(T.detail({ kind: "prompt", state: "unknown", price: null, coldPrice: null }, now).now, null);
  assert.equal(T.detail({ kind: "compaction" }, now), null);
  assert.equal(T.money(0.001), "<$0.01");
});

check("geometry: segments and curves land on lane x positions inside the 46 px gutter", () => {
  assert.equal(T.laneX(0, 1), 12);
  assert.equal(T.laneX(1, 2), 34);
  assert.equal(T.laneX(3, 4), 34, "four lanes squeeze into the same gutter");
  assert.ok(T.laneX(3, 4) <= 46);
  const paths = T.geometry({ segments: [{ lane: 0, part: "top", state: "warm" }, { lane: 0, part: "bottom", state: "warm" }, { lane: 1, part: "full", state: "cold" }], curves: [{ fromLane: 0, toLane: 1, state: "warm" }] }, 2);
  assert.deepEqual(paths.map(p => p.d), ["M12 0V31", "M12 31V62", "M34 0V62", "M12 40C12 52 34 50 34 62"]);
  assert.equal(paths[3].curve, true);
  assert.equal(paths[2].color, "var(--lilac)");
  assert.deepEqual(T.geometry(undefined, 1), []);
  assert.deepEqual([0, 1, 2, 3].map(T.laneShape), ["dot", "ring", "diamond", "ring"]);
});

check("branchLock: manage and idle may branch; each other state says why", () => {
  assert.equal(T.branchLock({ scope: "manage", can: true, busy: false }), null);
  assert.equal(T.branchLock({ scope: "manage", can: true, busy: true }).text, "Branching is available when the agent is idle.");
  assert.equal(T.branchLock({ scope: "view", can: false }).text, "View only. Branching needs Manage scope, set on the desktop.");
  assert.match(T.branchLock({ scope: "control", can: false }).text, /Control\. Branching needs Manage/);
  assert.match(T.branchLock({ scope: "control", legacy: true, can: false }).text, /too old/);
  assert.equal(T.subtitle("fix-auth-flow", 41, 3), "fix-auth-flow · 41 prompts · 3 branches");
  assert.equal(T.subtitle("", 1, 1), "1 prompt · 1 branch");
});

console.log(`remote tree: ${passed} checks passed`);
