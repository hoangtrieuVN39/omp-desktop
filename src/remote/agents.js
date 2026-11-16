// Agents tab (Agents.dc.html): the active session's subagents grouped by the
// task call that spawned them, each with status, tokens, cost and time; the
// first running one open with its task, current tool and Open transcript /
// Steer… / Cancel; below, the plan (todo list). A tap on a row opens the
// 'subagent' screen (subagent.js). Pure grouping and formatting is
// OMP_REMOTE_AGENTS; steer and cancel are OMP_REMOTE_AGENT_ACTIONS.
// Reads state.view.subagents / state.view.todos when the desktop sends them
// (see agents-model.js) and shows the task tool cards otherwise.
(function (root) {
  const TICK_MS = 1000;
  const CLASS = { running: "running", done: "finished", failed: "error", stopped: "idle", idle: "idle" };

  function factory(ctx) {
    const { P, ui } = ctx;
    const { h, icon, button } = P;
    const A = root.OMP_REMOTE_AGENTS, ACT = root.OMP_REMOTE_AGENT_ACTIONS;
    let sig = "", clock = null, live = [], tabId = null;

    const header = P.header({ title: "Agents", large: true });
    const body = h("div", { cls: "r-scroll r-ag-body" });
    const el = h("section", { cls: "r-screen", attrs: { "aria-label": "Agents" } }, header.el, body);

    const open = agent => ui.navigate("subagent", { agentId: agent.id, tabId, title: agent.title });

    // "Running · 18.2k tok · $0.21 · 1m 42s" under a row's title.
    function stats(agent) {
      const cls = CLASS[agent.status.id];
      const time = h("span", { cls: "r-ag-time", text: A.fmtDuration(agent.elapsed) ?? "" });
      if (A.isLive(agent) && agent.startedAt !== null) live.push({ time, agent });
      const tail = agent.status.id === "failed" && agent.error
        ? [h("span", { cls: "r-ag-error", text: agent.error })]
        : [agent.tokens !== null && h("span", { text: `${A.fmtTokens(agent.tokens)} tok` }), agent.cost !== null && h("span", { text: A.fmtCost(agent.cost) }), time.textContent && time];
      return h("div", { cls: "r-ag-stats" }, h("span", { cls: `r-tone-${cls}`, text: agent.status.label }), ...tail);
    }
    const statusIcon = agent => icon(agent.status.icon, { className: `r-ic-${CLASS[agent.status.id]}${A.isLive(agent) ? " spin" : ""}` });
    const titleBox = agent => h("div", { cls: "r-ag-main" }, h("div", { cls: "r-ag-title", text: agent.title }), stats(agent));

    function row(agent, depth) {
      const kids = [statusIcon(agent), titleBox(agent), agent.actionable && icon("chevron-right", { size: 16, className: "r-ag-chev" })];
      const cls = `r-ag-row${depth ? " is-nested" : ""}`;
      if (!agent.actionable) return h("div", { cls, attrs: { "data-agent-id": agent.id } }, ...kids);
      return h("button", { cls, attrs: { "data-agent-id": agent.id, "aria-label": `${agent.title}, ${agent.status.label}` }, on: { click: () => open(agent) } }, ...kids);
    }

    // The first running agent, expanded: progress, task, what it is doing now, actions.
    function expanded(agent) {
      const bar = h("div", { cls: `r-ag-bar${agent.context === null ? " is-indeterminate" : ""}`, attrs: { role: "progressbar", "aria-label": agent.context === null ? "Working" : "Context used", ...(agent.context === null ? {} : { "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(agent.context * 100)) }) } }, h("div", { cls: "r-ag-bar-fill" }));
      if (agent.context !== null) bar.firstChild.style.width = `${Math.round(agent.context * 100)}%`;
      const now = [agent.currentTool, agent.currentArgs].filter(Boolean).join(" ") || agent.intent;
      const steer = ctx.gate("subagentSteer");
      const actions = h("div", { cls: "r-ag-actions" }, button({ label: "Open transcript", variant: "secondary", cls: "r-grow", onClick: () => open(agent) }));
      if (steer.ok) {
        actions.append(
          button({ label: "Steer…", variant: "secondary", cls: "r-grow", onClick: () => ACT.steer(ctx, { tabId, agent }) }),
          P.iconButton({ icon: "stop", label: "Cancel subagent", variant: "danger", onClick: () => ACT.cancel(ctx, { tabId, agent }) }));
      } else {
        actions.append(h("button", { cls: "r-ag-lock", on: { click: () => ctx.lockToast(steer, "Steering") } }, icon("lock", { size: 16 }), h("span", { text: ACT.lockText(steer) })));
      }
      return h("div", { cls: "r-ag-open", attrs: { "data-agent-id": agent.id } },
        h("div", { cls: "r-ag-open-head" }, statusIcon(agent), titleBox(agent)),
        h("div", { cls: "r-ag-open-body" }, bar,
          agent.task && h("div", { cls: "r-ag-task", text: `Task: ${agent.task}` }),
          now && h("div", { cls: "mono r-ag-now", text: now }), actions));
    }

    function groupEl(group, firstLive) {
      const rows = group.rows.map(({ agent, depth }) => (agent === firstLive ? expanded(agent) : row(agent, depth)));
      return h("section", { cls: "r-block" }, h("h2", { cls: "r-ag-group", text: group.title }), h("div", { cls: "r-card r-ag-list" }, ...rows));
    }

    function planEl(plan) {
      const phases = plan.phases.map(phase => h("div", { cls: "r-ag-phase" },
        phase.name && h("div", { cls: "r-ag-phase-name", text: phase.name }),
        ...phase.tasks.map(task => h("div", { cls: `r-ag-todo is-${task.state.id}${task.abandoned ? " is-abandoned" : ""}` },
          task.state.icon ? icon(task.state.icon, { size: 18, className: task.state.id === "active" ? "spin" : "" }) : h("span", { cls: "r-ag-todo-dot", attrs: { "aria-hidden": "true" } }),
          h("span", { text: task.text }),
          h("span", { cls: "r-sr", text: task.state.id === "done" ? (task.abandoned ? "abandoned" : "done") : task.state.id === "active" ? "in progress" : "to do" })))));
      return h("section", { cls: "r-block" }, P.sectionTitle(plan.title), h("div", { cls: "r-card r-ag-plan" }, ...phases));
    }

    function renderHeader(state, data) {
      const tab = state.tabs.find(item => item.id === tabId);
      const sub = header.el.querySelector(".r-subtitle");
      const parts = A.summaryParts(data.totals);
      const kids = [tab?.title && h("span", { text: tab.title })];
      parts.forEach(part => kids.push(h("span", { cls: part.accent ? "r-tone-running" : "", text: part.text })));
      sub.replaceChildren(...kids.filter(Boolean).flatMap((node, i) => (i ? [root.document.createTextNode(" · "), node] : [node])));
      sub.hidden = !kids.filter(Boolean).length;
    }

    function render(state) {
      tabId = state.view?.tabId ?? state.activeTabId ?? null;
      const data = A.build(state.view, Date.now());
      const firstLive = data.agents.find(a => A.isLive(a) && a.actionable);
      const next = JSON.stringify([tabId, state.scope, state.connected, state.legacy, data.agents.map(a => [a.id, a.status.id, a.tokens, a.cost, a.currentTool, a.currentArgs, a.intent, a.context, a.error]), data.plan, state.tabs.find(t => t.id === tabId)?.title]);
      renderHeader(state, data);
      if (next === sig) return;
      sig = next; live = [];
      const kids = [P.scopeBanner(state.scope)];
      if (!state.view) kids.push(P.emptyState({ icon: "nav-agents", title: "No session open", body: "Open a session to see its subagents and plan." }));
      else {
        if (data.source === "none" && !data.plan) kids.push(P.emptyState({ icon: "nav-agents", title: "No subagents yet", body: "They show up here when the agent hands work to the task tool." }));
        for (const group of data.groups) kids.push(groupEl(group, firstLive));
        if (data.source === "cards") kids.push(h("p", { cls: "r-hint", text: "Live progress, steering and transcripts need a newer OMP Desktop. These are the task calls from the chat." }));
        if (data.plan) kids.push(planEl(data.plan));
      }
      body.replaceChildren(...kids.filter(Boolean));
    }

    // Running agents show a ticking clock between view frames.
    function tick() {
      const now = Date.now();
      for (const { time, agent } of live) time.textContent = A.fmtDuration(Math.max(agent.elapsed ?? 0, now - agent.startedAt)) ?? "";
    }

    return {
      el,
      update: render,
      show() { if (!clock) clock = root.setInterval(tick, TICK_MS); },
      hide() { root.clearInterval(clock); clock = null; },
    };
  }

  root.OMP_REMOTE_UI.registerScreen("agents", factory);
})(typeof window !== "undefined" ? window : globalThis);
