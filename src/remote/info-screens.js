// Usage (Usage.dc.html) and Approvals (ApprovalRules.dc.html), pushed from
// Connection / the session menu with navigate('usage') and
// navigate('approval-rules', { tabId }). Both are driven by the pure
// OMP_REMOTE_INFO model; reads are queries, writes are gated actions
// (`approvalRevoke`, `approvalModeProject`, Manage) behind ui.confirm.
(function (root) {
  const UI = root.OMP_REMOTE_UI;

  function usageFactory(ctx) {
    const { P, M } = ctx, { h, icon, iconButton } = P, I = root.OMP_REMOTE_INFO;
    let seq = 0;
    const header = P.header({ title: "Usage", back: "Back", onBack: () => UI.back(), subtitle: "Last 24 hours · read only" });
    header.actions.append(iconButton({ icon: "refresh", label: "Refresh usage", onClick: () => load() }));
    const body = h("div", { cls: "r-scroll r-info-body" });
    const el = h("section", { cls: "r-screen", attrs: { "aria-label": "Usage" } }, header.el, body);

    const bars = (title, rows, color) => rows.length === 0 ? null : h("section", { cls: "r-info-sec" },
      h("h2", { cls: "r-info-h", text: title }),
      h("div", { cls: "r-card r-info-card" }, ...rows.map(row => h("div", { cls: "r-bar-row" },
        h("span", { cls: "r-bar-label", text: row.label }),
        h("span", { cls: "r-bar-track" }, h("span", { cls: `r-bar-fill ${color}`, attrs: { "data-pct": row.pct } })),
        h("span", { cls: "r-bar-value mono", text: row.cost })))));
    function paint(data) {
      const u = I.usage(data);
      if (u.empty) { body.replaceChildren(P.emptyState({ icon: "st-idle", title: "No requests in the last 24 hours." })); return; }
      const grid = h("div", { cls: "r-kpis" }, ...u.kpis.map(k => h("div", { cls: "r-kpi" },
        h("b", { text: k.value }), k.unit && h("small", { text: ` ${k.unit}` }), h("span", { text: k.label }))));
      body.replaceChildren(grid, bars("Cost by model", u.models, "is-accent"), bars("Cost by project", u.folders, "is-lilac"),
        u.agents.length ? h("section", { cls: "r-info-sec" }, h("h2", { cls: "r-info-h", text: "By agent type" }),
          h("div", { cls: "r-card" }, ...u.agents.map(a => h("div", { cls: "r-agent-row" }, h("span", { text: a.label }), h("span", { cls: "mono", text: a.detail }))))) : null,
        u.unpriced > 0 && h("p", { cls: "r-hint", text: `${u.unpriced} requests have no price data and are not counted in cost.` }));
      for (const fill of body.querySelectorAll(".r-bar-fill")) fill.style.width = `${fill.dataset.pct}%`;
    }
    function load() {
      const mine = ++seq;
      body.replaceChildren(P.skeleton(4));
      if (!ctx.state().connected) { body.replaceChildren(P.callout({ tone: "error", icon: "offline", title: "Not connected to the desktop." })); return; }
      ctx.query("usage", {}).then(data => { if (mine === seq) paint(data); })
        .catch(err => { if (mine === seq) body.replaceChildren(P.callout({ tone: "error", icon: "st-error", title: "Couldn’t load usage", body: M.errorFeedback(err).text })); });
    }
    return { el, show: load, hide() { seq++; } };
  }

  function rulesFactory(ctx) {
    const { P, M } = ctx, { h, icon } = P, I = root.OMP_REMOTE_INFO;
    let tabId = null, seq = 0, modes = null, rules = [], failure = "";
    const header = P.header({ title: "Approvals", back: "Back", onBack: () => UI.back() });
    const body = h("div", { cls: "r-scroll r-info-body" });
    const el = h("section", { cls: "r-screen", attrs: { "aria-label": "Approvals" } }, header.el, body);
    const tab = () => ctx.state().tabs.find(t => t.id === tabId);

    async function setMode(mode) {
      const t = tab(), project = t?.project ?? "";
      if (!ctx.gate("approvalModeProject").ok) { ctx.lockToast(ctx.gate("approvalModeProject"), "Change approval mode"); return; }
      if (!await ctx.ui.confirm({ ...I.modeConfirm(project, mode, t?.title), tone: "warn" })) return;
      const result = await ctx.act("approvalModeProject", { tabId, args: { mode } }, { label: "Switch mode", retry: false });
      if (result.ok) load();
    }
    async function revoke(rule) {
      if (!ctx.gate("approvalRevoke").ok) { ctx.lockToast(ctx.gate("approvalRevoke"), "Revoke"); return; }
      if (!await ctx.ui.confirm({ title: `Revoke “${rule.tool}”?`, body: "It will ask for approval again.", confirmLabel: "Revoke", tone: "danger" })) return;
      const result = await ctx.act("approvalRevoke", { tabId, args: { tool: rule.tool, scope: rule.scope } }, { label: "Revoke", retry: false });
      if (result.ok) load();
    }
    function paint() {
      const t = tab(), project = t?.project ?? "", canManage = ctx.gate("approvalModeProject").ok;
      header.subtitle(`Project ${project || "—"} · ${ctx.state().scope === "manage" ? "Manage" : "View only"}`);
      const current = I.projectMode(modes, project);
      const modeRows = I.MODES.map(m => h("button", {
        cls: `r-mode-row${m.value === current.mode ? " is-current" : ""}`, attrs: { role: "radio", "aria-checked": String(m.value === current.mode), "aria-disabled": canManage ? undefined : "true" },
        on: { click: () => { if (m.value !== current.mode) setMode(m.value); } },
      }, h("span", { cls: "r-radio" }), h("span", { cls: "r-mode-text" },
        h("b", { text: m.label }), m.value === current.mode && h("small", { text: ` ${current.source === "project" ? "current" : "default"}` }), h("span", { text: m.blurb }))));
      const list = I.rules(rules, Date.now());
      body.replaceChildren(
        h("section", { cls: "r-info-sec" }, h("h2", { cls: "r-info-h", text: "Approval mode" }),
          h("div", { cls: "r-card", attrs: { role: "radiogroup", "aria-label": "Approval mode" } }, ...modeRows),
          current.ambiguous && h("p", { cls: "r-hint", text: "Two projects share this folder name; showing the default." }),
          !canManage && h("p", { cls: "r-hint", text: M.COPY.scopeView })),
        h("section", { cls: "r-info-sec" }, h("h2", { cls: "r-info-h", text: `Always-allow rules · ${list.length}` }),
          list.length === 0 ? P.emptyState({ icon: "check", title: "No always-allow rules in this project." })
            : h("div", { cls: "r-card" }, ...list.map(rule => h("div", { cls: "r-rule-row" },
              h("span", { cls: "r-rule-text" }, h("span", { cls: "mono r-rule-tool", text: rule.tool }), h("span", { cls: "r-rule-detail", text: rule.detail })),
              h("button", { cls: "r-rule-revoke", text: "Revoke", attrs: { "aria-disabled": ctx.gate("approvalRevoke").ok ? undefined : "true" }, on: { click: () => revoke(rule) } }))))),
        failure && h("div", { cls: "r-row-error", attrs: { role: "alert" }, text: failure }));
    }
    function load() {
      const mine = ++seq;
      failure = "";
      body.replaceChildren(P.skeleton(4));
      if (!tabId || !ctx.state().connected) { body.replaceChildren(P.callout({ tone: "error", icon: "offline", title: "Open a session first." })); return; }
      Promise.all([ctx.query("approvalModes", {}), ctx.query("approvalRules", { tabId })]).then(([m, r]) => {
        if (mine !== seq) return;
        modes = m; rules = Array.isArray(r) ? r : []; paint();
      }).catch(err => { if (mine === seq) { modes = null; rules = []; failure = M.errorFeedback(err).text; paint(); } });
    }
    return { el, show(params) { tabId = params?.tabId ?? ctx.anchorTab(); load(); }, hide() { seq++; } };
  }

  UI.registerScreen("usage", usageFactory);
  UI.registerScreen("approval-rules", rulesFactory);
})(typeof window !== "undefined" ? window : globalThis);
