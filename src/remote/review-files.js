// Project file browser and file preview, pushed from Review (Review.dc.html
// folder button). Browse uses gitStatus's tree, so it includes unchanged
// tracked files as well as changes; preview queries readFile for a file's
// current bytes. Neither action requires Manage. The preview is text-only:
// images/binary/oversize files show an honest state, not an unsafe data URL.
// Registered screens 'review-files' and 'review-file'.
(function (root) {
  const R = root.OMP_REMOTE_REVIEW;
  const FIRST_LINES = 200, MAX_LINES = 2000;

  function browser(ctx) {
    const { M, P, ui } = ctx;
    const { h, icon } = P;
    let view = null, dir = "", query = "", status = "idle", error = null, seq = 0;
    const head = P.header({ title: "Project files", back: true, onBack: () => ui.back() });
    const crumb = h("div", { cls: "r-fb-crumb" });
    const search = P.searchField({ placeholder: "Find a file", label: "Find a file", onInput: value => { query = value; render(); } });
    const rows = h("div", { cls: "r-card r-fb-list" });
    const scroll = h("div", { cls: "r-scroll r-fb-body" }, crumb, search.el, rows);
    const el = h("section", { cls: "r-screen", attrs: { "aria-label": "Project files" } }, head.el, scroll);

    function row(node) {
      const kind = R.kindOf(node.status);
      return h("button", { cls: "r-fb-row", attrs: { "data-path": node.path }, on: { click: () => {
        if (node.dir) { dir = node.path; query = ""; search.input.value = ""; render(); }
        else ui.navigate("review-file", { path: node.path, status: node.status });
      } } },
        icon(node.dir ? "folder" : "tool-file", { className: node.dir ? "r-fb-folder" : "r-fb-file" }),
        h("span", { cls: "r-fb-text" }, h("span", { cls: "mono r-fb-name", text: node.name }),
          h("span", { cls: "r-fb-sub", text: node.dir ? `${node.changed ?? 0} changed` : kind ? kind.word : query ? node.path : "" })),
        kind && h("span", { cls: `r-badge r-badge-${kind.tone} mono`, text: kind.code }),
        icon("chevron-right", { size: 16, className: "r-file-go" }));
    }

    function render() {
      head.subtitle(view?.repo?.name ?? "");
      crumb.replaceChildren(h("button", { cls: "r-fb-crumb-link", text: "Project", on: { click: () => { dir = ""; render(); } } }),
        ...dir.split("/").filter(Boolean).map((part, i, parts) => h("span", { cls: "r-fb-crumb-part" },
          icon("chevron-right", { size: 14 }),
          h("button", { cls: "r-fb-crumb-link", text: part, on: { click: () => { dir = parts.slice(0, i + 1).join("/"); render(); } } }))));
      if (status === "loading" || status === "idle") return rows.replaceChildren(P.skeleton(3));
      if (status === "error") return rows.replaceChildren(P.callout({ tone: "error", icon: "st-error", title: "Couldn’t browse files", body: M.errorFeedback(error).text }), P.button({ label: "Retry", variant: "secondary", onClick: load }));
      const result = R.browseRows(view?.tree, dir, query);
      if (result.missing) { dir = ""; render(); return; }
      const kids = result.rows.map(row);
      if (result.more) kids.push(h("div", { cls: "r-fb-more", text: `${result.more} more results. Refine the search.` }));
      if (!kids.length) kids.push(P.emptyState({ icon: "folder", title: query ? "No matches" : "No files", body: query ? "Try another name or folder." : "Nothing in this folder." }));
      rows.replaceChildren(...kids);
    }

    async function load() {
      const my = ++seq;
      status = "loading"; render();
      try { view = await ctx.query("gitStatus"); if (my !== seq) return; status = "ready"; }
      catch (err) { if (my !== seq) return; error = err; status = "error"; }
      render();
    }

    return {
      el,
      show(params) {
        dir = ""; query = ""; search.input.value = "";
        view = params?.view ?? null;
        if (view) { status = "ready"; render(); } else load();
      },
    };
  }

  function preview(ctx) {
    const { M, P, ui } = ctx;
    const { h, icon } = P;
    let path = "", status = "idle", file = null, error = null, seq = 0, limit = FIRST_LINES, changed = null;
    const head = P.header({ title: "File preview", back: true, onBack: () => ui.back() });
    const body = h("div", { cls: "r-scroll r-fp-body" });
    const el = h("section", { cls: "r-screen", attrs: { "aria-label": "File preview" } }, head.el, body);

    function textRows(value) {
      const lines = value.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const visible = lines.slice(0, Math.min(limit, MAX_LINES));
      const rows = visible.map((line, i) => h("div", { cls: "r-fp-line" }, h("span", { text: String(i + 1), attrs: { "aria-hidden": "true" } }), h("span", { text: line || " " })));
      const rest = Math.min(lines.length, MAX_LINES) - visible.length;
      return h("div", { cls: "r-fp-code mono" },
        ...rows,
        rest > 0 && P.button({ label: `Show ${Math.min(200, rest)} more lines`, variant: "secondary", onClick: () => { limit += 200; render(); } }),
        lines.length > MAX_LINES && P.callout({ tone: "warn", icon: "warning", body: "File preview too large to show in full. Showing the first 2,000 lines." }));
    }

    function render() {
      head.title(R.splitPath(path).name);
      head.subtitle(R.splitPath(path).dir || "Project root");
      const nodes = [];
      if (changed) nodes.push(P.button({ label: "View changes", icon: "nav-review", variant: "secondary", onClick: () => ui.navigate("diff", { path }) }));
      if (status === "loading" || status === "idle") nodes.push(P.skeleton(4));
      else if (status === "error") nodes.push(P.callout({ tone: "error", icon: "st-error", title: "Couldn’t open this file", body: M.errorFeedback(error).text }), P.button({ label: "Retry", variant: "secondary", onClick: load }));
      else switch (file?.kind) {
        case "Text": nodes.push(textRows(file.text ?? "")); break;
        case "Image": nodes.push(P.emptyState({ icon: "image", title: "Image file", body: `${R.formatBytes(file.size)} · Preview on the desktop.` })); break;
        case "Binary": nodes.push(P.emptyState({ icon: "tool-file", title: "Binary file", body: "There is no text preview for this file." })); break;
        case "TooLarge": nodes.push(P.emptyState({ icon: "warning", title: "File too large", body: "Open it on the desktop." })); break;
        case "Outside": nodes.push(P.emptyState({ icon: "lock", title: "Outside the project", body: "This path can’t be read from the phone." })); break;
        default: nodes.push(P.emptyState({ icon: "tool-file", title: "File not found", body: "It may have been moved or deleted." }));
      }
      body.replaceChildren(...nodes);
    }

    async function load() {
      const my = ++seq;
      status = "loading"; render();
      try { file = await ctx.query("readFile", { args: { path } }); if (my !== seq) return; status = "ready"; }
      catch (err) { if (my !== seq) return; error = err; status = "error"; }
      render();
    }

    return {
      el,
      show(params) {
        path = String(params?.path ?? ""); changed = params?.status ?? null;
        limit = FIRST_LINES; load();
      },
    };
  }

  root.OMP_REMOTE_UI.registerScreen("review-files", browser);
  root.OMP_REMOTE_UI.registerScreen("review-file", preview);
})(typeof window !== "undefined" ? window : globalThis);
