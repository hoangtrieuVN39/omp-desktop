#!/usr/bin/env node
// Phone question cards (src/remote/chat-asks-logic.js): approval detection and
// answers, select / confirm choices, the multi-question dialog's draft → answers.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const A = createRequire(import.meta.url)(root + "src/remote/chat-asks-logic.js");

const approval = (title = "Allow tool: bash\nOrigin: agent\npnpm test --filter auth -- --run") =>
  ({ id: "a1", kind: "select", title, options: ["Approve", "Deny"] });

test("approvalInfo reads the tool and the command, ignoring origin lines", () => {
  const info = A.approvalInfo(approval());
  assert.equal(info.tool, "bash");
  assert.equal(info.command, "pnpm test --filter auth -- --run");
  assert.deepEqual(info.context, ["Origin: agent"]);
  assert.equal(A.approvalTitle(info), "Run command?");
  assert.equal(A.approvalTitle(A.approvalInfo(approval("Allow tool: fetch\nhttps://x.test"))), "Allow fetch?");
});
test("approvalInfo: exact options, prefix and name grammar", () => {
  assert.equal(A.approvalInfo({ kind: "select", title: "Allow tool: bash", options: ["Approve", "Deny", "More"] }), null);
  assert.equal(A.approvalInfo({ kind: "select", title: "Pick one", options: ["Approve", "Deny"] }), null);
  assert.equal(A.approvalInfo({ kind: "confirm", title: "Allow tool: bash", options: ["Approve", "Deny"] }), null);
  assert.equal(A.approvalInfo({ kind: "select", title: "Allow tool: bash", options: [{ label: "Approve" }, { label: "Deny" }] }).tool, "bash");
  const odd = A.approvalInfo(approval("Allow tool: bad name!\nx"));
  assert.equal(odd.tool, null);
  assert.equal(A.canGrant(odd, ["approvalGrant"]), false);
  assert.equal(A.canGrant(A.approvalInfo(approval()), ["approvalGrant"]), true);
  assert.equal(A.canGrant(A.approvalInfo(approval()), []), false);
  assert.equal(A.canGrant(A.approvalInfo(approval()), undefined), false);
});
test("approvalAnswer maps the four buttons to answer values", () => {
  assert.deepEqual(A.approvalAnswer("approve"), { value: "Approve" });
  assert.deepEqual(A.approvalAnswer("deny"), { value: "Deny" });
  assert.deepEqual(A.approvalAnswer("session"), { value: "Approve", args: { grant: "session" } });
  assert.deepEqual(A.approvalAnswer("project"), { value: "Approve", args: { grant: "project" } });
  assert.equal(A.approvalAnswer("nope"), null);
  assert.equal(A.approvalResult("project", "omp-desktop").title, "Always allowed in omp-desktop");
  assert.equal(A.approvalResult("deny").tone, "error");
});
test("cardKind and choices", () => {
  assert.equal(A.cardKind(approval()), "approval");
  assert.equal(A.cardKind({ kind: "select", title: "Pick", options: ["a"] }), "select");
  assert.equal(A.cardKind({ kind: "dialog" }), "dialog");
  assert.equal(A.cardKind({ kind: "weird" }), "unknown");
  assert.deepEqual(A.selectChoices({ options: ["x", { label: "Y", value: "y" }, { label: "Z" }, 5, ""] }),
    [{ label: "x", value: "x" }, { label: "Y", value: "y" }, { label: "Z", value: "Z" }]);
  assert.deepEqual(A.confirmChoices().map(c => c.value), [false, true]);
});

const questions = [
  { id: "db", question: "Which?", multi: false, options: [{ label: "Postgres" }, { label: "SQLite" }] },
  { id: "env", question: "Where?", multi: true, options: [{ label: "Local" }, { label: "Staging" }, { label: "Prod" }] },
];
test("dialog: pick-one replaces, pick-any toggles, answers keep order", () => {
  let d = A.dialogDraft(questions);
  assert.equal(A.dialogReady(d, questions), false);
  assert.deepEqual(A.dialogProgress(d, questions), { answered: 1, total: 2 }); // the pick-any one may stay empty
  d = A.dialogPick(d, questions, 0, 1);
  d = A.dialogPick(d, questions, 0, 0);
  d = A.dialogPick(d, questions, 1, 2);
  d = A.dialogPick(d, questions, 1, 0);
  d = A.dialogPick(d, questions, 1, 2);
  assert.equal(A.dialogReady(d, questions), true);
  assert.deepEqual(A.dialogAnswers(d, questions), [
    { id: "db", selectedOptions: ["Postgres"] }, { id: "env", selectedOptions: ["Local"] },
  ]);
});
test("dialog: typed text and Other exclude options on pick-one", () => {
  let d = A.dialogDraft(questions);
  d = A.dialogPick(d, questions, 0, 0);
  d = A.dialogOther(d, 0);
  assert.deepEqual(d[0], { picks: [], text: "", other: true });
  assert.equal(A.dialogReady(d, questions), false); // Other chosen but empty
  d = A.dialogType(d, questions, 0, "  MySQL ");
  assert.deepEqual(A.dialogAnswers(d, questions)[0], { id: "db", selectedOptions: [], customInput: "MySQL" });
  d = A.dialogPick(d, questions, 0, 1);
  assert.deepEqual(d[0], { picks: [1], text: "", other: false });
});
test("dialog: pick-any may carry custom text and stays answerable empty", () => {
  let d = A.dialogDraft(questions);
  d = A.dialogPick(d, questions, 0, 0);
  d = A.dialogType(d, questions, 1, "dev box");
  assert.deepEqual(A.dialogAnswers(d, questions)[1], { id: "env", selectedOptions: [], customInput: "dev box" });
  assert.deepEqual(A.dialogAnswers(A.dialogPick(A.dialogDraft(questions), questions, 0, 0), questions)[1], { id: "env", selectedOptions: [] });
  assert.equal(A.dialogAnswers(A.dialogDraft(questions), questions), null);
  assert.equal(A.dialogReady([], []), false);
});
test("dialog copy counts", () => {
  assert.equal(A.dialogTitle(2), "Agent asks · 2 questions");
  assert.equal(A.dialogTitle(1), "Agent asks · 1 question");
  assert.equal(A.dialogSendLabel(2), "Send 2 answers");
  assert.equal(A.dialogSendLabel(1), "Send 1 answer");
});
