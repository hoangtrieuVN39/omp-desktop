// Review tab (Review.dc.html): the tab's branch, the pull request / CI card
// (query prStatus) and the changed files (query gitStatus), each row opening
// the Diff screen. The branch button opens the 'branch-switch' sheet
// (review-branch.js) and is locked while the agent runs or without Manage;
// the folder button opens the project file browser (review-files.js).
// Mapping from desktop answers to rows is OMP_REMOTE_REVIEW (review-model.js).
// Registered as the 'review' tab. A view/control phone reads everything; only
// the branch switch (and Accept/Reject on the Diff screen) needs Manage.
(function (root) {
  const R = root.OMP_REMOTE_REVIEW;
  const PR_RETRY_MS = 1000, PR_RETRIES = 4;

  function factory(ctx) {
    const { M, P, ui } = ctx;
    const { h, icon, button } = P;
    const data = { status: null, statusState: "idle", statusError: null, pr: { state: "idle" }, tabId: null };
    let statusSeq = 0, prSeq = 0, prTimer = null, version = 0, signature = "", visible = false, wasBusy = false;

    // ── static frame ─────────────────────────────────────────────────────
    const refreshBtn = P.iconButton({ icon: "refresh", label: "Refresh changes", variant: "line", onClick: () => reload() });
    const browseBtn = P.iconButton({ icon: "folder", label: "Browse project files", variant: "line", onClick: () => ui.navigate("review-files", { view: data.status }) });
    const subEl = h("div", { cls: "r-rv-sub", hidden: true });
    const branchSlot = h("div", { cls: "r-slot r-rv-branch-slot" });
    const headEl = h("header", { cls: "r-header r-header-lg r-rv-head" },
      h("div", { cls: "r-rv-top" }, h("h1", { cls: "r-title r-title-lg", text: "Review" }), refreshBtn, browseBtn), subEl, branchSlot);
    const body = h("div", { cls: "r-scroll r-rv-body" });
    const el = h("section", { cls: "r-screen", attrs: { "aria-label": "Review" } }, headEl, body);

    // ── helpers ──────────────────────────────────────────────────────────
    const stat = (add, rem) => h("span", { cls: "mono r-diffstat" }, add > 0 && h("span", { cls: "r-add", text: `+${add}` }), add > 0 && rem > 0 && " ", rem > 0 && h("span", { cls: "r-rm", text: `−${rem}` }));
    const tabTitle = state => state.tabs.find(tab => tab.id === ctx.anchorTab())?.title || "";
    const supported = state => state.connected && !state.legacy && Boolean(ctx.conn.proto?.canQuery("gitStatus"));
    const touch = () => { version++; render(ctx.state()); };

    // ── loading ──────────────────────────────────────────────────────────
    async function loadStatus() {
      const state = ctx.state();
      if (!supported(state) || !ctx.anchorTab()) return;
      const seq = ++statusSeq;
      data.tabId = ctx.anchorTab();
      if (data.statusState !== "ready") { data.statusState = "loading"; touch(); }
      try {
        const view = await ctx.query("gitStatus");
        if (seq !== statusSeq) return;
        data.status = view; data.statusState = "ready"; data.statusError = null;
      } catch (error) {
        if (seq !== statusSeq) return;
        data.statusState = "error"; data.statusError = error;
      }
      touch();
    }
    async function loadPr(attempt = 0) {
      const state = ctx.state();
      root.clearTimeout(prTimer);
      if (!supported(state) || !ctx.anchorTab() || !ctx.conn.proto?.canQuery("prStatus")) return;
      const seq = ++prSeq;
      if (data.pr.state !== "ready") { data.pr = { state: "loading" }; touch(); }
      try {
        const value = await ctx.query("prStatus");
        if (seq !== prSeq) return;
        if (R.prIsStale(value)) {
          // The tab is mid-switch: not "no PR". Ask again shortly.
          if (attempt < PR_RETRIES) prTimer = root.setTimeout(() => loadPr(attempt + 1), PR_RETRY_MS);
          else data.pr = { state: "none" };
        } else {
          const card = R.prCard(value);
          data.pr = card ? { state: "ready", card } : { state: "none" };
        }
      } catch (error) {
        if (seq !== prSeq) return;
        data.pr = { state: "error", error };
      }
      touch();
    }
    function reload() { loadStatus(); loadPr(); }

    // ── pieces ───────────────────────────────────────────────────────────
    function branchButton(state) {
      const label = R.branchLabel(data.status?.repo);
      const gated = ctx.gate("gitSwitchBranch");
      const busy = gated.ok && R.isBusy(state, ctx.anchorTab());
      const locked = !gated.ok || busy;
      const note = !gated.ok ? (gated.label || "Unavailable") : busy ? "Locked while agent runs" : "";
      const el = h("button", { cls: `r-rv-branch${locked ? " is-locked" : ""}`, attrs: { "aria-disabled": locked ? "true" : undefined, "aria-label": ["Branch", label.text, note || "Switch branch"].join(". "), "data-action": "branch" } },
        icon("branch", { size: 17, className: "r-rv-branch-ic" }),
        h("span", { cls: "mono r-rv-branch-name", text: label.text }),
        locked ? icon("lock", { size: 15, className: "r-rv-branch-lock" }) : icon("chevron-down", { size: 15, className: "r-rv-branch-lock" }),
        note && h("span", { cls: "r-rv-branch-note", text: note }));
      el.addEventListener("click", () => {
        if (!gated.ok) return ctx.lockToast(gated, "Switching branches");
        if (R.isBusy(ctx.state(), ctx.anchorTab())) return ui.toast({ tone: "lock", text: R.COPY.branchLocked, duration: 5000 });
        ui.openSheetById("branch-switch", { current: label.text, onSwitched: reload });
      });
      return el;
    }

    function prNode() {
      const pr = data.pr;
      if (pr.state === "loading") return h("section", { cls: "r-card r-pr", attrs: { "aria-label": "Pull request" } }, P.skeleton(1));
      if (pr.state === "error") {
        const retry = !/\bgh\b|github cli/i.test(String(pr.error?.message ?? ""));
        return h("section", { cls: "r-stack", attrs: { "aria-label": "Pull request" } },
          P.callout({ tone: "warn", icon: "warning", title: "Pull request status unavailable", body: R.prErrorCopy(pr.error) }),
          retry && button({ label: "Retry", variant: "secondary", onClick: () => loadPr() }));
      }
      if (pr.state !== "ready") return null;
      const card = pr.card;
      return h("section", { cls: "r-card r-pr", attrs: { "aria-label": "Pull request" } },
        h("div", { cls: "r-pr-head" },
          h("span", { cls: "r-pr-num", text: `#${card.number}` }),
          h("span", { cls: "r-pr-title", text: card.title }),
          card.draft && P.chip("Draft"),
          stat(card.additions, card.deletions)),
        card.pills.length > 0 && h("div", { cls: "r-checks", attrs: { role: "list", "aria-label": "Checks" } },
          ...card.pills.map(pill => h("span", { cls: `r-check r-check-${pill.state}`, attrs: { role: "listitem" } }, icon(pill.icon, { size: 13, className: pill.state === "running" ? "spin" : "" }), h("span", { text: pill.label }))),
          card.more > 0 && h("span", { cls: "r-check r-check-neutral", text: `+${card.more} more` })));
    }

    function fileRow(row, paths) {
      const kind = row.kind;
      return h("button", { cls: "r-file-row", attrs: { "data-path": row.path, "aria-label": `${row.name}, ${kind.word}${row.dir ? ` in ${row.dir}` : ""}` }, on: { click: () => ui.navigate("diff", { path: row.path, paths }) } },
        h("span", { cls: `r-badge r-badge-${kind.tone} mono`, attrs: { title: kind.word, "aria-hidden": "true" }, text: kind.code }),
        h("span", { cls: "r-file-text" }, h("span", { cls: "mono r-file-name", text: row.name }), h("span", { cls: "mono r-file-sub", text: row.sub })),
        icon("chevron-right", { size: 16, className: "r-file-go" }));
    }

    function changesNode() {
      const list = R.changeList(data.status, R.accepted);
      const branch = data.status?.repo?.branch ?? "";
      if (!list.total) return P.emptyState({ icon: "check", title: "No changes", body: R.clean(branch).replace(/^No changes\.\s*/, "") });
      const paths = list.files.map(row => row.path);
      const kids = [h("div", { cls: "r-rv-section-head" }, h("h2", { cls: "r-section-title", text: `Changes · ${list.files.length} ${list.files.length === 1 ? "file" : "files"}` }))];
      if (list.files.length) kids.push(h("div", { cls: "r-card r-file-list" }, ...list.files.map(row => fileRow(row, paths))));
      else kids.push(P.emptyState({ icon: "check", title: "All reviewed", body: "Every changed file is staged." }));
      if (list.accepted.length) {
        const n = list.accepted.length;
        kids.push(h("div", { cls: "r-rv-accepted" }, icon("check", { size: 16 }),
          h("span", {}, `${n} ${n === 1 ? "file" : "files"} accepted (staged) · `, h("span", { cls: "mono", text: list.accepted.map(row => row.name).join(", ") }))));
      }
      return h("section", { cls: "r-block" }, ...kids);
    }

    function stateNode(state) {
      if (!state.connected && !data.status) return P.emptyState({ icon: "offline", title: "Not connected", body: M.COPY.opOffline });
      if (state.connected && !supported(state)) return P.emptyState({ icon: "nav-review", title: "Review isn’t available", body: M.COPY.opTooOld });
      if (!ctx.anchorTab()) return P.emptyState({ icon: "nav-chat", title: "No open tab", body: R.COPY.noTab });
      if (data.statusState === "error") {
        const kind = R.classifyError(data.statusError);
        if (kind === "not-repo") return P.emptyState({ icon: "branch", title: "Not a git repository", body: R.COPY.notGit });
        if (kind === "no-folder") return P.emptyState({ icon: "folder", title: "No project folder", body: "This tab has no project folder to review." });
        return h("div", { cls: "r-stack" },
          P.callout({ tone: "error", icon: "st-error", title: "Couldn’t load changes", body: M.errorFeedback(data.statusError).text, mono: true }),
          button({ label: "Retry", variant: "secondary", onClick: reload }));
      }
      if (!data.status) return P.skeleton(3);
      return null;
    }

    // ── render ───────────────────────────────────────────────────────────
    function render(state) {
      const busy = R.isBusy(state, ctx.anchorTab());
      const sig = JSON.stringify([version, state.connected, state.legacy, state.scope, busy, ctx.anchorTab(), tabTitle(state), R.accepted.size()]);
      if (sig === signature) return;
      signature = sig;
      const repoReady = Boolean(data.status) && data.statusState !== "error";
      const title = tabTitle(state);
      const sub = repoReady ? `${data.status.repo?.name ?? ""}${title ? " · from tab " : ""}` : "";
      subEl.replaceChildren(...[sub, title && h("b", { text: title })].filter(Boolean));
      subEl.hidden = !repoReady;
      branchSlot.replaceChildren(...(repoReady ? [branchButton(state)] : []));
      refreshBtn.querySelector(".ic")?.classList.toggle("spin", data.statusState === "loading");
      refreshBtn.setAttribute("aria-busy", String(data.statusState === "loading"));
      const gate = stateNode(state);
      body.replaceChildren(...(gate ? [gate] : [prNode(), changesNode()].filter(Boolean)));
    }

    function update(state) {
      render(state);
      const busy = R.isBusy(state, ctx.anchorTab());
      // The agent just finished a turn: its edits are on disk now.
      const finished = wasBusy && !busy;
      wasBusy = busy;
      if (!visible) return;
      if (finished || (state.connected && data.statusState === "idle") || (data.tabId && ctx.anchorTab() !== data.tabId)) reload();
    }

    return {
      el, update,
      show() { visible = true; signature = ""; render(ctx.state()); reload(); },
      hide() { visible = false; root.clearTimeout(prTimer); },
    };
  }

  root.OMP_REMOTE_UI.registerScreen("review", factory);
})(typeof window !== "undefined" ? window : globalThis);
