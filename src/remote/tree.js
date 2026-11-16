// Conversation tree (Tree.dc.html), pushed from the session menu with
// navigate('tree', { tabId }). Loads the desktop's `conversationTree` query,
// runs the pure OMP_CONV_TREE.buildModel (the same model the desktop uses),
// draws its lanes/rows/cache badges and branch tabs, and shows the selected
// prompt in a persistent bottom detail panel. `branchAt` hands its prompt
// back to the Chat composer; another file's head opens through the saved
// session id derived by the same opaqueId as remote-ops.js.
// The pure display decisions live in tree-model.js.
(function (root) {
  const NS = "http://www.w3.org/2000/svg";
  const RECOVERED = "The conversation tree is not available in this build.";
  const svgEl = tag => root.document.createElementNS(NS, tag);

  function factory(ctx) {
    const { M, P, ui } = ctx;
    const { h, icon, button } = P, T = root.OMP_REMOTE_TREE;
    let tabId = null, tree = null, model = null, selected = null, selectedBranch = null, status = "idle", error = "", seq = 0;
    let busyBefore = false;

    const header = P.header({ title: "Conversation tree", back: "Back to chat", onBack: () => ui.back() });
    const refresh = P.iconButton({ icon: "refresh", label: "Refresh tree", onClick: () => load() });
    header.actions.append(refresh);
    const tabs = h("div", { cls: "r-tr-tabs", attrs: { role: "tablist", "aria-label": "Branches" } });
    const headerWrap = h("div", { cls: "r-tr-header" }, header.el, tabs);
    const rows = h("div", { cls: "r-tr-rows", attrs: { role: "list", "aria-label": "Prompts in conversation order" } });
    const detail = h("section", { cls: "r-tr-detail", attrs: { "aria-label": "Selected prompt" } });
    const el = h("section", { cls: "r-screen r-tr-screen", attrs: { "aria-label": "Conversation tree" } }, headerWrap, rows, detail);

    function load() {
      if (!tabId) { status = "error"; error = "Open a session on the desktop first."; render(); return; }
      if (!ctx.conn.state().connected || !ctx.proto?.canQuery("conversationTree")) {
        status = "error"; error = ctx.conn.state().connected ? "This desktop is too old for the conversation tree." : "Not connected to the desktop.";
        render(); return;
      }
      if (!root.OMP_CONV_TREE?.buildModel) { status = "error"; error = RECOVERED; render(); return; }
      const mine = ++seq;
      status = "loading"; error = ""; render();
      ctx.query("conversationTree", { tabId }).then(data => {
        if (mine !== seq) return;
        tree = data;
        try { model = T.prepare(data, { now: Date.now(), buildModel: root.OMP_CONV_TREE.buildModel, hhmm: M.hhmm }); }
        catch (err) { model = null; error = err?.message ?? "Couldn’t read the tree."; }
        status = model ? "ready" : "error";
        if (!model && !error) error = "The tree had no readable entries.";
        const current = model?.rows.filter(r => r.kind === "prompt" && r.onCurrentPath);
        selected = current?.at(-2)?.id ?? current?.at(-1)?.id ?? model?.rows.find(r => r.kind === "prompt")?.id ?? null;
        selectedBranch = model?.branches.find(b => b.current)?.id ?? model?.branches[0]?.id ?? null;
        render();
      }).catch(err => {
        if (mine !== seq) return;
        status = "error"; error = M.errorFeedback(err).text; render();
      });
    }

    function rowGraph(row, chosen) {
      const svg = svgEl("svg");
      svg.setAttribute("viewBox", `0 0 ${T.ROW_W} ${T.ROW_H}`);
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");
      for (const p of row.geometry) {
        const path = svgEl("path");
        path.setAttribute("d", p.d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke-width", "2.5");
        path.style.stroke = p.color;
        if (p.state === "cold" || p.state === "unknown") path.classList.add("is-dim");
        svg.append(path);
      }
      const x = T.laneX(row.lane, model.lanes);
      if (row.branchHead && row.shape === "diamond") {
        const diamond = svgEl("path");
        diamond.setAttribute("d", `M${x} ${T.MID - 5}l5 5-5 5-5-5Z`);
        diamond.style.fill = T.laneColor(row.lane);
        svg.append(diamond);
      } else {
        const circle = svgEl("circle");
        circle.setAttribute("cx", String(x)); circle.setAttribute("cy", String(T.MID));
        circle.setAttribute("r", String(chosen ? 7 : 5));
        circle.setAttribute("stroke-width", chosen || row.branchHead ? "2.5" : "0");
        circle.style.stroke = chosen ? "var(--fg)" : T.laneColor(row.lane);
        circle.style.fill = row.branchHead && !chosen ? "var(--bg-app)" : T.laneColor(row.lane);
        svg.append(circle);
      }
      return h("div", { cls: "r-tr-graph" }, svg);
    }

    function cacheBadge(row) {
      return h("span", { cls: `r-tr-cache is-${row.chip.state}` },
        h("span", { attrs: { "aria-hidden": "true" }, text: row.chip.glyph }), h("span", { text: row.chip.text }));
    }
    function promptRow(row) {
      const chosen = selected === row.id;
      const meta = [];
      if (row.currentTip) meta.push(h("span", { cls: "r-tr-head is-current", text: "You are here" }));
      else if (row.branchHead) meta.push(h("span", { cls: "r-tr-head is-branch", text: "Branch head" }));
      else meta.push(h("span", { cls: "mono", text: `#${row.ordinal}` }));
      if (row.openFile && row.branchHead) meta.push(h("span", { cls: "r-tr-open", text: "Open in new tab ›" }));
      meta.push(cacheBadge(row));
      if (row.price) meta.push(h("span", { text: row.price }));
      return h("button", { cls: `r-tr-row${chosen ? " is-selected" : ""}${row.onCurrentPath ? "" : " is-other"}`, attrs: { role: "listitem", "aria-pressed": String(chosen), "data-entry-id": row.id }, on: { click: () => { selected = row.id; render(); } } },
        rowGraph(row, chosen), h("span", { cls: "r-tr-text" }, h("span", { cls: "r-tr-prompt", text: row.text }), h("span", { cls: "r-tr-meta" }, ...meta)));
    }
    function compactionRow(row) {
      return h("div", { cls: "r-tr-compaction", attrs: { role: "separator" } }, h("span"), h("span", { text: row.label }), h("span"));
    }

    function branchTabs() {
      if (!model) { tabs.replaceChildren(); return; }
      const nodes = model.branches.map((branch, index) => {
        const chosen = branch.id === selectedBranch;
        const b = h("button", { cls: `r-tr-tab${chosen ? " is-current" : ""}`, attrs: { role: "tab", "aria-selected": String(chosen), tabindex: chosen ? "0" : "-1", "data-branch": branch.id },
          on: {
            click: () => selectBranch(branch),
            keydown: event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const at = event.key === "Home" ? 0 : event.key === "End" ? model.branches.length - 1
                : (index + (event.key === "ArrowRight" ? 1 : -1) + model.branches.length) % model.branches.length;
              selectBranch(model.branches[at]); tabs.querySelectorAll("[role=tab]")[at]?.focus();
            },
          } }, h("span", { cls: `r-tr-tab-dot is-${T.laneShape(branch.lane)}` }), h("span", { text: `${branch.label}${branch.count ? ` · ${branch.count}` : ""}` }));
        b.style.setProperty("--branch-color", T.laneColor(branch.lane));
        return b;
      });
      tabs.replaceChildren(...nodes);
    }
    function selectBranch(branch) {
      selectedBranch = branch.id;
      const target = model.rows.find(r => r.id === branch.rowId);
      if (target) selected = target.id;
      render();
      rows.querySelector(`[data-entry-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    async function openInNewTab(row) {
      if (!row.sessionId) return;
      const gated = ctx.gate("resumeSession");
      if (!gated.ok) return ctx.lockToast(gated, "Opening a branch");
      const result = await ctx.act("resumeSession", { tabId, args: { sessionId: row.sessionId } }, { label: "Open branch" });
      if (result.ok && result.value?.tabId) ctx.openTab(result.value.tabId);
    }

    function handToComposer(text) {
      ui.navigate("chat");
      if (root.OMP_REMOTE_CHAT_SCREEN?.setDraft) root.OMP_REMOTE_CHAT_SCREEN.setDraft(text);
      else root.navigator.clipboard?.writeText(text).then(() => ui.toast({ tone: "info", text: "Branch prompt copied — paste it into Chat." })).catch(() => ui.toast({ tone: "warn", text: "Couldn’t put the branch prompt in Chat." }));
    }
    async function branch(row) {
      const state = ctx.state();
      const lock = T.branchLock({ scope: state.scope, legacy: state.legacy, busy: Boolean(state.view?.busy), can: ctx.gate("branchAt").ok });
      if (lock) return ui.toast({ tone: "lock", text: lock.text });
      const result = await ctx.act("branchAt", { tabId, args: { entryId: row.id } }, { label: "Branch" });
      if (result.ok) handToComposer(result.value?.text ?? row.fullText);
    }
    async function copy(row) {
      try { await root.navigator.clipboard.writeText(row.fullText); ui.toast({ tone: "ok", text: "Prompt copied" }); }
      catch { ui.toast({ tone: "error", text: "Couldn’t copy the prompt." }); }
    }

    function detailPanel() {
      const row = model?.rows.find(r => r.id === selected);
      if (!row || row.kind !== "prompt") { detail.hidden = true; detail.replaceChildren(); return; }
      detail.hidden = false;
      const facts = T.detail(row, Date.now());
      const state = ctx.state();
      const lock = T.branchLock({ scope: state.scope, legacy: state.legacy, busy: Boolean(state.view?.busy), can: ctx.gate("branchAt").ok });
      const time = row.ts != null ? M.hhmm(row.ts) : "";
      detail.replaceChildren(
        h("div", { cls: "r-tr-detail-meta" }, h("span", { cls: "mono", text: `#${row.ordinal}` }), time && h("span", { text: `· ${time}` }), h("span", { cls: "r-tr-detail-cache", text: facts.cache })),
        h("p", { cls: "r-tr-detail-text", text: row.fullText }),
        facts.now && h("div", { cls: "r-tr-detail-cost" }, h("span", { text: `Re-ask cost ${facts.now}` }), facts.cold && h("span", { text: `vs ${facts.cold} cold` })),
        lock ? h("div", { cls: "r-tr-lock" }, icon("lock", { size: 16 }), h("span", { text: lock.text }))
          : h("div", { cls: "r-tr-actions" }, button({ label: "Copy prompt", variant: "secondary", cls: "r-grow", onClick: () => copy(row) }), button({ label: "Branch from here", variant: "primary", cls: "r-grow", onClick: () => branch(row) })),
        row.openFile && h("button", { cls: "r-tr-file", on: { click: () => openInNewTab(row) } }, icon("fork", { size: 16 }), h("span", { text: "Open this branch in a new tab" })));
    }

    function render() {
      const tab = ctx.state().tabs.find(t => t.id === tabId);
      header.subtitle(model ? T.subtitle(tab?.title ?? "", model.prompts, model.branchCount) : tab?.title ?? "");
      refresh.disabled = status === "loading";
      branchTabs();
      if (status === "loading" && !model) rows.replaceChildren(P.skeleton(5));
      else if (status === "error") rows.replaceChildren(P.callout({ tone: "error", icon: "st-error", title: "Couldn’t load the conversation tree", body: error }), button({ label: "Retry", variant: "secondary", onClick: load }));
      else if (!model?.rows.length) rows.replaceChildren(P.emptyState({ icon: "branch", title: "No prompts yet", body: "Start the conversation and try again." }));
      else rows.replaceChildren(...model.rows.map(r => r.kind === "compaction" ? compactionRow(r) : promptRow(r)));
      detailPanel();
    }

    return {
      el,
      show(params) { tabId = params?.tabId ?? ctx.anchorTab(); tree = null; model = null; selected = null; status = "idle"; error = ""; busyBefore = Boolean(ctx.state().view?.busy); load(); },
      hide() { seq++; },
      update(state) {
        if (state.view?.tabId === tabId) {
          const nowBusy = Boolean(state.view?.busy);
          if (busyBefore && !nowBusy && status === "ready") load();
          busyBefore = nowBusy;
        }
        if (status === "ready") detailPanel();
      },
    };
  }

  root.OMP_REMOTE_UI.registerScreen("tree", factory);
})(typeof window !== "undefined" ? window : globalThis);
