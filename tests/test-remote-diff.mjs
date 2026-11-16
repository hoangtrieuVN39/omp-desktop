#!/usr/bin/env node
// Diff screen view-model (src/remote/diff-model.js): file view → rows with
// folded unchanged runs, jump targets, states and the reject copy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const own = value => JSON.parse(JSON.stringify(value));
const deepEq = (actual, expected) => assert.deepEqual(own(actual), own(expected));

const ctx = {};
runInNewContext(readFileSync(new URL("../src/remote/diff-model.js", import.meta.url), "utf8"), ctx);
const D = ctx.OMP_REMOTE_DIFF;

// 30 lines of "ctx" with the given edits: { at: oldLine, rem: n, add: [texts] }.
function fileView(edits, { total = 30, ...extra } = {}) {
  const lines = [];
  let oldNo = 1, newNo = 1;
  for (let i = 1; i <= total; i++) {
    const edit = edits.find(e => e.at === i);
    if (edit) {
      for (let r = 0; r < (edit.rem ?? 0); r++) lines.push({ kind: "rem", old: oldNo++, new: null, text: `old ${i}.${r}` });
      for (const text of edit.add ?? []) lines.push({ kind: "add", old: null, new: newNo++, text });
      if (edit.rem) { i += edit.rem - 1; continue; }
    }
    lines.push({ kind: "ctx", old: oldNo++, new: newNo++, text: `line ${i}` });
  }
  return { path: "a.ts", kind: "Text", status: "Modified", truncated: false, lines, ...extra };
}

test("a change keeps two lines of context and folds the rest", () => {
  const view = fileView([{ at: 10, rem: 1, add: ["new 10"] }]);
  const out = D.build(view);
  const kinds = out.rows.map(r => (r.type === "fold" ? `fold${r.count}` : r.kind));
  // 9 lines before the change: 7 folded + 2 kept; 20 after: 2 kept + 18 folded
  deepEq(kinds, ["fold7", "ctx", "ctx", "rem", "add", "ctx", "ctx", "fold18"]);
  assert.equal(out.rows[0].count, 7);
  assert.equal(out.rows[7].count, 18);
  deepEq(out.changes, [{ from: 3, to: 4, adds: 1, rems: 1 }]);
  assert.equal(out.adds, 1);
  assert.equal(out.rems, 1);
});

test("line numbers pass through: removed lines have no new number, added no old", () => {
  const out = D.build(fileView([{ at: 10, rem: 1, add: ["x"] }]));
  const rem = out.rows.find(r => r.kind === "rem");
  const add = out.rows.find(r => r.kind === "add");
  deepEq([rem.old, rem.new, add.old, add.new], [10, null, null, 10]);
});

test("changes closer than the context windows merge their context, farther ones split", () => {
  const near = D.build(fileView([{ at: 10, add: ["a"] }, { at: 14, add: ["b"] }]));
  assert.equal(near.rows.filter(r => r.type === "fold").length, 2); // head and tail only
  assert.equal(near.changes.length, 2);
  const far = D.build(fileView([{ at: 5, add: ["a"] }, { at: 25, add: ["b"] }]));
  assert.equal(far.rows.filter(r => r.type === "fold").length, 3); // head, between and tail
  assert.equal(far.changes.length, 2);
  assert.ok(far.changes[1].from > far.changes[0].to);
});

test("a remove-then-add block is one change; adjacent add lines extend it", () => {
  const out = D.build(fileView([{ at: 10, rem: 2, add: ["x", "y", "z"] }]));
  assert.equal(out.changes.length, 1);
  deepEq([out.changes[0].adds, out.changes[0].rems], [3, 2]);
  assert.equal(out.changes[0].to - out.changes[0].from, 4);
});

test("a one line gap is shown, not folded", () => {
  const out = D.build(fileView([{ at: 3, add: ["a"] }, { at: 8, add: ["b"] }], { total: 10 }));
  // ctx run between the windows: lines 4..7 → 2 kept each side + 0 hidden.
  assert.equal(out.rows.some(r => r.type === "fold" && r.count < 2), false);
});

