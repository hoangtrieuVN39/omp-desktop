// The phone's Chat tab (ChatRunning / ChatApproval / ChatViewOnly .dc.html): header
// with the run-state pill and the "Following on desktop" line, the transcript,
// inline questions, and the composer. It assembles chat-transcript.js,
// chat-asks.js and chat-composer.js; replaces the fallback in chat-host.js
// (the last registration of "chat" wins). `live`: it renders every view frame
// even while hidden, so opening the tab is instant and scroll state is right.
// Exposes window.OMP_REMOTE_CHAT_SCREEN = { setDraft(text), markStopped(tabId) }
// for the composer (stopped note) and the conversation tree (branch → draft).
(function (root) {
  const UI = root.OMP_REMOTE_UI;

  function factory(ctx) {
    const { M, P } = ctx;
    const { h, icon, iconButton, statusPill } = P;
    const L = root.OMP_REMOTE_CHAT;
    let stoppedTab = null, renderedView, renderedExtras = "", composer = null;

    const titleEl = h("h1", { cls: "r-title", text: "Chat" });
    const subEl = h("div", { cls: "r-subtitle", hidden: true });
    const header = {
      title: value => { titleEl.textContent = value; },
      subtitle: value => { subEl.textContent = value ?? ""; subEl.hidden = !value; },
    };
    const switcher = h("button", { cls: "r-chat-switch", attrs: { "aria-label": "Switch tab" }, on: { click: () => UI.navigate("sessions") } },
      h("div", { cls: "r-chat-switch-text" }, titleEl, subEl));
    const pill = h("span", { cls: "r-chat-pill-slot" });
    const menu = iconButton({ icon: "more", label: "Session menu", onClick: () => {
      const tabId = ctx.state().activeTabId;
      if (tabId) UI.openSheetById("session-menu", { tabId });
    } });
    menu.hidden = true;
    const top = h("div", { cls: "r-chat-top" }, switcher, pill, menu);
    const followText = h("span", { text: L.COPY.following });
    const waiting = h("button", { cls: "r-chat-waiting", on: { click: () => UI.navigate("sessions") } });
    waiting.hidden = true;
    const follow = h("div", { cls: "r-chat-follow" }, icon("desktop", { size: 15 }), followText, waiting);
    const plan = h("button", { cls: "r-chat-plan", on: { click: () => UI.navigate("agents") } });
    plan.hidden = true;
    const head = h("header", { cls: "r-chat-head" }, top, follow, plan);

    const transcript = root.OMP_REMOTE_CHAT_TRANSCRIPT.create({
      ctx,
      echoLabel: () => L.COPY.steered.toUpperCase(),
      onMenu: (index, opener) => UI.openSheetById("message-menu", { index, opener, messages: transcript.messages(), tabId: ctx.state().activeTabId, onDraft: text => composer.setDraft(text) }),
      onOpenTool: message => UI.navigate("tool-output", { tabId: ctx.state().activeTabId, messageId: message.id }),
    });
    const asks = root.OMP_REMOTE_CHAT_ASKS.create(ctx, transcript.asksHost);
    composer = root.OMP_REMOTE_CHAT_COMPOSER.create(ctx, {
      onModel: () => UI.openSheetById("model-modes", { tabId: ctx.state().activeTabId }),
    });

    const meta = h("div", { cls: "r-chat-meta" });
    meta.hidden = true;
    const el = h("section", { cls: "r-screen r-chat-screen", attrs: { "aria-label": "Chat" } }, head, transcript.stage, composer.el, meta);

    function update(state) {
      const view = state.view;
      const tab = state.tabs.find(t => t.id === (state.activeTabId ?? view?.tabId));
      header.title(tab ? tab.title || "Untitled" : "Chat");
      header.subtitle(tab ? M.projectLine(tab) : "");
      menu.hidden = !tab;
      const run = L.runState({ tab, view, stopped: stoppedTab && stoppedTab === tab?.id && !view?.busy });
      pill.replaceChildren(statusPill({ id: run.id, label: run.text, icon: run.icon }));
      const others = state.tabs.filter(t => t.hasAsk && t.id !== tab?.id).length;
      waiting.hidden = others === 0;
      waiting.textContent = `${others} more waiting`;
      waiting.append(icon("chevron-right", { size: 14 }));
      follow.hidden = !state.connected;
      const strip = L.planStrip(view);
      plan.hidden = !strip;
      if (strip) {
        const bar = h("span", { cls: "r-chat-plan-bar" }, h("span", { cls: "r-chat-plan-fill", attrs: { "data-pct": strip.pct } }));
        bar.firstChild.style.width = `${strip.pct}%`;
        plan.replaceChildren(icon("nav-agents", { size: 16 }), h("span", { cls: "r-chat-plan-label", text: `Plan ${strip.done}/${strip.total}` }),
          h("span", { cls: "r-chat-plan-task", text: strip.current }), bar, icon("chevron-right", { size: 16 }));
      }
      const line = L.contextLine(view);
      meta.hidden = !line;
      if (line) {
        const fill = h("span", { cls: "r-chat-meter-fill" });
        fill.style.width = `${line.pct ?? 0}%`;
        meta.replaceChildren(...[line.pct !== null && h("span", { cls: "r-chat-meter" }, fill),
          line.pct !== null && h("span", { text: `${line.pct}% context` }), line.cost && h("span", { text: `${line.cost} this session` })].filter(Boolean));
      }

      const stopped = Boolean(stoppedTab && stoppedTab === tab?.id && !view?.busy);
      if (view?.busy && stoppedTab === tab?.id) stoppedTab = null;
      const scopeOk = ctx.gate("answer").ok;
      const signature = `${stopped}|${scopeOk}`;
      if (view !== renderedView || signature !== renderedExtras) {
        renderedView = view; renderedExtras = signature;
        transcript.render(view, { stopped });
        asks.render(view, scopeOk);
      }
      composer.update(state, view);
    }

    root.OMP_REMOTE_CHAT_SCREEN.draftSink = text => composer.setDraft(text);
    root.OMP_REMOTE_CHAT_SCREEN.stopSink = tabId => { stoppedTab = tabId; update(ctx.state()); };
    return { el, update };
  }
  UI.registerScreen("chat", factory, { live: true });
  root.OMP_REMOTE_CHAT_SCREEN = {
    setDraft(text) { root.OMP_REMOTE_CHAT_SCREEN.draftSink?.(text); },
    markStopped(tabId) { root.OMP_REMOTE_CHAT_SCREEN.stopSink?.(tabId); },
  };
})(typeof window !== "undefined" ? window : globalThis);
