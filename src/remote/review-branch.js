// Branch switch sheet (opened from the Review tab's branch button). Lists the
// other branches (query gitBranches: local first, then remote-tracking, newest
// first; the checked-out branch is not in the list) and switches with the
// `gitSwitchBranch` action. A remote branch becomes a local tracking branch.
// Locked while the agent runs (CopyDeck branch.locked) and without Manage.
// Registered as the sheet 'branch-switch', params { current, onSwitched }.
(function (root) {
  const R = root.OMP_REMOTE_REVIEW;

  function open(ctx, params) {
    const { M, P, ui } = ctx;
    const { h, icon } = P;
    const gated = ctx.gate("gitSwitchBranch");
    if (!gated.ok) { ctx.lockToast(gated, "Switching branches"); return null; }
    if (R.isBusy(ctx.state(), ctx.anchorTab())) { ui.toast({ tone: "lock", text: R.COPY.branchLocked, duration: 5000 }); return null; }

    const form = { status: "loading", list: [], error: "", query: "", switching: null };
    let handle = null;
    const search = P.searchField({ placeholder: "Filter branches", label: "Filter branches", onInput: value => { form.query = value; renderList(); } });
    const listEl = h("div", { cls: "r-bl-list" });

    function branchRow(item) {
      const busy = form.switching === item.name;
      const row = h("button", { cls: `r-bl-row${busy ? " is-busy" : ""}`, attrs: { "data-branch": item.name, "data-remote": String(Boolean(item.remote)), "aria-disabled": form.switching ? "true" : undefined } },
        icon(busy ? "st-running" : "branch", { size: 18, className: busy ? "spin" : "r-bl-ic" }),
        h("span", { cls: "r-bl-text" },
          h("span", { cls: "mono r-bl-name", text: item.name }),
          item.remote && h("span", { cls: "r-bl-note", text: "Creates a local branch that tracks it" })),
        h("span", { cls: "r-bl-when", text: item.at ? M.relativeTime(item.at) : "" }));
      row.addEventListener("click", () => choose(item));
      return row;
    }

    function group(title, rows) {
      return rows.length ? h("section", { cls: "r-block r-bl-group" }, P.sectionTitle(title), h("div", { cls: "r-card" }, ...rows.map(branchRow))) : null;
    }

    function renderList() {
      if (form.status === "loading") return listEl.replaceChildren(P.skeleton(3));
      if (form.status === "error") {
        return listEl.replaceChildren(P.callout({ tone: "error", icon: "st-error", title: "Couldn’t load branches", body: form.error, mono: true }),
          P.button({ label: "Retry", variant: "secondary", onClick: load }));
      }
      const groups = R.branchGroups(form.list, form.query);
      const nodes = [group("Local", groups.local), group("Remote", groups.remote)].filter(Boolean);
      if (!nodes.length) {
        nodes.push(P.emptyState({ icon: "branch", title: form.query ? "No matches" : "No other branches", body: form.query ? "Try another part of the name." : "This repository only has the checked-out branch." }));
      }
      listEl.replaceChildren(...nodes);
    }

    async function load() {
      form.status = "loading"; renderList();
      try {
        const list = await ctx.query("gitBranches");
        form.list = Array.isArray(list) ? list : [];
        form.status = "ready";
      } catch (error) {
        form.status = "error"; form.error = M.errorFeedback(error).text;
      }
      renderList();
    }

    async function choose(item) {
      if (form.switching) return;
      if (R.isBusy(ctx.state(), ctx.anchorTab())) { ui.toast({ tone: "lock", text: R.COPY.branchLocked, duration: 5000 }); return; }
      form.switching = item.name; renderList();
      const result = await ctx.act("gitSwitchBranch", { args: { name: item.name, remote: Boolean(item.remote) } }, { label: "Switch branch" });
      form.switching = null;
      if (result.ok) {
        handle?.close("switched");
        ui.toast({ tone: "ok", text: `Switched to ${item.remote ? item.name.replace(/^[^/]+\//, "") : item.name}`, duration: 3000 });
        params?.onSwitched?.();
      } else renderList();
    }

    handle = ui.openSheet({
      label: "Switch branch", title: "Switch branch", subtitle: params?.current ? `On ${params.current}` : undefined,
      body: () => h("div", { cls: "r-bl" }, search.el, listEl),
    });
    renderList();
    load();
    return handle;
  }

  root.OMP_REMOTE_UI.registerSheet("branch-switch", open);
})(typeof window !== "undefined" ? window : globalThis);
