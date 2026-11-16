#!/usr/bin/env node
// Phone Usage / Approvals / Export screens' pure logic (src/remote/info-model.js):
// dashboard stats → KPIs and bars, approval mode of a project, rule rows, the
// switch-mode confirmation copy, the export result and download error copy.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const I = require("../src/remote/info-model.js");
let passed = 0;
function check(label, fn) {
  try { fn(); } catch (err) { console.error(`FAILED: ${label}`); throw err; }
  passed++;
}

const stats = {
  overall: { totalRequests: 412, totalInputTokens: 1_000_000, totalOutputTokens: 2_100_000, totalCost: 14.2, avgTokensPerSecond: 67.6, unpricedRequests: 3 },
  byModel: [{ model: "gpt-codex", totalRequests: 5, totalCost: 0.83 }, { model: "claude-opus", totalRequests: 300, totalCost: 11.06 }, { model: "claude-sonnet", totalRequests: 107, totalCost: 2.31 }],
  byFolder: [{ folder: "D:\\code\\omp-desktop", totalRequests: 9, totalCost: 9.1 }, { folder: "/home/me/api-server", totalRequests: 1, totalCost: 0.001 }],
  byAgentType: [{ agentType: "main", totalRequests: 291, totalCost: 10.4 }, { agentType: "subagent", totalRequests: 121, totalCost: 3.8 }, { agentType: "custom", totalRequests: 1, totalCost: 0 }],
};

check("usage: KPIs, bars sorted by cost with shares, folders by name only, agent labels", () => {
  const u = I.usage(stats);
  assert.equal(u.empty, false);
  assert.deepEqual(u.kpis.map(k => [k.label, k.value, k.unit ?? ""]), [["Cost", "$14.20", ""], ["Requests", "412", ""], ["Tokens", "3.1M", ""], ["Speed", "68", "tok/s"]]);
  assert.deepEqual(u.models.map(m => [m.label, m.cost, m.pct]), [["claude-opus", "$11.06", 78], ["claude-sonnet", "$2.31", 16], ["gpt-codex", "$0.83", 6]]);
  assert.deepEqual(u.folders.map(f => f.label), ["omp-desktop", "api-server"]);
  assert.equal(u.folders[1].pct, 2, "a non-zero cost is never an invisible bar");
  assert.deepEqual(u.agents.map(a => [a.label, a.detail]), [["Main agents", "291 req · $10.40"], ["Subagents", "121 req · $3.80"], ["custom", "1 req · $0.00"]]);
  assert.equal(u.unpriced, 3);
});

check("usage: no requests or no overall is empty; missing speed reads as a dash", () => {
  assert.equal(I.usage(null).empty, true);
  assert.equal(I.usage({ overall: { totalRequests: 0 } }).empty, true);
  const u = I.usage({ overall: { totalRequests: 1, totalCost: 0, avgTokensPerSecond: null }, byModel: undefined });
  assert.equal(u.kpis[3].value, "—");
  assert.equal(u.kpis[3].unit, "");
  assert.deepEqual(u.models, []);
  assert.equal(u.models.length + u.folders.length + u.agents.length, 0);
});

check("projectMode: override matched by folder name, else default; ambiguity falls back", () => {
  const view = { default: "write", projects: { "D:\\code\\omp-desktop": "yolo", "D:\\code\\other": "always-ask" } };
  assert.deepEqual(I.projectMode(view, "omp-desktop"), { mode: "yolo", source: "project", ambiguous: false });
  assert.deepEqual(I.projectMode(view, "nope"), { mode: "write", source: "default", ambiguous: false });
  const twin = { default: "write", projects: { "/a/app": "yolo", "/b/app": "always-ask" } };
  assert.deepEqual(I.projectMode(twin, "app"), { mode: "write", source: "default", ambiguous: true });
  assert.deepEqual(I.projectMode(null, "x"), { mode: "write", source: "default", ambiguous: false });
  assert.equal(I.projectMode({ default: "bogus", projects: {} }, "x").mode, "write");
});

check("whenLabel: today, yesterday, this year, other year, unknown", () => {
  const now = new Date(2026, 10, 16, 18, 0).getTime();
  assert.equal(I.whenLabel(new Date(2026, 10, 16, 14, 20).toISOString(), now), "today 14:20");
  assert.equal(I.whenLabel(new Date(2026, 10, 15, 9, 5).toISOString(), now), "yesterday 09:05");
  assert.equal(I.whenLabel(new Date(2026, 10, 12, 9, 5).toISOString(), now), "12 Nov");
  assert.equal(I.whenLabel(new Date(2025, 0, 3, 9, 5).toISOString(), now), "3 Jan 2025");
  assert.equal(I.whenLabel("not a date", now), "");
});

check("rules: newest first, scope in the detail, malformed entries dropped", () => {
  const now = new Date(2026, 10, 16, 18, 0).getTime();
  const rows = I.rules([
    { tool: "write", scope: "project", grantedAt: new Date(2026, 10, 9, 8, 0).toISOString() },
    { tool: "bash", scope: "session", grantedAt: new Date(2026, 10, 16, 14, 20).toISOString() },
    { tool: 5, scope: "project" }, null,
  ], now);
  assert.deepEqual(rows.map(r => [r.tool, r.scope, r.detail]), [["bash", "session", "This session · today 14:20"], ["write", "project", "Always, this project · 9 Nov"]]);
  assert.notEqual(rows[0].key, rows[1].key);
  assert.deepEqual(I.rules(undefined), []);
});

check("modeConfirm: names project, tab and mode; yolo adds the warning", () => {
  const yolo = I.modeConfirm("omp-desktop", "yolo", "refactor-remote-ws");
  assert.equal(yolo.title, "Switch omp-desktop to Yolo?");
  assert.match(yolo.body, /refactor-remote-ws restarts with the new mode as soon as it’s idle\. Nothing will ask/);
  assert.equal(yolo.confirmLabel, "Switch and restart when idle");
  assert.doesNotMatch(I.modeConfirm("p", "write", "t").body, /Nothing will ask/);
  assert.equal(I.modeLabel("always-ask"), "Always ask");
});

check("export: result validation and download error copy", () => {
  assert.deepEqual(I.exportResult({ downloadId: "ab_12-Z", name: "s.html" }), { downloadId: "ab_12-Z", name: "s.html" });
  assert.equal(I.exportResult({ downloadId: "ab_12-Z" }).name, "export.html");
  assert.equal(I.exportResult({ downloadId: "../etc" }), null);
  assert.equal(I.exportResult(undefined), null);
  assert.equal(I.downloadError({ code: "not-found" }).again, true);
  assert.equal(I.downloadError({ code: "forbidden" }).again, false);
  assert.equal(I.downloadError({ code: "cancelled" }).text, "Download cancelled. Export again to get another copy.");
  assert.equal(I.downloadError({ message: "boom" }).text, "boom");
});

console.log(`remote info: ${passed} checks passed`);
