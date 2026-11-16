#!/usr/bin/env node
// Phone view-model: tab grouping and status, relative times, saved/project
// search, scope gating (incl. legacy desktops), connection phases and banners,
// error mapping, push and pairing states, accent contrast, icon table.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const M = require("../src/remote/view-model.js");
const P = require("../src/remote/protocol.js");
const Icons = require("../src/remote/icons.js");
let passed = 0;
function check(label, fn) {
  try { fn(); } catch (err) { console.error(`FAILED: ${label}`); throw err; }
  passed++;
}

check("statusOf: a question beats running, then optional error/finished, else idle", () => {
  assert.equal(M.statusOf({ hasAsk: true, busy: true }).id, "waiting");
  assert.equal(M.statusOf({ busy: true }).id, "running");
  assert.equal(M.statusOf({ status: "error" }).id, "error");
  assert.equal(M.statusOf({ status: "finished" }).id, "finished");
  assert.equal(M.statusOf({}).id, "idle");
  assert.equal(M.statusOf(undefined).id, "idle");
  for (const status of Object.values(M.STATUS)) assert.ok(Icons.PATHS[status.icon], `icon ${status.icon}`);
});
check("groupTabs: waiting block first, open tabs ranked running > finished > error > idle, stable", () => {
  const tabs = [
    { id: "a", busy: false }, { id: "b", hasAsk: true }, { id: "c", busy: true },
    { id: "d", status: "error" }, { id: "e" }, { id: "f", busy: true }, { id: "g", status: "finished" },
  ];
  const groups = M.groupTabs(tabs);
  assert.deepEqual(groups.waiting.map(t => t.id), ["b"]);
  assert.deepEqual(groups.open.map(t => t.id), ["c", "f", "g", "d", "a", "e"]);
  assert.equal(groups.total, 7);
  assert.deepEqual(M.groupTabs(undefined), { waiting: [], open: [], total: 0 });
});
check("relativeTime: minutes, hours, yesterday, days, dates; unknown input is empty", () => {
  const now = new Date(2026, 10, 16, 15, 0, 0).getTime();
  const ago = ms => now - ms;
  assert.equal(M.relativeTime(ago(10_000), now), "now");
  assert.equal(M.relativeTime(ago(2 * 60_000), now), "2m");
  assert.equal(M.relativeTime(ago(5 * 3600_000), now), "5h");
  assert.equal(M.relativeTime(new Date(2026, 10, 15, 9, 0).getTime(), now), "Yesterday");
  assert.equal(M.relativeTime(new Date(2026, 10, 13, 9, 0).getTime(), now), "3d");
  assert.equal(M.relativeTime(new Date(2026, 9, 12, 9, 0).toISOString(), now), "12 Oct");
  assert.equal(M.relativeTime(new Date(2025, 10, 12, 9, 0).toISOString(), now), "12 Nov 2025");
  assert.equal(M.relativeTime(Math.floor(ago(120_000) / 1000), now), "2m", "epoch seconds");
  assert.equal(M.relativeTime("not a date", now), "");
  assert.equal(M.relativeTime(null, now), "");
  assert.equal(M.relativeTime(now + 5000, now), "now", "a clock-skewed future time never goes negative");
});
check("filterSaved needs every word in title, project or preview; empty query keeps all", () => {
  const list = [{ title: "Tailscale relay latency", project: "omp-desktop" }, { title: "Push payload privacy", project: "omp-desktop", preview: "no transcript" }, { title: "Docs", project: "site" }];
  assert.equal(M.filterSaved(list, "").length, 3);
  assert.deepEqual(M.filterSaved(list, " RELAY desk ").map(i => i.title), ["Tailscale relay latency"]);
  assert.deepEqual(M.filterSaved(list, "transcript").map(i => i.title), ["Push payload privacy"]);
  assert.equal(M.filterSaved(list, "zzz").length, 0);
  assert.deepEqual(M.filterProjects([{ name: "api-server" }, { name: "docs" }], "API").map(p => p.name), ["api-server"]);
});
check("projectDetail counts open tabs of the project", () => {
  const tabs = [{ project: "api" }, { project: "api" }, { project: "docs" }];
  assert.equal(M.projectDetail({ name: "api" }, tabs), "Recent · 2 open tabs");
  assert.equal(M.projectDetail({ name: "docs" }, tabs), "Recent · 1 open tab");
  assert.equal(M.projectDetail({ name: "x", open: true }, []), "Open on the desktop");
  assert.equal(M.projectDetail({ name: "x" }, []), "Recent project");
});
check("gate: scope levels from the protocol table; the lock label names the needed scope", () => {
  const at = scope => ({ connected: true, legacy: false, scope });
  assert.equal(M.gate(at("view"), "prompt").ok, false);
  assert.equal(M.gate(at("view"), "prompt").label, "Needs Control");
  assert.equal(M.gate(at("control"), "answer").ok, true);
  assert.equal(M.gate(at("control"), "newTab").label, "Needs Manage");
  assert.equal(M.gate(at("manage"), "closeTab").ok, true);
  assert.equal(M.gate(at("manage"), "nope").reason, "unknown");
  assert.equal(M.gate({ connected: false, scope: "manage" }, "prompt").reason, "offline");
  for (const kind of Object.keys(P.ACTIONS)) {
    const need = P.ACTIONS[kind];
    assert.equal(M.gate(at(need), kind).ok, true, kind);
    if (need !== "view") assert.equal(M.gate(at("view"), kind).ok, false, kind);
  }
});
check("gate on a legacy desktop: control with the five old actions only", () => {
  const legacy = { connected: true, legacy: true, scope: "control" };
  for (const kind of P.LEGACY_ACTIONS) assert.equal(M.gate(legacy, kind).ok, true, kind);
  assert.equal(M.gate(legacy, "closeTab").ok, false);
  assert.equal(M.gate(legacy, "closeTab").reason, "legacy");
  assert.match(M.lockMessage(legacy, M.gate(legacy, "closeTab"), "Closing"), /too old/);
});
check("lockMessage follows the copy deck", () => {
  const conn = { connected: true, scope: "control" };
  assert.equal(M.lockMessage(conn, M.gate(conn, "gitAccept"), "Accepting files"), "This phone has Control. Accepting files needs Manage — change it on the desktop.");
  const view = { connected: true, scope: "view" };
  assert.equal(M.lockMessage(view, M.gate(view, "prompt"), "Sending"), M.COPY.scopeView);
});
check("phaseAfterClose: revoked, offline after retries or a not-ready desktop, else reconnecting", () => {
  assert.equal(M.phaseAfterClose({ code: 4401, attempt: 0, hadConnection: true }), "revoked");
  assert.equal(M.phaseAfterClose({ code: 1006, attempt: 0, hadConnection: true }), "reconnecting");
  assert.equal(M.phaseAfterClose({ code: 1006, attempt: 3, hadConnection: true }), "offline");
  assert.equal(M.phaseAfterClose({ code: 4503, attempt: 0, hadConnection: true }), "offline");
  assert.equal(M.phaseAfterClose({ code: 1006, attempt: 1, hadConnection: false }), "offline");
  assert.equal(M.phaseAfterClose({ code: 1006, attempt: 0, hadConnection: false }), "reconnecting");
});
check("bannerFor and connectionView map every phase", () => {
  assert.equal(M.bannerFor({ phase: "connected" }), null);
  assert.equal(M.bannerFor({ phase: "unpaired" }), null);
  assert.equal(M.bannerFor({ phase: "reconnecting" }).spin, true);
  const at = new Date(2026, 10, 16, 14, 2).getTime();
  const offline = M.bannerFor({ phase: "offline", lastSeenAt: at });
  assert.equal(offline.text, "Desktop offline · showing 14:02");
  assert.equal(offline.action, "Retry");
  assert.equal(M.bannerFor({ phase: "offline" }).text, "Desktop offline");
  assert.equal(M.bannerFor({ phase: "revoked" }).tone, "error");
  for (const phase of ["connected", "connecting", "reconnecting", "offline", "revoked", "unpaired"]) {
    const view = M.connectionView({ phase, tabCount: 4, lastSeenAt: at });
    assert.ok(view.label && view.body, phase);
  }
  assert.match(M.connectionView({ phase: "connected", tabCount: 1 }).body, /1 open tab\./);
  assert.match(M.connectionView({ phase: "offline", lastSeenAt: at }).body, /14:02/);
});
check("hostName and deviceLabel", () => {
  assert.equal(M.hostName("dmm.tail3c2935.ts.net"), "dmm");
  assert.equal(M.hostName("dmm.tail3c2935.ts.net:7470"), "dmm");
  assert.equal(M.hostName("192.168.1.5"), "192.168.1.5");
  assert.equal(M.hostName(""), "Desktop");
  assert.equal(M.deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7)"), "iPhone");
  assert.equal(M.deviceLabel("Mozilla/5.0 (Windows NT 10.0)"), "Browser");
  assert.equal(M.deviceLabel(""), "This phone");
});
check("errorFeedback maps request failures to toasts with their retry", () => {
  const e = (code, message) => Object.assign(new Error(message), { code });
  assert.deepEqual(M.errorFeedback(e("timeout", "desktop did not answer")), { text: "Desktop didn’t answer", tone: "error", retry: "Retry" });
  assert.equal(M.errorFeedback(e("remote", "expired")).retry, "Send again");
  assert.equal(M.errorFeedback(e("busy", "busy")).retry, null);
  assert.equal(M.errorFeedback(e("remote", "not allowed")).tone, "lock");
  assert.equal(M.errorFeedback(e("disconnected", "connection lost")).text, M.COPY.opOffline);
  const git = M.errorFeedback(e("remote", "git: error: local changes would be overwritten"));
  assert.equal(git.mono, true);
  assert.equal(git.text, "git: error: local changes would be overwritten");
});
check("pushState covers install, support, key, pending and enabled", () => {
  const base = { installed: true, supported: true, key: "k", enabled: false, pending: false };
  assert.equal(M.pushState(base), "off");
  assert.equal(M.pushState({ ...base, key: undefined }), "no-key");
  assert.equal(M.pushState({ ...base, pending: true }), "pending");
  assert.equal(M.pushState({ ...base, enabled: true }), "on");
  assert.equal(M.pushState({ ...base, installed: false }), "needs-install");
  assert.equal(M.pushState({ ...base, supported: false }), "unavailable");
});
check("pairError copy and POST /pair status mapping", () => {
  assert.equal(M.pairFailureKind(410), "expired");
  assert.equal(M.pairFailureKind(429), "limited");
  assert.equal(M.pairFailureKind(0), "network");
  assert.match(M.pairError("camera", true).body, /iOS Settings/);
  assert.match(M.pairError("camera", false).body, /browser settings/);
  assert.equal(M.pairError("wrong").title, "That QR isn’t from this desktop");
  assert.equal(M.pairError("bogus"), null);
});
check("onAccent picks the readable text colour", () => {
  assert.equal(M.onAccent("#8AF0C8"), "#0B0D12");
  assert.equal(M.onAccent("#3F4FD9"), "#FFFFFF");
  assert.equal(M.onAccent("#fff"), "#0B0D12");
  assert.equal(M.onAccent("rebeccapurple"), null);
  assert.equal(M.onAccent(undefined), null);
});
check("scopeSummary has a sentence for every scope", () => {
  for (const scope of ["view", "control", "manage"]) assert.ok(M.scopeSummary(scope).length > 10);
  assert.equal(M.scopeSummary("bogus"), M.scopeSummary("view"));
});
check("icon table: names used by the screens exist; register adds without overriding", () => {
  const src = ["sessions", "connection-screen", "pairing", "new-session", "session-menu", "profile-switch", "ui-shell", "ui-sheet", "ui-feedback", "ui-parts"]
    .map(f => readFileSync(fileURLToPath(new URL(`../src/remote/${f}.js`, import.meta.url)), "utf8")).join("\n");
  const names = new Set([...src.matchAll(/(?:\bicon\(\s*|\bicon:\s*|\biconName:\s*)["']([a-z][a-z-]+)["']/g)].map(m => m[1]));
  for (const name of names) assert.ok(Icons.PATHS[name], `icon ${name} is not in icons.js`);
  assert.equal(Icons.register("custom-test", "M0 0h1"), true);
  assert.equal(Icons.register("custom-test", "M9 9h9"), false);
  assert.equal(Icons.PATHS["custom-test"], "M0 0h1");
  assert.equal(Icons.register("x", 3), false);
  delete Icons.PATHS["custom-test"];
});

console.log(`test-remote-model: ${passed} checks passed`);
