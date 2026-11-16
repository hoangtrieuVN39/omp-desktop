// Pure logic of the phone's inline question cards and the multi-question sheet
// (ChatApproval / ChatViewOnly / AskDialog .dc.html): what kind of card an ask
// is, the values `answer` carries for it, and the dialog's draft → answers.
// Mirrors app/approval.js (tool approvals) and app/ask-dialog.js (omp's ask
// dialog rules); the desktop re-checks every answer (remote-view.js invalidAnswer),
// so this only has to build well-formed ones. No DOM, so tests drive it directly.
// Exposes window.OMP_REMOTE_ASKS.
(function (root) {
  const TITLE_PREFIX = "Allow tool: ";
  const TOOL_NAME = /^[A-Za-z0-9][\w.:-]{0,63}$/;
  const CONTEXT_LINE = /^(Origin|Reason): /;
  // A desktop that can remember an approval says so in its hello `caps`; until
  // then "Allow for this session / Always allow" stay locked (see report).
  const GRANT_CAP = "approvalGrant";

  const optionLabel = option => (typeof option === "string" ? option : option?.label);
  const optionValue = option => (typeof option === "string" ? option : option?.value ?? option?.label);

  // "Allow tool: <name>\n<details…>" with exactly the options Approve / Deny.
  // `tool` is null when the name fails the grammar: still an approval card, but
  // nothing can be remembered for it.
  function approvalInfo(ask) {
    if (!ask || ask.kind !== "select" || typeof ask.title !== "string" || !Array.isArray(ask.options)) return null;
    const labels = ask.options.map(optionLabel);
    if (labels.length !== 2 || labels[0] !== "Approve" || labels[1] !== "Deny") return null;
    const lines = ask.title.replace(/\r/g, "").split("\n");
    if (!lines[0].startsWith(TITLE_PREFIX)) return null;
    const name = lines[0].slice(TITLE_PREFIX.length);
    const details = lines.slice(1).map(line => line.trimEnd()).filter(line => line.trim());
    const main = details.filter(line => !CONTEXT_LINE.test(line));
    const context = details.filter(line => CONTEXT_LINE.test(line));
    return {
      tool: TOOL_NAME.test(name) ? name : null, name, details: main.length ? main : details, context,
      command: main[0] ?? details[0] ?? "",
    };
  }

  // The card an ask renders as.
  function cardKind(ask) {
    if (approvalInfo(ask)) return "approval";
    return ["select", "confirm", "input", "editor", "dialog"].includes(ask?.kind) ? ask.kind : "unknown";
  }

  function selectChoices(ask) {
    return (ask.options ?? []).map(option => ({ label: optionLabel(option) ?? "", value: optionValue(option) }))
      .filter(choice => choice.label !== "" && typeof choice.value === "string");
  }
  const confirmChoices = () => [{ label: "No", value: false }, { label: "Yes", value: true }];

  // choice: approve | deny | session | project → { value, args? } for the `answer` action.
  function approvalAnswer(choice) {
    switch (choice) {
      case "approve": return { value: "Approve" };
      case "deny": return { value: "Deny" };
      case "session": case "project": return { value: "Approve", args: { grant: choice } };
      default: return null;
    }
  }
  const canGrant = (info, caps) => Boolean(info?.tool) && Array.isArray(caps) && caps.includes(GRANT_CAP);
  // What a resolved approval says (ChatApproval "resolved" strip).
  function approvalResult(choice, project) {
    switch (choice) {
      case "approve": return { title: "Approved", body: "Running now. You can leave — we will notify when it finishes.", tone: "ok" };
      case "session": return { title: "Allowed for this session", body: "This command will not ask again in this tab.", tone: "ok" };
      case "project": return { title: `Always allowed in ${project || "this project"}`, body: "Saved as a rule. Revoke in Approval rules.", tone: "ok" };
      default: return { title: "Denied", body: "The agent was told not to run it.", tone: "error" };
    }
  }
  function approvalTitle(info) {
    if (!info.name || /^(bash|shell|sh|exec|run|terminal|powershell|cmd)$/i.test(info.name)) return "Run command?";
    return `Allow ${info.name}?`;
  }

  // ── multi-question dialog ────────────────────────────────────────────────
  // Draft per question: picked option indexes, typed text, and for a pick-one
  // question whether its "Other answer…" row is the choice.
  const dialogDraft = questions => questions.map(() => ({ picks: [], text: "", other: false }));
  const replaceAt = (draft, at, entry) => draft.map((e, i) => (i === at ? entry : e));

  function dialogPick(draft, questions, qi, oi) {
    const entry = draft[qi];
    if (!questions[qi].multi) return replaceAt(draft, qi, { picks: [oi], text: "", other: false });
    const picks = entry.picks.includes(oi) ? entry.picks.filter(i => i !== oi) : [...entry.picks, oi].sort((a, b) => a - b);
    return replaceAt(draft, qi, { ...entry, picks });
  }
  // The "Other answer…" row of a pick-one question: replaces any option.
  function dialogOther(draft, qi) {
    return replaceAt(draft, qi, { ...draft[qi], picks: [], other: true });
  }
  function dialogType(draft, questions, qi, text) {
    const single = !questions[qi].multi;
    return replaceAt(draft, qi, { ...draft[qi], text, picks: single ? [] : draft[qi].picks, other: single ? true : draft[qi].other });
  }
  // Pick-one needs an option or typed text; pick-any may stay empty.
  function questionAnswered(entry, question) {
    return question.multi || entry.picks.length > 0 || (entry.other && entry.text.trim() !== "");
  }
  const dialogProgress = (draft, questions) => ({
    answered: questions.filter((q, i) => questionAnswered(draft[i], q)).length, total: questions.length,
  });
  const dialogReady = (draft, questions) => questions.length > 0 && questions.every((q, i) => questionAnswered(draft[i], q));

  // [{ id, selectedOptions, customInput? }] in question order, or null when a
  // pick-one question is still open.
  function dialogAnswers(draft, questions) {
    if (!dialogReady(draft, questions)) return null;
    return questions.map((q, i) => {
      const entry = draft[i];
      const labels = entry.picks.map(oi => q.options[oi]?.label).filter(label => typeof label === "string");
      const custom = entry.text.trim();
      if (q.multi) return custom ? { id: q.id, selectedOptions: labels, customInput: custom } : { id: q.id, selectedOptions: labels };
      return entry.picks.length ? { id: q.id, selectedOptions: labels } : { id: q.id, selectedOptions: [], customInput: custom };
    });
  }
  const dialogTitle = n => `Agent asks · ${n} ${n === 1 ? "question" : "questions"}`;
  const dialogSendLabel = n => `Send ${n} ${n === 1 ? "answer" : "answers"}`;

  const asks = {
    GRANT_CAP, approvalInfo, cardKind, selectChoices, confirmChoices, approvalAnswer, canGrant, approvalResult, approvalTitle,
    dialogDraft, dialogPick, dialogOther, dialogType, questionAnswered, dialogProgress, dialogReady, dialogAnswers, dialogTitle, dialogSendLabel,
  };
  if (typeof window !== "undefined") window.OMP_REMOTE_ASKS = asks;
  if (typeof module !== "undefined" && module.exports) module.exports = asks;
})(typeof window !== "undefined" ? window : globalThis);