test("expanding a fold shows its lines and does not fold them again", () => {
  const view = fileView([{ at: 10, add: ["x"] }]);
  const closed = D.build(view);
  const head = closed.rows[0];
  assert.equal(head.type, "fold");
  const open = D.build(view, { expanded: new Set([head.id]) });
  assert.equal(open.rows.some(r => r.type === "fold" && r.id === head.id), false);
  assert.equal(open.rows.filter(r => r.type === "fold").length, closed.rows.filter(r => r.type === "fold").length - 1);
  // The jump target moves down by the lines that were revealed.
  assert.equal(open.changes[0].from, closed.changes[0].from - 1 + head.count);
});

test("an added file is one change with no folds", () => {
  const lines = Array.from({ length: 5 }, (_, i) => ({ kind: "add", old: null, new: i + 1, text: `l${i}` }));
  const out = D.build({ kind: "Text", status: "Untracked", adds: 5, rems: 0, lines });
  assert.equal(out.rows.length, 5);
  deepEq(out.changes, [{ from: 0, to: 4, adds: 5, rems: 0 }]);
});

test("rows cap at maxRows: capped flag set, later changes dropped, last one clipped", () => {
  const lines = Array.from({ length: 50 }, (_, i) => ({ kind: i < 25 ? "add" : "rem", old: i < 25 ? null : i, new: i < 25 ? i + 1 : null, text: "t" }));
  const out = D.build({ kind: "Text", lines }, { maxRows: 10 });
  assert.equal(out.rows.length, 10);
  assert.equal(out.capped, true);
  deepEq(out.changes.map(c => [c.from, c.to]), [[0, 9]]);
  assert.equal(D.build({ kind: "Text", lines: [], truncated: true }).capped, true);
});

test("adds and rems prefer the desktop's totals", () => {
  const out = D.build(fileView([{ at: 4, add: ["a"] }], { adds: 42, rems: 17 }));
  deepEq([out.adds, out.rems], [42, 17]);
});

test("stateOf maps the file kinds", () => {
  assert.equal(D.stateOf(fileView([{ at: 3, add: ["a"] }])), "diff");
  assert.equal(D.stateOf(fileView([])), "clean");
  assert.equal(D.stateOf({ kind: "Binary", lines: [] }), "binary");
  assert.equal(D.stateOf({ kind: "TooLarge", lines: [] }), "too-large");
  assert.equal(D.stateOf({ kind: "Missing", lines: [] }), "missing");
  assert.equal(D.stateOf(null), "missing");
});

test("changeAt follows the scroll position", () => {
  const changes = [{ from: 3, to: 4 }, { from: 20, to: 22 }, { from: 40, to: 40 }];
  assert.equal(D.changeAt(changes, 0), 0);
  assert.equal(D.changeAt(changes, 19), 0);
  assert.equal(D.changeAt(changes, 20), 1);
  assert.equal(D.changeAt(changes, 99), 2);
  assert.equal(D.changeAt([], 5), 0);
});

test("gutterDigits grows with the largest line number", () => {
  assert.equal(D.gutterDigits([{ type: "line", old: 5, new: 7 }]), 3);
  assert.equal(D.gutterDigits([{ type: "line", old: 12345, new: null }, { type: "fold" }]), 5);
});

test("reject copy: tracked files are discarded, files without a HEAD blob deleted", () => {
  const tracked = D.rejectCopy("ws-session.ts", "Modified", 42, 17, false);
  assert.equal(tracked.title, "Discard changes to ws-session.ts?");
  assert.equal(tracked.confirmLabel, "Discard changes");
  assert.equal(tracked.parts.map(p => p.text ?? p.bold).join(""), "The file goes back to the last commit. 42 added and 17 removed lines are lost. This can’t be undone.");
  const one = D.rejectCopy("a", "Modified", 1, 0, false).parts.map(p => p.text ?? p.bold).join("");
  assert.match(one, /1 added and 0 removed line is lost/);
  const gone = D.rejectCopy("new.txt", "Untracked", 3, 0, true);
  assert.equal(gone.title, "Delete new.txt?");
  assert.equal(gone.confirmLabel, "Delete file");
  assert.equal(gone.deletes, true);
});

test("done text", () => {
  assert.equal(D.doneText("accept", "a.ts"), "Staged a.ts");
  assert.equal(D.doneText("reject", "a.ts"), "Discarded a.ts");
  assert.equal(D.doneText("delete", "a.ts"), "Deleted a.ts");
});
