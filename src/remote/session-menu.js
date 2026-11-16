// Session menu sheet (SessionMenu.dc.html) and the rename sheet it opens.
// Opened with OMP_REMOTE_UI.openSheetById("session-menu", { tabId }) from the
// Chat header and from a long press on a tab in Sessions. Entries that belong
// to other modules (Conversation tree → screen 'tree', Export HTML → screen
// 'export') appear only when that screen is registered; Rename, Switch
// profile (sheet 'profile-switch'), Compact and Close tab are here. A locked
// entry shows its dashed "Needs <scope>" chip and explains itself on tap.
(function (root) {
  function open(ctx, params) {
    const { M, P, ui } = ctx;
    const { h, icon } = P;
    const tabId = params?.tabId;
    const tab = ctx.state().tabs.find(item => item.id === tabId);
    if (!tab) return null;
    let handle = null;
    const close = () => handle?.close("pick");
    const state = ctx.state();
    const title = tab.title || "Untitled";

    // One menu row. `kind` = the action kind that gates it (null = never locked).
    function row({ iconName, label, note, gate: kind, tone, onClick, chevron, action }) {
      const gated = kind ? ctx.gate(kind) : { ok: true };
      const locked = !gated.ok;
      const el = h("button", { cls: `r-menu-row${locked ? " is-locked" : ""}${tone ? ` r-menu-${tone}` : ""}`, attrs: { "aria-disabled": locked ? "true" : undefined, "data-action": action } },
        icon(iconName, { className: locked ? "" : `r-menu-ic-${tone ?? "plain"}` }),
        h("span", { cls: "r-menu-text" }, h("span", { cls: "r-menu-label", text: label }), !locked && note && h("span", { cls: "r-menu-note", text: note })),
        locked ? P.lockChip(gated.label || "Unavailable") : chevron && icon("chevron-right", { size: 16 }));
      el.addEventListener("click", () => {
        if (locked) { ctx.lockToast(gated, label); return; }
        onClick();
      });
      return el;
    }
    const goto = id => { close(); if (tab.id !== ctx.state().activeTabId) ctx.conn.selectTab(tab.id); ui.navigate(id, { tabId }); };

    const rows = [
      ui.hasScreen("tree") && row({ iconName: "branch", tone: "lilac", label: "Conversation tree", note: "Re-ask from any prompt", chevron: true, action: "tree", onClick: () => goto("tree") }),
      ui.hasScreen("export") && row({ iconName: "export", label: "Export HTML", note: "Saved on your computer, not this phone", gate: "exportHtml", action: "export", onClick: () => goto("export") }),
      row({ iconName: "compact", label: "Compact", note: "Free context", gate: "compact", action: "compact", onClick: compact }),
      row({ iconName: "rename", label: "Rename", gate: "renameTab", action: "rename", onClick: () => { close(); openRename(ctx, tab); } }),
      row({ iconName: "profile", label: "Switch profile", note: "Restarts as a new, empty session", gate: "switchProfile", chevron: true, action: "profile", onClick: () => { close(); ui.openSheetById("profile-switch", { tabId }); } }),
      row({ iconName: "close", label: tab.busy ? "Close tab…" : "Close tab", gate: "closeTab", tone: "danger", action: "close", onClick: closeTab }),
    ].filter(Boolean);

    async function compact() {
      close();
      const ok = await ui.confirm({ title: "Compact this session?", body: "Older messages become a summary to free context. You can’t expand them again.", confirmLabel: "Compact" });
      if (ok) await ctx.act("compact", { tabId }, { label: "Compact" });
    }
    async function closeTab() {
      close();
      const ok = await ui.confirm({
        title: `Close ${title}?`, tone: "danger",
        body: tab.busy ? "The agent is running. Closing stops it. The conversation stays in Saved sessions." : "The conversation stays in Saved sessions.",
        confirmLabel: tab.busy ? "Stop and close" : "Close tab",
      });
      if (ok) await ctx.act("closeTab", { tabId }, { label: "Close tab" });
    }

    const sub = [tab.project, tab.profile && `profile ${tab.profile}`, M.statusOf(tab).label].filter(Boolean).join(" · ");
    const lockedAny = state.scope !== "manage";
    handle = ui.openSheet({
      label: "Session actions", bare: true, flush: true,
      body: () => h("div", { cls: "r-menu" },
        h("div", { cls: "r-menu-head" }, h("div", { cls: "r-menu-title", text: title }), h("div", { cls: "r-menu-sub", text: sub })),
        ...rows,
        lockedAny && !state.legacy && h("p", { cls: "r-menu-scope", text: "This phone’s scope is set on the desktop: Settings › Paired phones." }),
        h("div", { cls: "r-menu-cancel" }, P.button({ label: "Cancel", variant: "secondary", cls: "r-btn-block", onClick: close }))),
    });
    return handle;
  }

  // Rename: one text field, Save sends `renameTab`.
  function openRename(ctx, tab) {
    const { P, ui } = ctx;
    const input = P.h("input", { cls: "r-field-input r-rename-input", attrs: { "aria-label": "Tab name", maxlength: "200", autocapitalize: "sentences", enterkeyhint: "done" } });
    input.value = tab.title ?? "";
    let handle = null;
    const save = async () => {
      const title = input.value.trim();
      if (!title || title === tab.title) { handle.close("unchanged"); return; }
      handle.close("save");
      await ctx.act("renameTab", { tabId: tab.id, args: { title } }, { label: "Rename" });
    };
    input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault?.(); save(); } });
    handle = ui.openSheet({
      title: "Rename tab",
      body: () => P.h("label", { cls: "r-field r-field-solo" }, input),
      footer: () => [
        P.button({ label: "Save", variant: "primary", size: "lg", cls: "r-btn-block", onClick: save }),
        P.button({ label: "Cancel", variant: "secondary", size: "lg", cls: "r-btn-block", onClick: () => handle.close("cancel") }),
      ],
    });
    input.focus();
    return handle;
  }

  root.OMP_REMOTE_UI.registerSheet("session-menu", open);
})(typeof window !== "undefined" ? window : globalThis);
