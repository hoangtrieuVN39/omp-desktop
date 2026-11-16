#!/usr/bin/env node
// Review tab view-model (src/remote/review-model.js): status view → rows,
// accepted-file memory, PR card, branches, file browser rows, error kinds.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const own = value => JSON.parse(JSON.stringify(value));
const deepEq = (actual, expected) => assert.deepEqual(own(actual), own(expected));

const ctx = {};
runInNewContext(readFileSync(new URL("../src/remote/review-model.js", import.meta.url), "utf8"), ctx);
const R = ctx.OMP_REMOTE_REVIEW;

const file = (path, status = null) => ({ name: path.split("/").pop(), path, dir: false, status, changed: 0, children: [] });
const dir = (path, children) => ({ name: path.split("/").pop(), path, dir: true, status: null, changed: 0, children });
const tree = () => dir("", [
  dir("src", [dir("src/remote", [file("src/remote/ws.ts", "Modified"), file("src/remote/old.js", "Deleted"), file("src/remote/keep.js")]), file("src/main.rs", "Added")]),
  dir("tests", [file("tests/t.mjs", "Untracked")]),
  file("README.md", "Renamed"),
  file("Cargo.toml"),
]);
const view = (extra = {}) => ({ repo: { name: "omp", branch: "main", head: "abcdef0123", ahead: null, behind: null }, tree: tree(), changed: 5, truncated: false, folder: "", ...extra });

test("changeList flattens the tree to changed files ordered M, A, R, D, U", () => {
  const { files, accepted, total } = R.changeList(view(), R.createAccepted());
  deepEq(files.map(f => f.kind.code), ["M", "A", "R", "D", "U"]);
  deepEq(files.map(f => f.path), ["src/remote/ws.ts", "src/main.rs", "README.md", "src/remote/old.js", "tests/t.mjs"]);
  assert.equal(total, 5);
  assert.equal(accepted.length, 0);
});

test("rows carry name, directory and the design's sub line", () => {
  const rows = R.changeList(view(), R.createAccepted()).files;
  const ws = rows.find(r => r.name === "ws.ts");
  assert.equal(ws.dir, "src/remote/");
  assert.equal(ws.sub, "src/remote/ · modified");
  assert.equal(rows.find(r => r.name === "README.md").sub, "renamed");
  assert.equal(rows.find(r => r.name === "t.mjs").sub, "tests/ · untracked");
});

test("a clean or missing status gives no rows", () => {
  assert.equal(R.changeList(view({ tree: dir("", [file("a.txt")]) }), R.createAccepted()).files.length, 0);
  assert.equal(R.changeList(null, R.createAccepted()).total, 0);
});

test("unknown statuses are ignored", () => {
  const odd = view({ tree: dir("", [file("a", "Weird"), file("b", "Modified")]) });
  deepEq(R.changeList(odd, R.createAccepted()).files.map(f => f.path), ["b"]);
});

test("accepted files move out of the list while their status holds and are forgotten after", () => {
  const acc = R.createAccepted();
  acc.mark("src/remote/ws.ts", "Modified");
  let list = R.changeList(view(), acc);
  deepEq(list.accepted.map(f => f.path), ["src/remote/ws.ts"]);
  assert.equal(list.files.length, 4);
  assert.equal(list.total, 5);
  // The file turns up with another status: back in the list, entry dropped.
  const other = view({ tree: dir("", [file("src/remote/ws.ts", "Deleted")]) });
  list = R.changeList(other, acc);
  assert.equal(list.accepted.length, 0);
  assert.equal(list.files.length, 1);
  assert.equal(acc.size(), 0);
  // A file that left the status (committed) is dropped too.
  acc.mark("gone.txt", "Modified");
  R.changeList(view(), acc);
  assert.equal(acc.size(), 0);
});

test("discardDeletes mirrors the desktop rule", () => {
  for (const s of ["Untracked", "Added", "Renamed"]) assert.equal(R.discardDeletes(s), true, s);
  for (const s of ["Modified", "Deleted", null]) assert.equal(R.discardDeletes(s), false, String(s));
});

test("branchLabel names the branch or the detached head", () => {
  deepEq(R.branchLabel({ branch: "feat/x" }), { text: "feat/x", detached: false });
  deepEq(R.branchLabel({ branch: null, head: "0123456789ab" }), { text: "detached 0123456", detached: true });
  assert.equal(R.branchLabel({ branch: null, head: null }).text, "no commits yet");
});

test("classifyError tells not-a-repo, offline, no tab and the rest apart", () => {
  const c = e => R.classifyError(e);
  assert.equal(c(new Error("not a git repository: could not find a repository")), "not-repo");
  assert.equal(c(new Error("this tab has no project folder")), "no-folder");
  assert.equal(c({ code: "no-tab", message: "x" }), "no-tab");
  assert.equal(c({ code: "disconnected", message: "not connected" }), "offline");
  assert.equal(c({ code: "unsupported", message: "x" }), "unsupported");
  assert.equal(c(new Error("boom")), "error");
});

