// Chat's Model & modes sheet (ModelSheet.dc.html). Models/thinking levels come
// from read-only queries; changes use gated actions. Goal state and plan state
// are only shown when the desktop provides them (the current view does not).
(function (root) {
  const UI = root.OMP_REMOTE_UI;

  function modelKey(model) {
    if (!model) return "";
    if (typeof model === "string") return model;
    return `${model.provider ?? ""}/${model.id ?? ""}`;
  }
  function recentModels(data) {
    const models = Array.isArray(data?.models) ? data.models : [];
    const keys = new Set((Array.isArray(data?.recent) ? data.recent : []).map(modelKey));
    return models.filter(m => keys.has(modelKey(m)));
  }

  function open(ctx, params = {}) {
    const { h, icon, button } = ctx.P;
    const tabId = params.tabId ?? ctx.state().activeTabId;
    let handle = null;
    let modelsData = null, thinkingData = null, querySeq = 0;
    const body = h("div", { cls: "r-model-sheet" }, ctx.P.skeleton(4));
    const row = (model, current, recent) => {
      const allowed = ctx.gate("setModel").ok;
      const el = h("button", { cls: `r-model-row${current ? " is-current" : ""}`, attrs: { "aria-current": current ? "true" : undefined, "aria-disabled": !allowed ? "true" : undefined }, on: { click: async () => {
        if (!allowed) { ctx.lockToast(ctx.gate("setModel"), "Change model"); return; }
        if (current) return;
        const result = await ctx.act("setModel", { tabId, args: { provider: model.provider, id: model.id } }, { label: "Change model" });
        if (result.ok) { modelsData.current = model; render(); }
      } } },
        current ? icon("check", { size: 18 }) : h("span", { cls: "r-model-spacer" }),
        h("span", { cls: "r-model-info" }, h("span", { cls: "r-model-name", text: model.name ?? model.id }), h("small", { text: `${model.provider}${current ? " · current" : recent ? " · recent" : ""}` })),
        !allowed && ctx.P.lockChip("Needs Manage"));
      return el;
    };

    function section(title, content) { return h("section", { cls: "r-model-section" }, h("h3", { cls: "r-model-heading", text: title }), content); }
    function render() {
      body.replaceChildren();
      const models = Array.isArray(modelsData?.models) ? modelsData.models : [];
      const currentKey = modelKey(modelsData?.current);
      const recent = recentModels(modelsData);
      const shown = recent.length ? recent : models.slice(0, 3);
      const modelList = h("div", { cls: "r-model-list" }, ...shown.map(model => row(model, modelKey(model) === currentKey, recent.some(m => modelKey(m) === modelKey(model)))));
      if (models.length > shown.length) modelList.append(button({ label: "All models by provider…", icon: "search", variant: "ghost", cls: "r-model-more", onClick: () => {
        modelList.replaceChildren(...models.map(m => row(m, modelKey(m) === currentKey, false)));
      } }));
      body.append(section("Model", modelList));
      const levels = Array.isArray(thinkingData?.levels) ? thinkingData.levels : [];
      const levelGrid = h("div", { cls: "r-thinking-grid", attrs: { role: "radiogroup", "aria-label": "Thinking level" } });
      for (const level of levels) {
        const current = level === thinkingData.current;
        const allowed = ctx.gate("setThinking").ok;
        levelGrid.append(h("button", { cls: `r-thinking-chip${current ? " is-selected" : ""}`, attrs: { role: "radio", "aria-checked": String(current), "aria-disabled": !allowed ? "true" : undefined }, text: level, on: { click: async () => {
          if (!allowed) { ctx.lockToast(ctx.gate("setThinking"), "Change thinking"); return; }
          const result = await ctx.act("setThinking", { tabId, args: { level } }, { label: "Change thinking" });
          if (result.ok) { thinkingData.current = level; render(); }
        } } }));
      }
      body.append(section("Thinking", h("div", { cls: "r-model-thinking" }, levelGrid, h("span", { cls: "r-model-hint", text: "Only levels this model supports are shown." }))));
      const goal = ctx.state().view?.goal;
      const goalPanel = h("div", { cls: "r-goal-panel" });
      if (goal && goal.status && !["complete", "dropped"].includes(goal.status)) {
        goalPanel.append(h("div", { cls: "r-goal-label" }, h("span", { text: "Goal" }), h("span", { cls: "r-goal-status", text: goal.status === "active" ? "Active" : goal.status })),
          h("div", { text: goal.objective ?? "" }));
        if (goal.tokenBudget && Number.isFinite(goal.tokensUsed)) goalPanel.append(h("div", { cls: "r-goal-usage mono", text: `${Math.round(goal.tokensUsed / 1000)}k / ${Math.round(goal.tokenBudget / 1000)}k tok` }));
        const actions = h("div", { cls: "r-goal-actions" });
        const op = async (label, kind) => {
          if (kind === "drop" && !(await ctx.ui.confirm({ title: "Drop this goal?", body: "The goal and its token budget are cleared. The conversation stays.", confirmLabel: "Drop goal", tone: "danger" }))) return;
          const result = await ctx.act("goalOp", { tabId, args: { op: kind } }, { label });
          if (result.ok) { handle?.close("action"); }
        };
        actions.append(button({ label: goal.status === "active" ? "Pause" : "Resume", variant: "secondary", onClick: () => op(goal.status === "active" ? "Pause goal" : "Resume goal", goal.status === "active" ? "pause" : "resume") }),
          button({ label: "Drop…", variant: "danger", onClick: () => op("Drop goal", "drop") }));
        goalPanel.append(actions);
      } else {
        const objective = h("textarea", { cls: "r-goal-input", attrs: { "aria-label": "Goal", placeholder: "What should the agent keep working toward?", rows: "2" } });
        const budget = h("input", { cls: "r-goal-budget", attrs: { type: "number", min: "1", step: "1000", "aria-label": "Token budget (optional)", placeholder: "Token budget (optional)" } });
        goalPanel.append(h("div", { cls: "r-goal-label", text: "Goal" }), objective, budget,
          button({ label: "Start goal", variant: "primary", cls: "r-goal-start", onClick: async () => {
            const value = objective.value.trim();
            if (!value) { objective.focus(); return; }
            const tokenBudget = budget.value ? Number(budget.value) : undefined;
            if (budget.value && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) { budget.focus(); return; }
            const result = await ctx.act("goalStart", { tabId, args: { objective: value, ...(tokenBudget ? { tokenBudget } : {}) } }, { label: "Start goal" });
            if (result.ok) handle?.close("action");
          } }));
      }
      if (!ctx.gate("goalStart").ok) {
        for (const el of goalPanel.querySelectorAll("input, textarea, button")) { el.disabled = true; el.setAttribute("aria-disabled", "true"); }
        goalPanel.append(ctx.P.lockChip("Needs Manage"));
      }
      body.append(section("Goal", goalPanel));
      const plan = ctx.state().view?.planMode;
      const planRow = h("div", { cls: "r-plan-row" }, h("span", { cls: "r-plan-label" }, h("span", { text: "Plan mode" }), h("small", { text: "Agent proposes a plan before editing" })),
        plan !== undefined ? h("span", { cls: "r-plan-value", text: plan ? "On desktop · On" : "On desktop · Off" }) : ctx.P.chip("On desktop", "desktop"));
      body.append(planRow);
      const compact = button({ label: "Compact context…", icon: "compact", variant: "secondary", cls: "r-compact-btn", onClick: async () => {
        if (!ctx.gate("compact").ok) { ctx.lockToast(ctx.gate("compact"), "Compact"); return; }
        if (!(await ctx.ui.confirm({ title: "Compact this session?", body: "Older messages become a summary to free context. You can’t expand them again.", confirmLabel: "Compact" }))) return;
        await ctx.act("compact", { tabId }, { label: "Compact" });
      } });
      if (!ctx.gate("compact").ok) { compact.setAttribute("aria-disabled", "true"); compact.append(ctx.P.lockChip("Needs Manage")); }
      body.append(compact);
    }
    handle = UI.openSheet({ title: "Model & modes", full: true, body });
    const seq = ++querySeq;
    Promise.allSettled([ctx.query("models", { tabId }), ctx.query("thinkingLevels", { tabId })]).then(([models, levels]) => {
      if (seq !== querySeq || !handle?.el.isConnected) return;
      if (models.status === "fulfilled") modelsData = models.value;
      if (levels.status === "fulfilled") thinkingData = levels.value;
      render();
      if (models.status === "rejected" || levels.status === "rejected") ctx.ui.toast({ tone: "warn", text: "Some model settings couldn’t be loaded." });
    });
    return handle;
  }
  UI.registerSheet("model-modes", open);
  root.OMP_REMOTE_MODEL_SHEET = { modelKey, recentModels };
})(typeof window !== "undefined" ? window : globalThis);
