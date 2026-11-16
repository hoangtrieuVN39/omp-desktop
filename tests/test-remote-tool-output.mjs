#!/usr/bin/env node
// Phone Tool output screen logic (src/remote/tool-output-logic.js).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const T = createRequire(import.meta.url)(root + "src/remote/tool-output-logic.js");

test("splitLines handles CRLF, trailing newline and empty", () => {
  assert.deepEqual(T.splitLines("a\r\nb\n"), ["a", "b"]);
  assert.deepEqual(T.splitLines(""), []);
  assert.deepEqual(T.splitLines(undefined), []);
  assert.deepEqual(T.splitLines("a\n\nb"), ["a", "", "b"]);
});
test("findMatches is case-insensitive and ordered; stepping wraps", () => {
  const lines = ["ok", "FAIL one", "fail fail", "fine"];
  const hits = T.findMatches(lines, "fail");
  assert.deepEqual(hits.map(h => [h.line, h.start]), [[1, 0], [2, 0], [2, 5]]);
  assert.deepEqual(T.findMatches(lines, ""), []);
  assert.equal(T.stepMatch(-1, 3, 1), 0);
  assert.equal(T.stepMatch(-1, 3, -1), 2);
  assert.equal(T.stepMatch(2, 3, 1), 0);
  assert.equal(T.stepMatch(0, 3, -1), 2);
  assert.equal(T.stepMatch(0, 0, 1), -1);
  assert.equal(T.matchLabel(0, 2, "FAIL"), "1 of 2");
  assert.equal(T.matchLabel(-1, 0, "x"), "No matches");
  assert.equal(T.matchLabel(-1, 0, ""), "");
});
test("linePieces splits a line around its hits", () => {
  const lines = ["a FAIL b fail"];
  const hits = T.findMatches(lines, "fail");
  assert.deepEqual(T.linePieces(0, lines[0], hits), [{ text: "a " }, { text: "FAIL", match: 0 }, { text: " b " }, { text: "fail", match: 1 }]);
  assert.deepEqual(T.linePieces(1, "plain", hits), [{ text: "plain" }]);
});
test("diff classes and stat", () => {
  assert.deepEqual(["--- a/x", "+++ b/x", "@@ -1 +1 @@", "+new", "-old", " ctx"].map(T.diffClass), ["file", "file", "hunk", "add", "rm", "ctx"]);
  assert.deepEqual(T.diffStat(["+a", "+b", "-c", " d", "+++ f"]), { add: 2, rm: 1 });
});
test("line tone, status tone, header facts", () => {
  assert.equal(T.lineTone("✗ FAIL remote/auth"), "fail");
  assert.equal(T.lineTone("  ✓ passes"), "ok");
  assert.equal(T.lineTone("plain"), "");
  assert.equal(T.statusTone("error"), "error");
  assert.equal(T.statusTone("exit 1"), "error");
  assert.equal(T.statusTone("completed"), "ok");
  assert.equal(T.statusTone(""), "");
  assert.deepEqual(T.headerFacts({ status: "error", truncated: true }, 2418), [
    { text: "error", tone: "error" }, { text: "2,418 lines" }, { text: "cut at 400 KB" }]);
  assert.deepEqual(T.headerFacts({}, 1), [{ text: "1 line" }]);
  assert.equal(T.loadedNote(200, 2418), "Lines 1–200 loaded · rest loads as you scroll");
  assert.equal(T.loadedNote(10, 10), "");
});