test("isBusy reads the tab list and the viewed tab's frame", () => {
  const state = { tabs: [{ id: "a", busy: false }, { id: "b", busy: true }], view: { tabId: "a", busy: false } };
  assert.equal(R.isBusy(state, "a"), false);
  assert.equal(R.isBusy(state, "b"), true);
  assert.equal(R.isBusy({ ...state, view: { tabId: "a", busy: true } }, "a"), true);
  assert.equal(R.isBusy({ tabs: [] }, "a"), false);
});

test("prCard orders checks failing first, words the state, caps the pills", () => {
  const snapshot = { number: 142, title: "Remote v2", url: "u", additions: 412, deletions: 88, isDraft: false,
    checks: [{ name: "build", state: "success" }, { name: "tests", state: "failure" }, { name: "clippy", state: "running" }, { name: "lint", state: "neutral" }] };
  const card = R.prCard(snapshot);
  assert.equal(card.number, 142);
  assert.equal(card.additions, 412);
  deepEq(card.pills.map(p => p.label), ["tests · failed", "clippy · running", "build", "lint · skipped"]);
  deepEq(card.pills.map(p => p.icon), ["close", "st-running", "check", "st-idle"]);
  const many = R.prCard({ ...snapshot, checks: Array.from({ length: 9 }, (_, i) => ({ name: `c${i}`, state: "success" })) });
  assert.equal(many.pills.length, 6);
  assert.equal(many.more, 3);
});

test("prCard is null for no PR and for a stale answer", () => {
  assert.equal(R.prCard(null), null);
  assert.equal(R.prCard({ stale: true }), null);
  assert.equal(R.prIsStale({ stale: true }), true);
  assert.equal(R.prIsStale(null), false);
  assert.equal(R.prIsStale({ number: 1 }), false);
});

test("prErrorCopy explains a missing gh and passes other errors on", () => {
  assert.match(R.prErrorCopy(new Error("gh not found on PATH")), /GitHub CLI/);
  assert.equal(R.prErrorCopy(new Error("rate limited")), "rate limited");
});

test("branchGroups splits local from remote and filters by every word", () => {
  const list = [{ name: "feat/a", remote: false, at: 3 }, { name: "origin/feat/b", remote: true, at: 2 }, { name: "fix/a", remote: false, at: 1 }];
  const all = R.branchGroups(list, "");
  deepEq(all.local.map(b => b.name), ["feat/a", "fix/a"]);
  deepEq(all.remote.map(b => b.name), ["origin/feat/b"]);
  deepEq(R.branchGroups(list, "FEAT").local.map(b => b.name), ["feat/a"]);
  deepEq(R.branchGroups(list, "a fix").local.map(b => b.name), ["fix/a"]);
  deepEq(R.branchGroups(null, "x"), { local: [], remote: [] });
});

test("browseRows lists a folder, or searches every file by path", () => {
  const t = tree();
  deepEq(R.browseRows(t, "", "").rows.map(n => n.name), ["src", "tests", "README.md", "Cargo.toml"]);
  deepEq(R.browseRows(t, "src/remote", "").rows.map(n => n.name), ["ws.ts", "old.js", "keep.js"]);
  assert.equal(R.browseRows(t, "nope/here", "").missing, true);
  const hit = R.browseRows(t, "", "remote js");
  assert.equal(hit.searching, true);
  deepEq(hit.rows.map(n => n.path), ["src/remote/old.js", "src/remote/keep.js"]);
  const capped = R.browseRows(t, "", "s", 2);
  assert.equal(capped.rows.length, 2);
  assert.ok(capped.more > 0);
});

test("formatBytes and splitPath", () => {
  assert.equal(R.formatBytes(512), "512 B");
  assert.equal(R.formatBytes(2048), "2.0 KB");
  assert.equal(R.formatBytes(3 * 1048576), "3.0 MB");
  deepEq(R.splitPath("a/b/c.ts"), { dir: "a/b/", name: "c.ts" });
  deepEq(R.splitPath("c.ts"), { dir: "", name: "c.ts" });
});

test("empty copy names the branch", () => {
  assert.equal(R.clean("main"), "No changes. Working tree is clean on main.");
  assert.equal(R.clean(""), "No changes. Working tree is clean.");
});

test("prCard ignores anything that is not a pull request snapshot", async () => {
  const R = (await import("node:module")).createRequire(import.meta.url)("../src/remote/review-model.js");
  for (const value of [null, undefined, [], {}, { title: "no number" }, { stale: true }, "x"]) assert.equal(R.prCard(value), null, JSON.stringify(value));
  assert.equal(R.prCard({ number: 142, title: "Remote v2", checks: [] }).number, 142);
});
