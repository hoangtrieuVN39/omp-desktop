// Phone Chat transcript (ChatRunning / ChatApproval / ChatViewOnly .dc.html): user
// bubbles, assistant markdown, tool cards, notices, scroll pinning and the
// long-press hook of the message menu. Rows are keyed and only rebuilt when
// their content changes, so a streaming answer does not rebuild the page.
// Assistant markdown is the only innerHTML (OMP_REMOTE_CLIENT.renderMarkdown,
// the desktop's configured marked); everything else is textContent.
// Exposes window.OMP_REMOTE_CHAT_TRANSCRIPT = { create(opts) } returning
// { stage, asksHost, render(view, extras), messages() }.
//   opts   { ctx, onMenu(index, rowEl), onOpenTool(message), echoLabel(text) }
//   extras { stopped, idleNote }
(function (root) {
  const LONG_PRESS_MS = 450, MOVE_SLOP = 10;

  function copyText(ctx, text) {
    const done = () => ctx.ui.toast({ tone: "ok", text: "Copied", duration: 1800 });
    const fallback = () => {
      const area = root.document.createElement("textarea");
      area.value = text;
      area.className = "r-sr";
      root.document.body.append(area);
      area.select();
      try { root.document.execCommand("copy"); done(); } catch { ctx.ui.toast({ tone: "error", text: "Couldn’t copy" }); }
      area.remove();
    };
    if (root.navigator?.clipboard?.writeText) root.navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  // Code blocks get the design's header (language + Copy); tables scroll sideways.
  function decorateMarkdown(ctx, el) {
    const { h, icon } = ctx.P;
    for (const pre of [...el.querySelectorAll("pre")]) {
      const code = pre.querySelector("code");
      const lang = (/language-([\w+#.-]+)/.exec(code?.className ?? "") ?? [])[1] ?? "";
      pre.querySelector(".copy-btn")?.remove();
      const copy = h("button", { cls: "r-code-copy", on: { click: () => copyText(ctx, code?.textContent ?? pre.textContent) } }, icon("copy", { size: 15 }), h("span", { text: "Copy" }));
      const head = h("div", { cls: "r-code-head" }, h("span", { cls: "mono r-code-lang", text: lang }), copy);
      const wrap = h("div", { cls: "r-code" }, head);
      pre.replaceWith(wrap);
      wrap.append(pre);
    }
    for (const table of [...el.querySelectorAll("table")]) {
      const wrap = h("div", { cls: "r-md-table" });
      table.replaceWith(wrap);
      wrap.append(table);
    }
    for (const link of el.querySelectorAll("a[href]")) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
  }

  function create({ ctx, onMenu, onOpenTool, echoLabel }) {
    const C = root.OMP_REMOTE_CLIENT, L = root.OMP_REMOTE_CHAT, P = root.OMP_SCROLL_PIN;
    const { h, icon, button } = ctx.P;
    const rows = h("div", { cls: "r-chat-rows" });
    const asksHost = h("div", { cls: "r-chat-asks" });
    const tail = h("div", { cls: "r-chat-tail" });
    const body = h("div", { cls: "r-chat-body" }, rows, asksHost, tail);
    const scroll = h("div", { cls: "r-chat-scroll", attrs: { role: "log", "aria-label": "Transcript", "aria-live": "off" } }, body);
    const jump = button({ label: "Newest", icon: "chevron-down", variant: "secondary", size: "sm", cls: "r-chat-jump", onClick: () => { pinned = true; toBottom(); updateJump(); } });
    jump.hidden = true;
    const stage = h("div", { cls: "r-chat-stage" }, scroll, jump);

    const cache = new Map(); // key → { sig, el }
    let current = [], shown = new Set(), shownTab = null, firstRender = true;
    let pinned = true, prevTop = 0, lastTab = null, lastTail = null;

    const metrics = () => ({ scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight });
    const toBottom = () => { scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight; prevTop = scroll.scrollTop; };
    const updateJump = () => { jump.hidden = pinned; };
    scroll.addEventListener("scroll", () => { const m = metrics(); pinned = P.nextPinned(pinned, prevTop, m); prevTop = m.scrollTop; updateJump(); });
    // The box shrinks under the iOS keyboard or a growing draft: a pinned reader stays on the newest row.
    if (typeof root.ResizeObserver !== "undefined") new root.ResizeObserver(() => { if (pinned) toBottom(); }).observe(scroll);

    // Long press (or the context-menu key) on a bubble opens the message menu.
    function bindMenu(el, ref) {
      let timer = null, from = null, fired = false;
      const cancel = () => { root.clearTimeout(timer); timer = null; };
      el.addEventListener("pointerdown", event => {
        fired = false; from = { x: event.clientX, y: event.clientY };
        timer = root.setTimeout(() => { fired = true; timer = null; onMenu(ref.index, el); }, LONG_PRESS_MS);
      });
      el.addEventListener("pointermove", event => {
        if (timer && from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > MOVE_SLOP) cancel();
      });
      for (const name of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(name, cancel);
      el.addEventListener("contextmenu", event => { event.preventDefault(); if (!fired) { cancel(); onMenu(ref.index, el); } });
      el.addEventListener("keydown", event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); onMenu(ref.index, el); } });
      el.tabIndex = 0;
      el.setAttribute("aria-haspopup", "menu");
    }

    function userRow(message) {
      const steered = Boolean(message.echo);
      const bubble = h("div", { cls: `r-msg r-msg-user${steered ? " is-steer" : ""}` },
        steered && h("span", { cls: "r-msg-steer-tag", text: echoLabel(message.text) }),
        h("span", { cls: "r-msg-text", text: message.text ?? "" }));
      return bubble;
    }
    function assistantRow(message) {
      const el = h("div", { cls: "r-msg r-msg-assistant r-md" });
      try { el.innerHTML = C.renderMarkdown(message.text || ""); decorateMarkdown(ctx, el); }
      catch { el.textContent = message.text || ""; }
      return el;
    }
    function noticeRow(message) {
      return h("div", { cls: "r-msg-notice", attrs: { role: "status" }, text: message.text ?? "" });
    }
    function toolRow(message, live) {
      const tool = message.tool ?? {};
      const name = tool.name || "tool";
      const mono = L.isCommandTool(name) || Boolean(tool.summary);
      const lines = live ? L.outputTail(tool.output, 3) : [];
      const diff = !live && L.isEditTool(name) ? L.diffPreview(tool.output) : null;
      const head = h("span", { cls: "r-tool-head" },
        icon(L.toolIcon(name), { size: 16, className: live ? "r-tool-ic-live" : "" }),
        h("span", { cls: "r-tool-name", text: name }),
        tool.summary && h("span", { cls: `r-tool-sum${mono ? " mono" : ""}`, text: tool.summary }),
        live ? h("span", { cls: "r-tool-meta r-tool-meta-live", text: "Running" })
          : diff ? h("span", { cls: "r-tool-meta mono" }, h("span", { cls: "r-diff-add", text: `+${diff.add}` }), " ", h("span", { cls: "r-diff-rm", text: `−${diff.rm}` }))
            : icon("chevron-right", { size: 16, className: "r-tool-chev" }));
      const el = h("button", { cls: `r-tool${live ? " is-live" : ""}`, attrs: { "aria-label": `${name} ${tool.summary ?? ""}. Open output`.replace(/\s+/g, " ") }, on: { click: () => onOpenTool(message) } }, head,
        lines.length && h("span", { cls: "r-tool-tail mono" }, ...lines.map(line => h("span", { cls: "r-tool-line", text: line }))),
        diff && h("span", { cls: "r-tool-diff mono" }, ...diff.lines.map(line => h("span", { cls: `r-tool-dline is-${line.kind}`, text: `${line.kind === "add" ? "+" : "−"} ${line.text}` }))));
      return el;
    }

    function build(message, ref, live) {
      switch (message.role) {
        case "user": { const el = userRow(message); bindMenu(el, ref); return el; }
        case "assistant": { const el = assistantRow(message); bindMenu(el, ref); return el; }
        case "tool": return toolRow(message, live);
        default: return noticeRow(message);
      }
    }
    const sigOf = (message, live) => JSON.stringify([message.role, message.text, message.echo, message.tool, live]);

    function render(view, extras = {}) {
      const keep = scroll.scrollTop;
      const messages = (view?.messages ?? []).filter(message => message.role !== "thinking"); // the phone never shows model reasoning
      current = messages;
      if (view && view.tabId !== shownTab) { shown = new Set(); shownTab = view.tabId; firstRender = true; cache.clear(); }
      const seen = new Map(), next = [], fresh = [];
      messages.forEach((message, index) => {
        const base = C.messageKey(message);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const key = `${base}#${n}`;
        const live = L.isLiveTool(messages, index, view?.busy);
        const sig = sigOf(message, live);
        let entry = cache.get(key);
        if (!entry || entry.sig !== sig) {
          entry = { sig, index, el: null };
          entry.el = build(message, entry, live);
          if (!shown.has(key) && !firstRender) fresh.push(entry.el);
        }
        entry.index = index; // the menu reads it when pressed
        next.push([key, entry]);
      });
      cache.clear();
      for (const [key, entry] of next) cache.set(key, entry);
      shown = new Set(next.map(([key]) => key));
      for (const el of fresh) el.classList.add("is-new");
      const els = next.map(([, entry]) => entry.el);
      if (els.length !== rows.children.length || els.some((el, i) => rows.children[i] !== el)) rows.replaceChildren(...els);

      const notes = [];
      if (extras.stopped) notes.push(h("div", { cls: "r-chat-note", attrs: { role: "status" } }, icon("stop", { size: 15 }), h("span", { text: L.COPY.stoppedNote })));
      if (extras.idleNote) notes.push(h("div", { cls: "r-chat-idle", text: extras.idleNote }));
      tail.replaceChildren(...notes);

      const repin = C.repinFor(P, { tabId: lastTab, lastId: lastTail }, view);
      lastTab = view?.tabId ?? null;
      lastTail = messages.at(-1)?.id ?? null;
      const result = P.afterOutput({ pinned, follow: true, repin: repin || firstRender }, metrics());
      pinned = result.pinned;
      if (result.stick) toBottom(); else scroll.scrollTop = keep;
      prevTop = scroll.scrollTop;
      if (view) firstRender = false;
      updateJump();
    }

    return { stage, asksHost, render, messages: () => current, scrollToEnd: () => { pinned = true; toBottom(); updateJump(); } };
  }

  root.OMP_REMOTE_CHAT_TRANSCRIPT = { create, copyText, decorateMarkdown };
})(typeof window !== "undefined" ? window : globalThis);
