// Sessions screen (Main.dc.html): "Waiting for you" with quick reply, open tabs
// with status, saved sessions with search and resume, and the entry points to
// New session and Connection. Registered as the 'sessions' tab. Pure grouping,
// status and time logic is OMP_REMOTE_MODEL; this file renders and wires.
// Saved sessions come from proto.query('savedSessions') (the desktop lists at
// most 200). A tap on an open tab selects it (the desktop follows) and opens Chat;
// a long press (or right click) opens the session menu.
(function (root) {
  const LONG_PRESS_MS = 450, PAGE = 20, STALE_MS = 60000;

  function factory(ctx) {
    const { M, P, ui } = ctx;
    const { h, icon, button, statusPill } = P;
    let saved = { status: "idle", items: [], error: "", at: 0 };
    let query = "", limit = PAGE, loadSeq = 0;
    const signatures = {};

    const chip = h("button", { cls: "r-link-chip", on: { click: () => ui.navigate("connection") } });
    const plus = h("button", { cls: "r-icon-btn r-icon-btn-primary", attrs: { "aria-label": "New session" }, on: { click: onNew } }, icon("plus"));
    const header = P.header({ title: "Sessions", large: true });
    header.actions.append(chip, plus);

    const waitingEl = h("section", { cls: "r-block" });
    const openEl = h("section", { cls: "r-block" });
    const savedList = h("div", { cls: "r-saved-list" });
    const search = P.searchField({ placeholder: "Search saved sessions", label: "Search saved sessions", onInput: value => { query = value; limit = PAGE; renderSaved(ctx.state()); } });
    const savedEl = h("section", { cls: "r-block" }, P.sectionTitle("Saved sessions"), search.el, savedList);
    const scroll = h("div", { cls: "r-scroll" }, waitingEl, openEl, savedEl);
    const el = h("section", { cls: "r-screen", attrs: { "aria-label": "Sessions" } }, header.el, scroll);

    function onNew() {
      const gated = ctx.gate("newTab");
      if (!gated.ok) return ctx.lockToast(gated, "Starting a session");
      if (!ctx.anchorTab()) return ui.toast({ tone: "warn", text: "Open a session on the desktop first — the phone acts through an open tab.", duration: 6000 });
      ui.openSheetById("new-session");
    }

    // The connection chip: a coloured dot, the desktop's name, a spoken state.
    function renderChip(state) {
      const view = M.connectionView(state);
      const tone = view.tone === "ok" ? "ok" : view.tone;
      chip.replaceChildren(h("span", { cls: `r-dot r-dot-${tone}` }), h("span", { text: state.host }));
      chip.setAttribute("aria-label", `Connection: ${state.host}, ${view.label.replace(/…$/, "").toLowerCase()}`);
    }
    function renderPlus(state) {
      const gated = M.gate(state, "newTab");
      plus.className = `r-icon-btn ${gated.ok ? "r-icon-btn-primary" : "r-icon-btn-locked"}`;
      plus.replaceChildren(icon(gated.ok ? "plus" : "lock"));
      plus.setAttribute("aria-label", gated.ok ? "New session" : `New session. ${gated.label || "Unavailable"}`);
    }

    // ── tab rows ─────────────────────────────────────────────────────────
    function longPress(row, tabId) {
      let timer = null, fired = false, at = null;
      const stop = () => { if (timer) { root.clearTimeout(timer); timer = null; } at = null; };
      row.addEventListener("pointerdown", event => {
        fired = false; at = { x: event.clientX, y: event.clientY };
        timer = root.setTimeout(() => { fired = true; timer = null; ui.openSheetById("session-menu", { tabId }); }, LONG_PRESS_MS);
      });
      row.addEventListener("pointermove", event => {
        if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) > 10) stop();
      });
      row.addEventListener("pointerup", stop);
      row.addEventListener("pointercancel", stop);
      row.addEventListener("contextmenu", event => { event.preventDefault?.(); stop(); fired = true; ui.openSheetById("session-menu", { tabId }); });
      return () => { const was = fired; fired = false; return was; };
    }
    function tabRow(tab, state) {
      const status = M.statusOf(tab);
      const row = h("button", { cls: "r-tab-row", attrs: { "data-tab-id": tab.id } });
      const wasLong = longPress(row, tab.id);
      row.addEventListener("click", () => { if (!wasLong()) ctx.openTab(tab.id); });
      const sub = [tab.project, tab.profile && `profile ${tab.profile}`].filter(Boolean).join(" · ");
      const when = M.relativeTime(tab.updatedAt);
      row.append(
        icon(status.icon, { className: `r-ic-${status.id}${status.id === "running" ? " spin" : ""}` }),
        h("span", { cls: "r-tab-body" },
          h("span", { cls: "r-tab-title" },
            h("span", { cls: "r-tab-name", text: tab.title || "Untitled" }),
            tab.id === state.activeTabId && P.chip("On desktop", "desktop"),
            tab.unread && h("span", { cls: "r-dot", attrs: { role: "img", "aria-label": "Unread" } })),
          h("span", { cls: "r-tab-sub" },
            h("span", { text: sub ? `${sub} · ` : "" }),
            h("span", { cls: `r-tone-${status.id}`, text: status.label }),
            h("span", { text: when && !tab.busy ? ` · ${when}` : "" }))));
      return row;
    }

    function waitingCard(tab, state) {
      const ask = state.view?.tabId === tab.id ? (state.view.asks ?? []).find(item => item.kind === "confirm") : null;
      const canAnswer = ctx.gate("answer");
      const head = h("div", { cls: "r-wait-head" }, h("span", { cls: "r-tab-name", text: tab.title || "Untitled" }), h("span", { cls: "r-wait-project", text: tab.project }));
      if (!ask) {
        const link = h("button", { cls: "r-card r-wait-link", attrs: { "data-tab-id": tab.id }, on: { click: () => ctx.openTab(tab.id) } },
          h("span", { cls: "r-wait-main" }, head, h("span", { cls: "r-wait-text", text: "Question waiting" })),
          h("span", { cls: "r-wait-cta", text: canAnswer.ok ? "Answer" : "Open" }));
        return link;
      }
      const actions = h("div", { cls: "r-wait-actions" });
      if (canAnswer.ok) {
        const answer = value => ctx.act("answer", { tabId: tab.id, askId: ask.id, value }, { label: "Answer" });
        actions.append(
          button({ label: "No", variant: "secondary", cls: "r-grow", onClick: () => answer(false) }),
          button({ label: "Yes", variant: "primary", cls: "r-grow", onClick: () => answer(true) }));
      } else {
        actions.append(h("span", { cls: "r-lock-chip r-grow", text: canAnswer.label || "Answer on desktop" }));
      }
      actions.append(P.iconButton({ icon: "chevron-right", label: "Open question", variant: "line", onClick: () => ctx.openTab(tab.id) }));
      return h("div", { cls: "r-card r-wait-card", attrs: { "data-tab-id": tab.id } }, head,
        h("div", { cls: "r-wait-text", text: [ask.title, ask.message].filter(Boolean).join(" — ") || "Question waiting" }), actions);
    }

    function renderTabs(state) {
      const groups = M.groupTabs(state.tabs);
      const askSig = state.view ? [state.view.tabId, (state.view.asks ?? []).map(a => `${a.id}:${a.kind}`)] : null;
      const sig = JSON.stringify([state.tabs, state.activeTabId, askSig, state.scope, state.legacy, state.connected, state.tabsLoaded]);
      if (signatures.tabs === sig) return;
      signatures.tabs = sig;
      waitingEl.replaceChildren(...(groups.waiting.length ? [
        P.sectionTitle(`Waiting for you · ${groups.waiting.length}`, { tone: "amber", icon: "st-waiting" }),
        h("div", { cls: "r-stack" }, ...groups.waiting.map(tab => waitingCard(tab, state))),
      ] : []));
      waitingEl.hidden = !groups.waiting.length;
      const loading = !state.tabsLoaded && state.phase !== "offline" && state.phase !== "revoked" && !state.tabs.length;
      let body;
      if (loading) body = P.skeleton(2);
      else if (groups.open.length) body = h("div", { cls: "r-card r-tab-list" }, ...groups.open.map(tab => tabRow(tab, state)));
      else if (!groups.waiting.length) {
        body = P.emptyState({ icon: "nav-sessions", title: "No open tabs", body: M.COPY.emptyTabs });
      }
      openEl.replaceChildren(...[
        groups.open.length && P.sectionTitle(`Open tabs · ${groups.open.length}`),
        body,
      ].filter(Boolean));
      openEl.hidden = !body;
    }

    // ── saved sessions ───────────────────────────────────────────────────
    async function loadSaved(force) {
      const state = ctx.state();
      if (!state.connected || state.legacy || !ctx.conn.proto?.canQuery("savedSessions") || !ctx.anchorTab()) return;
      if (saved.status === "loading" || (!force && saved.status === "ready" && Date.now() - saved.at < STALE_MS)) return;
      const seq = ++loadSeq;
      if (saved.status !== "ready") saved = { ...saved, status: "loading" };
      renderSaved(state);
      try {
        const items = await ctx.query("savedSessions");
        if (seq !== loadSeq) return;
        saved = { status: "ready", items: Array.isArray(items) ? items : [], error: "", at: Date.now() };
      } catch (error) {
        if (seq !== loadSeq) return;
        saved = { ...saved, status: "error", error: M.errorFeedback(error).text };
      }
      renderSaved(ctx.state());
    }

    async function resume(item) {
      const gated = ctx.gate("resumeSession");
      if (!gated.ok) return ctx.lockToast(gated, "Resuming a session");
      const result = await ctx.act("resumeSession", { args: { sessionId: item.id } }, { label: "Resume" });
      if (result.ok && result.value?.tabId) ctx.openTab(result.value.tabId);
    }

    function savedRow(item, state) {
      const gated = M.gate(state, "resumeSession");
      const when = M.relativeTime(item.updatedAt);
      const row = h("button", { cls: "r-saved-row", attrs: { "data-session-id": item.id }, on: { click: () => resume(item) } },
        h("span", { cls: "r-saved-body" },
          h("span", { cls: "r-saved-title", text: item.title || item.preview || "Untitled session" }),
          h("span", { cls: "r-tab-sub", text: [item.project, when].filter(Boolean).join(" · ") })),
        gated.ok ? h("span", { cls: "r-saved-cta", text: "Resume" }) : P.lockChip(gated.label || "Unavailable"));
      return row;
    }

    function renderSaved(state) {
      const unsupported = state.connected && (state.legacy || !ctx.conn.proto?.canQuery("savedSessions"));
      const filtered = M.filterSaved(saved.items, query);
      const sig = JSON.stringify([saved.status, saved.error, filtered.map(i => i.id), limit, state.scope, state.connected, unsupported, Boolean(ctx.anchorTab())]);
      if (signatures.saved === sig) return;
      signatures.saved = sig;
      const kids = [];
      if (unsupported) kids.push(h("p", { cls: "r-hint", text: "Saved sessions need a newer OMP Desktop." }));
      else if (saved.status === "idle" && state.connected && !ctx.anchorTab()) kids.push(h("p", { cls: "r-hint", text: "Open a session on the desktop to list saved sessions." }));
      else if (saved.status === "loading" || (saved.status === "idle" && state.connected)) kids.push(P.skeleton(2));
      else if (saved.status === "error") {
        kids.push(P.callout({ tone: "error", icon: "st-error", title: "Couldn’t load saved sessions", body: saved.error }),
          button({ label: "Retry", variant: "secondary", onClick: () => loadSaved(true) }));
      } else if (saved.status === "ready" && !saved.items.length) {
        kids.push(P.emptyState({ icon: "folder", title: "No saved sessions yet", body: "Sessions you start show up here." }));
      } else if (saved.status === "ready" && !filtered.length) {
        kids.push(P.emptyState({ icon: "search", title: "No matches", body: "Try another word from the title or project." }));
      } else if (saved.status === "ready") {
        kids.push(...filtered.slice(0, limit).map(item => savedRow(item, state)));
        if (filtered.length > limit) kids.push(button({ label: `Show more (${filtered.length - limit})`, variant: "secondary", onClick: () => { limit += PAGE; renderSaved(ctx.state()); } }));
      }
      savedList.replaceChildren(...kids);
    }

    function update(state) {
      renderChip(state);
      renderPlus(state);
      renderTabs(state);
      renderSaved(state);
      if (state.connected && saved.status === "idle") loadSaved();
    }

    return { el, update, show() { loadSaved(false); } };
  }

  root.OMP_REMOTE_UI.registerScreen("sessions", factory, { live: true });
})(typeof window !== "undefined" ? window : globalThis);
