// Subagent detail (pushed from the Agents tab; no design file of its own — it
// follows the Agents card): status, tokens / cost / time / tools, the task, what
// the agent is doing now, and its transcript from the `subagentTranscript`
// query, with Steer… and Cancel for a running one (Control scope). Opened with
// navigate('subagent', { agentId, tabId, title? }). The record comes from
// state.view.subagents; without it the screen still loads the transcript.
(function (root) {
  const REFRESH_MS = 6000;
  const CLASS = { running: "running", done: "finished", failed: "error", stopped: "idle", idle: "idle" };

  function factory(ctx) {
    const { M, P, ui } = ctx;
    const { h, icon, button } = P;
    const A = root.OMP_REMOTE_AGENTS, ACT = root.OMP_REMOTE_AGENT_ACTIONS;
    let params = {}, agent = null, load = { status: "idle", entries: [], hidden: 0, error: "" }, seq = 0, timer = null, sig = "";

    const header = P.header({ title: "Subagent", back: "Back to agents", onBack: () => ui.back() });
    const refresh = P.iconButton({ icon: "refresh", label: "Refresh transcript", onClick: () => fetchTranscript(true) });
    header.actions.append(refresh);
    const summary = h("div", { cls: "r-ag-detail" });
    const log = h("div", { cls: "r-ag-log" });
    const logHead = h("div", { cls: "r-ag-log-head" });
    const scroll = h("div", { cls: "r-scroll" }, summary, h("section", { cls: "r-block" }, logHead, log));
    const footer = h("div", { cls: "r-ag-foot" });
    const el = h("section", { cls: "r-screen", attrs: { "aria-label": "Subagent" } }, header.el, scroll, footer);

    const tabIdOf = () => params.tabId ?? ctx.anchorTab();

    // ── transcript ───────────────────────────────────────────────────────
    async function fetchTranscript(manual) {
      if (!params.agentId || !ctx.conn.state().connected || !ctx.proto?.canQuery("subagentTranscript")) { renderLog(); return; }
      const mine = ++seq;
      if (load.status !== "ready") load = { ...load, status: "loading" };
      renderLog();
      try {
        const data = await ctx.query("subagentTranscript", { tabId: tabIdOf(), args: { agentId: params.agentId } });
        if (mine !== seq) return;
        load = { status: "ready", ...A.transcript(data?.messages), error: "" };
      } catch (error) {
        if (mine !== seq) return;
        load = { ...load, status: "error", error: M.errorFeedback(error).text };
        if (manual) ui.toast({ tone: "error", text: load.error });
      }
      renderLog();
    }

    function entryEl(entry) {
      switch (entry.kind) {
        case "user": return h("div", { cls: "r-ag-msg is-user" }, h("span", { cls: "r-ag-role", text: "You" }), h("div", { cls: "r-ag-text", text: entry.text }));
        case "assistant": return h("div", { cls: "r-ag-msg" }, h("div", { cls: "r-ag-text", text: entry.text }));
        case "call": return h("div", { cls: "r-ag-call" }, icon("tool-bash", { size: 16 }), h("b", { text: entry.tool }), entry.text && h("span", { cls: "mono", text: entry.text }));
        default: return h("div", { cls: `mono r-ag-result${entry.error ? " is-error" : ""}`, text: `${entry.text || "(no output)"}${entry.more ? "\n…" : ""}` });
      }
    }

    function renderLog() {
      const count = load.entries.length;
      logHead.replaceChildren(P.sectionTitle(count ? `Transcript · ${count}${load.hidden ? `+${load.hidden} older` : ""}` : "Transcript"));
      const kids = [];
      if (load.status === "loading" && !count) kids.push(P.skeleton(3));
      else if (load.status === "error" && !count) {
        kids.push(P.callout({ tone: "error", icon: "st-error", title: "Couldn’t load the transcript", body: load.error }), button({ label: "Retry", variant: "secondary", onClick: () => fetchTranscript(true) }));
      } else if (!count) kids.push(P.emptyState({ icon: "plan", title: "Nothing here yet", body: "The transcript appears once the agent has written something." }));
      else {
        if (load.hidden) kids.push(h("p", { cls: "r-hint", text: `${load.hidden} older entries are not shown.` }));
        kids.push(...load.entries.map(entryEl));
        if (load.status === "error") kids.push(P.callout({ tone: "warn", icon: "warning", title: "Showing what loaded earlier", body: load.error }));
      }
      log.replaceChildren(...kids);
      refresh.disabled = load.status === "loading";
    }

    // ── record ───────────────────────────────────────────────────────────
    const metric = (label, value) => h("div", { cls: "r-ag-metric" }, h("span", { text: label }), h("b", { text: value ?? "—" }));

    function renderSummary(state) {
      const found = (state.view?.subagents ?? []).find(item => item?.id === params.agentId);
      agent = found ? A.mapAgent(found, Date.now()) : null;
      const next = JSON.stringify([agent, state.scope, state.connected, state.legacy, params.title]);
      if (next === sig) return;
      sig = next;
      header.title(agent?.title ?? params.title ?? params.agentId ?? "Subagent");
      header.subtitle(agent ? agent.status.label : "");
      const kids = [];
      if (!agent) {
        kids.push(P.callout({ tone: "info", icon: "desktop", title: "No live details", body: "This subagent isn’t in the current view. Its transcript is below if the desktop still has it." }));
      } else {
        const cls = CLASS[agent.status.id];
        kids.push(
          h("div", { cls: "r-ag-detail-head" }, P.statusPill({ id: cls, icon: agent.status.icon, label: agent.status.label })),
          h("div", { cls: "r-card r-ag-metrics" }, metric("Tokens", A.fmtTokens(agent.tokens)), metric("Cost", A.fmtCost(agent.cost)), metric("Time", A.fmtDuration(agent.elapsed)), metric("Tools", agent.tools === null ? null : String(agent.tools))),
          agent.status.id === "failed" && agent.error && P.callout({ tone: "error", icon: "st-error", title: "It failed", body: agent.error, mono: true }),
          agent.task && h("section", { cls: "r-block" }, P.sectionTitle("Task"), h("div", { cls: "r-ag-task is-block", text: agent.task })),
          A.isLive(agent) && (agent.currentTool || agent.intent) && h("section", { cls: "r-block" }, P.sectionTitle("Now"),
            h("div", { cls: "mono r-ag-now", text: [agent.currentTool, agent.currentArgs].filter(Boolean).join(" ") || agent.intent })));
      }
      summary.replaceChildren(...kids.filter(Boolean));
      renderFooter(state);
    }

    function renderFooter(state) {
      footer.replaceChildren();
      footer.hidden = !(agent && A.isLive(agent));
      if (footer.hidden) return;
      const tabId = tabIdOf(), steer = ctx.gate("subagentSteer");
      if (steer.ok) {
        footer.append(
          button({ label: "Steer…", icon: "steer", variant: "primary", size: "lg", cls: "r-grow", onClick: () => ACT.steer(ctx, { tabId, agent }) }),
          P.iconButton({ icon: "stop", label: "Cancel subagent", variant: "danger", cls: "r-ag-stop", onClick: async () => { const r = await ACT.cancel(ctx, { tabId, agent }); if (r.ok) fetchTranscript(); } }));
      } else footer.append(h("button", { cls: "r-ag-lock r-grow", on: { click: () => ctx.lockToast(steer, "Steering") } }, icon("lock", { size: 16 }), h("span", { text: ACT.lockText(steer) })));
    }

    function schedule() {
      root.clearInterval(timer);
      timer = root.setInterval(() => { if (agent && A.isLive(agent)) fetchTranscript(false); }, REFRESH_MS);
    }

    return {
      el,
      update(state) { renderSummary(state); },
      show(next) {
        params = next ?? {};
        load = { status: "idle", entries: [], hidden: 0, error: "" };
        sig = ""; seq++;
        renderSummary(ctx.state());
        renderLog();
        fetchTranscript(false);
        schedule();
      },
      hide() { root.clearInterval(timer); timer = null; seq++; },
    };
  }

  root.OMP_REMOTE_UI.registerScreen("subagent", factory);
})(typeof window !== "undefined" ? window : globalThis);
