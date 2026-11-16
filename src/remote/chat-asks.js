// Chat's inline asks (select, confirm, input, editor, approval) and the
// AskDialog.dc.html bottom sheet. Only real `view.asks` are rendered. Drafts
// survive streaming view updates and are discarded once an ask disappears.
(function (root) {
  function create(ctx, host) {
    const { h, icon, button, iconButton } = ctx.P;
    const A = root.OMP_REMOTE_ASKS;
    const drafts = new Map();
    let signature = "", sheet = null, sheetId = null, current = [], tabId = null;
    let resolving = new Set();
    const keyOf = ask => `${tabId}:${ask.id}`;
    const canAnswer = () => ctx.gate("answer").ok;
    const lockNote = () => h("div", { cls: "r-ask-lock", attrs: { role: "note" } }, icon("lock", { size: 18 }),
      h("span", { text: "View only — answer on desktop, or ask for Control there." }));
    const action = (label, click, cls = "") => button({ label, variant: "secondary", cls: `r-ask-action ${cls}`, onClick: click });

    async function answer(ask, value, args, choice) {
      if (resolving.has(ask.id)) return;
      if (!canAnswer()) { ctx.lockToast(ctx.gate("answer"), "Answer"); return; }
      resolving.add(ask.id);
      syncBusy();
      const result = await ctx.act("answer", { tabId, askId: ask.id, value, ...(args ? { args } : {}) }, { label: "Answer", retry: false });
      resolving.delete(ask.id);
      syncBusy();
      if (result.ok) {
        if (choice) {
          const notice = A.approvalResult(choice, ctx.state().tabs.find(t => t.id === tabId)?.project);
          ctx.ui.toast({ tone: notice.tone, text: `${notice.title}. ${notice.body}`, duration: 5000 });
        }
        if (sheetId === ask.id) { sheet?.close("answered"); sheet = null; sheetId = null; }
      }
    }
    function syncBusy() {
      for (const card of host.querySelectorAll("[data-ask-id]")) {
        const busy = resolving.has(card.getAttribute("data-ask-id"));
        for (const control of card.querySelectorAll("button, input, textarea")) if (!control.hasAttribute("data-locked")) control.disabled = busy;
      }
      if (sheet && sheetId && resolving.has(sheetId)) for (const control of sheet.el.querySelectorAll("button, input, textarea")) control.disabled = true;
    }
    function cardShell(ask, cls = "") {
      const card = h("section", { cls: `r-ask-card ${cls}`, attrs: { "aria-label": "Agent question", "data-ask-id": ask.id } });
      return card;
    }
    function head(label, iconName) {
      return h("div", { cls: "r-ask-head" }, iconName && icon(iconName, { size: 16 }), h("span", { text: label }));
    }
    function lockedRow(label) {
      return h("div", { cls: "r-ask-locked-row", attrs: { "aria-disabled": "true" } }, icon("lock", { size: 16 }), h("span", { text: label }));
    }
    function approveCard(ask, info) {
      const card = cardShell(ask, "r-ask-approval");
      card.setAttribute("aria-label", "Tool approval");
      card.append(head(A.approvalTitle(info), "tool-bash"), h("div", { cls: "r-ask-command mono", text: info.command || ask.message || ask.title }));
      if (info.details.length > 1) card.append(h("div", { cls: "r-ask-details mono", text: info.details.slice(1).join("\n") }));
      const project = ctx.state().tabs.find(t => t.id === tabId)?.project ?? "this project";
      card.append(h("div", { cls: "r-ask-meta" }, h("span", { text: `${info.name} · in ` }), h("span", { cls: "mono", text: project })));
      if (!canAnswer()) { card.append(lockNote()); return card; }
      const choices = h("div", { cls: "r-ask-primary-row" },
        action("Deny", () => answer(ask, A.approvalAnswer("deny").value), "r-ask-deny"),
        button({ label: "Approve", variant: "primary", cls: "r-ask-approve", onClick: () => answer(ask, A.approvalAnswer("approve").value, null, "approve") }));
      card.append(choices);
      const caps = ctx.proto?.state?.().caps;
      for (const [choice, label] of [["session", "Allow for this session"], ["project", `Always allow in ${project}`]]) {
        // Saving a standing rule is a Manage action; the desktop must also say it can.
        const supported = A.canGrant(info, caps), scoped = ctx.gate("approvalRevoke").ok;
        const allowed = supported && scoped;
        const opt = action(label, () => {
          if (!supported) { ctx.ui.toast({ tone: "lock", text: root.OMP_REMOTE_CHAT.COPY.noGrant }); return; }
          if (!scoped) { ctx.lockToast(ctx.gate("approvalRevoke"), "Remember this approval"); return; }
          const req = A.approvalAnswer(choice);
          answer(ask, req.value, req.args, choice);
        }, "r-ask-grant");
        if (!allowed) { opt.setAttribute("aria-disabled", "true"); opt.append(ctx.P.lockChip(supported ? "Needs Manage" : "On desktop")); }
        card.append(opt);
      }
      return card;
    }
    function genericCard(ask, kind) {
      const card = cardShell(ask);
      card.append(head("Agent asks", "st-waiting"), h("div", { cls: "r-ask-title", text: ask.title || "Question" }));
      if (ask.message) card.append(h("div", { cls: "r-ask-message", text: ask.message }));
      if (kind === "dialog") {
        const count = ask.questions?.length ?? 0;
        card.append(button({ label: `Answer ${count} ${count === 1 ? "question" : "questions"}`, variant: "secondary", cls: "r-ask-dialog-open", onClick: () => openDialog(ask) }));
        if (!canAnswer()) card.append(lockNote());
        return card;
      }
      if (kind === "unknown") { card.append(h("div", { cls: "r-ask-hint", text: "Answer this question on the desktop." })); return card; }
      if (kind === "input" || kind === "editor") {
        const field = h(kind === "editor" ? "textarea" : "input", { cls: "r-ask-input", attrs: { "aria-label": ask.title || "Answer", rows: kind === "editor" ? "5" : undefined } });
        field.value = drafts.get(keyOf(ask)) ?? ask.value ?? "";
        field.addEventListener("input", () => drafts.set(keyOf(ask), field.value));
        card.append(field, button({ label: kind === "editor" ? "Submit" : "Answer", variant: "primary", cls: "r-ask-submit", onClick: () => answer(ask, field.value) }));
        if (kind === "editor") card.append(action("Cancel", async () => {
          if (await ctx.ui.confirm({ title: "Skip this question?", body: "The agent may stop this turn.", confirmLabel: "Skip", tone: "warn" })) answer(ask, null);
        }));
        if (!canAnswer()) { field.disabled = true; for (const el of card.querySelectorAll("button")) el.disabled = true; card.append(lockNote()); }
        return card;
      }
      const choices = kind === "confirm" ? A.confirmChoices() : A.selectChoices(ask);
      const controls = h("div", { cls: "r-ask-choices" });
      for (const choice of choices) {
        if (!canAnswer()) controls.append(lockedRow(choice.label));
        else controls.append(button({ label: choice.label, variant: choice.value === true ? "primary" : "secondary", cls: "r-ask-choice", onClick: () => answer(ask, choice.value) }));
      }
      card.append(controls);
      if (!canAnswer()) card.append(h("div", { cls: "r-ask-hint", text: "Answer on the desktop, or get Control scope." }));
      return card;
    }

    function openDialog(ask) {
      if (!canAnswer()) { ctx.lockToast(ctx.gate("answer"), "Answer"); return; }
      let draft = drafts.get(keyOf(ask));
      const questions = Array.isArray(ask.questions) ? ask.questions : [];
      if (!draft || draft.length !== questions.length) draft = A.dialogDraft(questions);
      drafts.set(keyOf(ask), draft);
      let error;
      const form = h("div", { cls: "r-dialog-form" });
      const refresh = () => {
        form.replaceChildren();
        questions.forEach((q, qi) => {
          const group = h("fieldset", { cls: "r-dialog-question" });
          group.append(h("legend", { text: `${qi + 1}. ${q.question}` }));
          if (q.multi) group.append(h("div", { cls: "r-dialog-hint", text: "Choose any" }));
          q.options?.forEach((option, oi) => {
            const checked = draft[qi].picks.includes(oi);
            const row = h("button", { cls: `r-dialog-option${checked ? " is-selected" : ""}`, attrs: { role: q.multi ? "checkbox" : "radio", "aria-checked": String(checked) }, on: { click: () => { draft = A.dialogPick(draft, questions, qi, oi); drafts.set(keyOf(ask), draft); refresh(); } } },
              h("span", { cls: `r-dialog-mark${q.multi ? " is-box" : ""}` }),
              h("span", { cls: "r-dialog-option-text" }, h("span", { text: option.label }), option.description && h("small", { text: option.description })),
              q.recommended === oi && h("small", { cls: "r-dialog-suggested", text: "Suggested" }));
            group.append(row);
          });
          if (!q.multi) group.append(h("button", { cls: `r-dialog-option${draft[qi].other ? " is-selected" : ""}`, attrs: { role: "radio", "aria-checked": String(draft[qi].other) }, on: { click: () => {
            draft = A.dialogOther(draft, qi); drafts.set(keyOf(ask), draft); refresh();
            group.querySelector("input")?.focus();
          } } }, h("span", { cls: "r-dialog-mark" }), h("span", { cls: "r-dialog-option-text", text: "Other answer…" })));
          if (q.multi || draft[qi].other) {
            const input = h("input", { cls: "r-dialog-custom", attrs: { "aria-label": `Custom answer: ${q.question}`, placeholder: q.multi ? "Add your own…" : "Type your answer…" } });
            input.value = draft[qi].text;
            input.addEventListener("input", () => { draft = A.dialogType(draft, questions, qi, input.value); drafts.set(keyOf(ask), draft); syncSend(); });
            group.append(input);
          }
          form.append(group);
        });
        form.append(error);
        syncSend();
      };
      const send = button({ label: A.dialogSendLabel(questions.length), variant: "primary", cls: "r-dialog-send", onClick: () => {
        const answers = A.dialogAnswers(draft, questions);
        if (!answers) { error.textContent = "Answer every pick-one question."; return; }
        error.textContent = "";
        answer(ask, answers);
      } });
      const syncSend = () => { send.disabled = !A.dialogReady(draft, questions); };
      error = h("div", { cls: "r-dialog-error", attrs: { role: "alert" } });
      const tab = ctx.state().tabs.find(t => t.id === tabId);
      sheetId = ask.id;
      sheet = ctx.ui.openSheet({
        label: "Agent questions", title: A.dialogTitle(questions.length), subtitle: [tab?.title, tab?.project].filter(Boolean).join(" · "), full: true,
        body: form,
        footer: handle => h("div", { cls: "r-dialog-footer" },
          button({ label: "Skip", variant: "secondary", cls: "r-dialog-skip", onClick: async () => {
            if (await ctx.ui.confirm({ title: "Skip these questions?", body: "The agent may stop this turn.", confirmLabel: "Skip", tone: "warn" })) answer(ask, null);
          } }), send),
        onClose: () => { sheet = null; sheetId = null; },
      });
      refresh();
    }

    function render(view, scope) {
      const nextTab = view?.tabId ?? null;
      if (tabId !== nextTab) { tabId = nextTab; signature = ""; }
      const asks = view?.asks ?? [];
      const next = JSON.stringify([tabId, asks, scope]);
      if (signature === next) return;
      signature = next;
      current = asks;
      const live = new Set(asks.map(keyOf));
      for (const key of drafts.keys()) if (!live.has(key)) drafts.delete(key);
      if (sheetId && !asks.some(ask => ask.id === sheetId)) { sheet?.close("withdrawn"); sheet = null; sheetId = null; }
      host.replaceChildren(...asks.map(ask => {
        const info = A.approvalInfo(ask);
        return info ? approveCard(ask, info) : genericCard(ask, A.cardKind(ask));
      }));
      syncBusy();
    }
    return { render, openDialog, current: () => current };
  }
  root.OMP_REMOTE_CHAT_ASKS = { create };
})(typeof window !== "undefined" ? window : globalThis);
