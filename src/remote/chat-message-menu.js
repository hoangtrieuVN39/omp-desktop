// MessageMenu.dc.html: long-press actions on a user message or a final answer.
// The menu uses an overlay rather than the bottom-sheet primitive: the selected
// message appears above the actions, as in the design. Branch and fork are
// scope-gated, and never start while a turn is running.
(function (root) {
  const UI = root.OMP_REMOTE_UI;
  const L = root.OMP_REMOTE_CHAT;
  let openHandle = null;

  function open(ctx, params = {}) {
    if (openHandle) openHandle.close();
    const { h, icon } = ctx.P;
    const messages = params.messages ?? ctx.state().view?.messages ?? [];
    const index = params.index;
    const view = ctx.state().view;
    const menu = L.messageMenu({ messages, index, busy: Boolean(view?.busy), gate: ctx.gate });
    if (!menu) return null;
    const opener = params.opener ?? root.document.activeElement;
    const backdrop = h("div", { cls: "r-msg-menu-backdrop", attrs: { "aria-hidden": "true" } });
    const preview = h("div", { cls: `r-msg-menu-preview${menu.user ? " is-user" : ""}` },
      menu.heading && h("span", { cls: "r-msg-menu-heading", text: menu.heading }),
      h("span", { text: menu.text }));
    const list = h("div", { cls: "r-msg-menu-list", attrs: { role: "menu", "aria-label": "Message actions" } });
    const panel = h("div", { cls: "r-msg-menu-panel", attrs: { role: "dialog", "aria-modal": "true", "aria-label": "Message actions" } }, preview, list,
      menu.footer && h("p", { cls: "r-msg-menu-footer", text: menu.footer }));
    const close = () => {
      if (!openHandle) return;
      root.document.removeEventListener("keydown", onKey);
      backdrop.remove(); panel.remove();
      openHandle = null;
      opener?.focus?.();
    };
    const onKey = event => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      else if (event.key === "Tab") {
        const items = [...list.querySelectorAll("button:not([disabled])")];
        if (!items.length) return;
        const at = items.indexOf(root.document.activeElement);
        if (event.shiftKey && at <= 0) { event.preventDefault(); items.at(-1).focus(); }
        else if (!event.shiftKey && at === items.length - 1) { event.preventDefault(); items[0].focus(); }
      }
    };
    backdrop.addEventListener("click", close);
    root.document.addEventListener("keydown", onKey);
    const rows = menu.entries.map(entry => {
      const row = h("button", { cls: `r-msg-menu-row${entry.locked ? " is-locked" : ""}`, attrs: { role: "menuitem", "aria-disabled": entry.locked ? "true" : undefined }, on: { click: async () => {
        if (entry.id === "copy") {
          close(); root.OMP_REMOTE_CHAT_TRANSCRIPT.copyText(ctx, menu.text); return;
        }
        if (entry.locked) {
          if (entry.scopeLocked) ctx.lockToast(ctx.gate(entry.kind), entry.label);
          else UI.toast({ tone: "lock", text: L.COPY.branchBusy });
          return;
        }
        close();
        UI.setBanner("branch", { tone: "info", icon: "st-running", spin: true, text: L.COPY.switching });
        const result = await ctx.act(entry.kind, { tabId: params.tabId ?? ctx.state().activeTabId, args: { entryId: entry.entryId } }, { label: entry.label, retry: false });
        UI.setBanner("branch", null);
        if (!result.ok) return;
        if (entry.id === "branch") {
          params.onDraft?.(result.value?.text ?? "");
          UI.toast({ tone: "ok", text: "Branch ready. Edit the prompt before sending." });
        } else UI.toast({ tone: "ok", text: "Fork ready." });
      } } }, icon(entry.locked ? "lock" : entry.icon),
        h("span", { cls: "r-msg-menu-text" }, h("strong", { text: entry.label }), entry.note && h("small", { text: entry.note })),
        entry.lockLabel && ctx.P.lockChip(entry.lockLabel));
      return row;
    });
    list.append(...rows);
    root.document.getElementById("app").append(backdrop, panel);
    const first = list.querySelector("button"); first?.focus();
    openHandle = { close };
    return openHandle;
  }

  UI.registerSheet("message-menu", open);
})(typeof window !== "undefined" ? window : globalThis);
