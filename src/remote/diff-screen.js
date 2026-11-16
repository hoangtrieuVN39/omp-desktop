// Diff screen (Diff.dc.html), pushed from the Review list: one file in full
// with its change inline (query gitFile): old/new line numbers, unchanged runs
// folded to "⋯ N unchanged lines" (tap to open), Previous/Next change, line
// wrap. Accept (stage, `gitAccept`) and Reject… (`gitReject`, confirm sheet)
// need Manage; a view/control phone reads the diff and sees the locked pair.
// Registered as the pushed screen 'diff', params { path, paths? } (paths = the
// Review list in order, for "Next file"). Rows come from OMP_REMOTE_DIFF.
(function (root) {
  const R = root.OMP_REMOTE_REVIEW, D = root.OMP_REMOTE_DIFF;
  const SYNC_PAUSE_MS = 500, TOP_PAD = 60;

  function factory(ctx) {
    const { M, P, ui } = ctx;
    const { h, icon, button } = P;
    const st = { path: "", paths: [], status: "idle", view: null, error: null, built: null, expanded: new Set(), current: 0, wrap: true, done: null };
    let seq = 0, rowEls = [], pausedUntil = 0, frame = 0;

    // ── frame ────────────────────────────────────────────────────────────
    const nameEl = h("div", { cls: "mono r-df-name" });
    const metaEl = h("div", { cls: "mono r-df-meta" });
    const wrapBtn = h("button", { cls: "r-df-icon", attrs: { "aria-label": "Toggle line wrap", "aria-pressed": "true" }, on: { click: toggleWrap } }, icon("wrap"));
    const jumpLabel = h("span", { cls: "r-df-jump-label" });
    const prevBtn = h("button", { cls: "r-df-step", attrs: { "aria-label": "Previous change" }, on: { click: () => jump(st.current - 1) } }, icon("chevron-up", { size: 18 }));
    const nextBtn = h("button", { cls: "r-df-step", attrs: { "aria-label": "Next change" }, on: { click: () => jump(st.current + 1) } }, icon("chevron-down", { size: 18 }));
    const jumpRow = h("div", { cls: "r-df-jump", hidden: true }, jumpLabel, prevBtn, nextBtn);
    const head = h("header", { cls: "r-df-head" },
      h("div", { cls: "r-df-top" }, P.iconButton({ icon: "back", label: "Back to changes", onClick: () => ui.back() }), h("div", { cls: "r-df-file" }, nameEl, metaEl), wrapBtn),
      jumpRow);
    const rowsEl = h("div", { cls: "r-df-rows" });
    const scroll = h("div", { cls: "r-df-scroll", attrs: { tabindex: "0", "aria-label": "File diff" } }, rowsEl);
    const noticeEl = h("div", { cls: "r-df-notice r-slot" });
    const foot = h("div", { cls: "r-df-foot" });
    const el = h("section", { cls: "r-screen r-df", attrs: { "aria-label": "Diff" } }, head, noticeEl, scroll, foot);
    scroll.addEventListener("scroll", () => {
      if (frame || Date.now() < pausedUntil || !st.built?.changes.length) return;
      frame = root.requestAnimationFrame(() => { frame = 0; syncFromScroll(); });
    });

    // ── data ─────────────────────────────────────────────────────────────
    async function load() {
      const my = ++seq;
      st.status = "loading"; st.view = null; st.built = null; st.error = null;
      renderAll();
      try {
        const view = await ctx.query("gitFile", { args: { path: st.path } });
        if (my !== seq) return;
        st.view = view; st.status = "ready";
      } catch (error) {
        if (my !== seq) return;
        st.status = "error"; st.error = error;
      }
      rebuild(true);
    }

    function rebuild(first) {
      const keep = scroll.scrollTop;
      st.built = st.view ? D.build(st.view, { expanded: st.expanded }) : null;
      renderAll();
      if (first) { st.current = 0; if (st.built?.changes.length) jump(0, { smooth: false }); } else scroll.scrollTop = keep;
    }

    // ── rendering ────────────────────────────────────────────────────────
    function lineEl(row) {
      const kind = row.kind;
      return h("div", { cls: `r-ln r-ln-${kind}` },
        h("span", { attrs: { "aria-hidden": "true" }, text: row.old ?? "" }),
        h("span", { attrs: { "aria-hidden": "true" }, text: row.new ?? "" }),
        h("span", { attrs: { "aria-hidden": "true" }, text: kind === "add" ? "+" : kind === "rem" ? "−" : "" }),
        h("span", { text: row.text }));
    }
    function foldEl(row) {
      return h("button", { cls: "r-fold mono", attrs: { "aria-label": `Show ${row.count} unchanged lines` }, on: { click: () => { st.expanded.add(row.id); rebuild(false); } } },
        `⋯ ${row.count} unchanged ${row.count === 1 ? "line" : "lines"}`);
    }

    function renderHead() {
      const { dir, name } = R.splitPath(st.path);
      const kind = R.kindOf(st.view?.status);
      nameEl.textContent = name;
      metaEl.replaceChildren(...[dir, kind?.code, st.built && (st.built.adds || st.built.rems) ? statNode() : null]
        .filter(Boolean).flatMap((part, i) => (i ? [" · ", part] : [part])));
      const changes = st.built?.changes ?? [];
      jumpRow.hidden = !changes.length;
      jumpLabel.textContent = `Change ${st.current + 1} of ${changes.length}`;
      prevBtn.disabled = st.current <= 0;
      nextBtn.disabled = st.current >= changes.length - 1;
    }
    function statNode() {
      const { adds, rems } = st.built;
      return h("span", {}, adds > 0 && h("span", { cls: "r-add", text: `+${adds}` }), adds > 0 && rems > 0 && " ", rems > 0 && h("span", { cls: "r-rm", text: `−${rems}` }));
    }

    function messageNode() {
      if (st.status === "loading" || st.status === "idle") return P.skeleton(4);
      if (st.status === "error") {
        const kind = R.classifyError(st.error);
        if (kind === "not-repo") return P.emptyState({ icon: "branch", title: "Not a git repository", body: R.COPY.notGit });
        return h("div", { cls: "r-stack" }, P.callout({ tone: "error", icon: "st-error", title: "Couldn’t load this diff", body: M.errorFeedback(st.error).text, mono: true }),
          button({ label: "Retry", variant: "secondary", onClick: load }));
      }
      switch (D.stateOf(st.view)) {
        case "binary": return P.emptyState({ icon: "tool-file", title: "Binary file", body: "There is no text diff for this file." });
        case "too-large": return P.emptyState({ icon: "tool-file", title: "File too large", body: "This file is too big to diff on the phone. Open it on the desktop." });
        case "missing": return P.emptyState({ icon: "tool-file", title: "File not found", body: "It no longer exists in the work tree or in the last commit." });
        case "clean": return P.emptyState({ icon: "check", title: "No changes", body: "This file matches the last commit." });
        default: return null;
      }
    }

    function renderBody() {
      const message = messageNode();
      scroll.classList.toggle("is-nowrap", !st.wrap);
      if (message || !st.built) {
        rowEls = [];
        rowsEl.replaceChildren(h("div", { cls: "r-df-message" }, message ?? ""));
        noticeEl.replaceChildren();
        return;
      }
      scroll.style.setProperty("--gut", `${Math.max(30, D.gutterDigits(st.built.rows) * 7 + 10)}px`);
      rowEls = st.built.rows.map(row => (row.type === "fold" ? foldEl(row) : lineEl(row)));
      rowsEl.replaceChildren(...rowEls);
      noticeEl.replaceChildren(...(st.built.capped ? [P.callout({ tone: "warn", icon: "warning", body: R.COPY.tooBig })] : []));
      markCurrent();
    }

    function markCurrent() {
      for (const rowEl of rowEls) rowEl.classList?.remove("is-current");
      const change = st.built?.changes[st.current];
      if (change) for (let i = change.from; i <= change.to; i++) rowEls[i]?.classList.add("is-current");
    }

    let footSig = "";
    function renderFoot() {
      const state = ctx.state();
      const sig = JSON.stringify([state.connected, state.legacy, state.scope, st.done, st.status, st.view?.kind ?? null, st.path]);
      if (sig === footSig) return;
      footSig = sig;
      foot.replaceChildren();
      const { name } = R.splitPath(st.path);
      if (st.done) {
        const next = nextPath();
        foot.append(h("div", { cls: "r-df-done", attrs: { role: "status" } },
          icon("check", { className: st.done === "accept" ? "r-ok" : "r-bad" }),
          h("span", { cls: "r-df-done-text", text: D.doneText(st.done, name) }),
          button({ label: next ? "Next file" : "Back to changes", variant: "ghost", size: "sm", onClick: () => (next ? ui.navigate("diff", { path: next, paths: st.paths }) : ui.back()) })));
        return;
      }
      const usable = st.status === "ready" && st.view && st.view.kind !== "Missing";
      const gated = M.gate(state, "gitAccept");
      if (!gated.ok) {
        foot.classList.add("is-locked");
        foot.append(
          button({ label: "Reject…", icon: "lock", variant: "secondary", cls: "r-btn-locked", onClick: () => ctx.lockToast(gated, "Rejecting files") }),
          button({ label: "Accept (stage)", icon: "lock", variant: "secondary", cls: "r-btn-locked", onClick: () => ctx.lockToast(gated, "Accepting files") }),
          h("span", { cls: "r-df-lock-note", text: state.scope === "view" ? M.COPY.scopeView : gated.label || "Unavailable" }));
        return;
      }
      foot.classList.remove("is-locked");
      foot.append(
        button({ label: "Reject…", variant: "danger", disabled: !usable, onClick: reject }),
        button({ label: "Accept (stage)", variant: "primary", disabled: !usable, onClick: accept }));
    }

    function renderAll() { renderHead(); renderBody(); renderFoot(); }

    // ── navigation inside the file ───────────────────────────────────────
    function jump(index, { smooth = true } = {}) {
      const changes = st.built?.changes ?? [];
      if (!changes.length) return;
      st.current = Math.min(changes.length - 1, Math.max(0, index));
      pausedUntil = Date.now() + SYNC_PAUSE_MS;
      const target = rowEls[changes[st.current].from];
      if (target) scroll.scrollTo?.({ top: Math.max(0, target.offsetTop - TOP_PAD), behavior: smooth ? "smooth" : "auto" });
      renderHead(); markCurrent();
    }
    function syncFromScroll() {
      const changes = st.built?.changes ?? [];
      if (!changes.length) return;
      const top = scroll.scrollTop + TOP_PAD + 8;
      let at = 0;
      for (let i = 0; i < changes.length; i++) if ((rowEls[changes[i].from]?.offsetTop ?? 0) <= top) at = i;
      if (at === st.current) return;
      st.current = at;
      renderHead(); markCurrent();
    }
    function toggleWrap() {
      st.wrap = !st.wrap;
      wrapBtn.setAttribute("aria-pressed", String(st.wrap));
      wrapBtn.classList.toggle("is-on", !st.wrap);
      scroll.classList.toggle("is-nowrap", !st.wrap);
    }
    function nextPath() {
      const at = st.paths.indexOf(st.path);
      return at >= 0 ? st.paths[at + 1] ?? null : null;
    }

    // ── actions ──────────────────────────────────────────────────────────
    async function accept() {
      const result = await ctx.act("gitAccept", { args: { path: st.path } }, { label: "Accept" });
      if (!result.ok) return;
      R.accepted.mark(st.path, st.view?.status ?? null);
      st.done = "accept"; renderFoot();
    }

    async function reject() {
      const status = st.view?.status;
      const { name } = R.splitPath(st.path);
      const copy = D.rejectCopy(name, status, st.built?.adds ?? 0, st.built?.rems ?? 0, R.discardDeletes(status));
      if (!await confirmReject(copy)) return;
      const result = await ctx.act("gitReject", { args: { path: st.path } }, { label: "Reject" });
      if (!result.ok) return;
      R.accepted.forget(st.path);
      st.done = copy.deletes ? "delete" : "reject"; renderFoot();
    }

    // The destructive confirm (Diff.dc.html): an inset card with an icon tile,
    // the file named in the title, and Discard / Cancel. Same contract as
    // ui.confirm: Cancel, Esc, backdrop and swipe all answer false.
    function confirmReject(copy) {
      return new Promise(resolve => {
        let answered = false, handle = null;
        const answer = value => { answered = true; resolve(value); handle?.close("answer"); };
        const body = h("div", { cls: "r-reject", attrs: { role: "alertdialog" } },
          h("div", { cls: "r-reject-tile" }, icon("discard", { size: 22 })),
          h("h2", { cls: "r-reject-title", text: copy.title }),
          h("p", { cls: "r-reject-text" }, ...copy.parts.map(part => (part.bold ? h("b", { text: part.bold }) : part.text))),
          h("div", { cls: "r-reject-actions" },
            button({ label: copy.confirmLabel, variant: "danger-fill", size: "lg", cls: "r-btn-block", onClick: () => answer(true) }),
            button({ label: "Cancel", variant: "secondary", size: "lg", cls: "r-btn-block", onClick: () => answer(false) })));
        handle = ui.openSheet({ label: copy.title, bare: true, flush: true, body, onClose: () => { if (!answered) resolve(false); } });
        handle.el.classList.add("r-sheet-float");
      });
    }

    return {
      el,
      show(params) {
        const path = String(params?.path ?? "");
        st.paths = Array.isArray(params?.paths) ? params.paths : [];
        Object.assign(st, { path, done: null, expanded: new Set(), current: 0 });
        load();
      },
      update() { renderFoot(); },
    };
  }

  root.OMP_REMOTE_UI.registerScreen("diff", factory);
})(typeof window !== "undefined" ? window : globalThis);
