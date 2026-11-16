// Export HTML (ExportHtml.dc.html), pushed from the session menu with
// navigate('export', { tabId }). Opens a bottom sheet over a dimmed Chat-like
// backdrop; states: exporting, exported, downloading, ready, failed and
// cancelled. `exportHtml` writes the file on the desktop and returns only
// { downloadId, name }, NOT a path. Download uses the bearer token from the
// phone's pairing store, then navigator.share({ files }) or an object-URL link.
// The download is one-use, so a cancelled / expired transfer needs a new export.
(function (root) {
  const TOKEN_KEY = "omp-remote-token"; // connection.js, same-origin localStorage
  const HTML = "text/html";

  function factory(ctx) {
    const { M, P, ui } = ctx;
    const { h, icon, button } = P, I = root.OMP_REMOTE_INFO;
    let tabId = null, status = "idle", name = "", downloadId = "", file = null, error = "", sheet = null;
    let seq = 0, abort = null, url = null, hiding = false;

    // The sheet overlays a ghost of the Chat screen, as in ExportHtml.dc.html.
    const ghost = h("div", { cls: "r-ex-ghost", attrs: { "aria-hidden": "true" } },
      h("div", { cls: "r-ex-ghost-title" }), h("div", { cls: "r-ex-ghost-user" }), h("div", { cls: "r-ex-ghost-answer" }));
    const el = h("section", { cls: "r-screen r-ex-screen", attrs: { "aria-label": "Export HTML" } }, ghost);

    function dispose() {
      if (url) { root.URL.revokeObjectURL(url); url = null; }
      file = null;
      abort?.abort(); abort = null;
    }
    function close() { sheet?.close("done"); }
    function render() {
      if (!sheet) return;
      const host = ctx.state().host || "your desktop";
      const body = sheet.body, foot = sheet.footer;
      const makeIcon = (iconName, tone) => h("span", { cls: `r-ex-mark is-${tone}` }, icon(iconName, { size: 22, className: tone === "progress" ? "spin" : "" }));
      const title = (iconName, tone, text, note) => h("div", { cls: "r-ex-head" }, makeIcon(iconName, tone), h("div", h("h2", { text }), h("span", { text: note })));
      const actions = [];
      let content;
      switch (status) {
        case "exporting": {
          const count = ctx.state().view?.tabId === tabId && ctx.state().view?.messages?.length < 100
            ? ctx.state().view.messages.filter(m => m.role === "user" && !m.echo).length : null;
          content = h("div", { cls: "r-ex-wait", attrs: { role: "status" } }, icon("st-running", { size: 36, className: "spin" }),
            h("h2", { text: `Exporting${count ? ` ${count} ${count === 1 ? "prompt" : "prompts"}` : " this session"}…` }),
            h("p", { text: "The desktop is writing the file. You can leave this screen." }));
          actions.push(button({ label: "Close", variant: "secondary", size: "lg", cls: "r-btn-block", onClick: close }));
          break;
        }
        case "downloading":
          content = h("div", { cls: "r-ex-wait", attrs: { role: "status" } }, icon("st-running", { size: 36, className: "spin" }),
            h("h2", { text: "Downloading to this phone…" }), h("p", { text: "This copy is private to your paired phone." }));
          actions.push(button({ label: "Cancel download", variant: "secondary", size: "lg", cls: "r-btn-block", onClick: () => {
            seq++; abort?.abort(); abort = null; status = "cancelled"; error = "Download cancelled. Export again to get another copy."; render();
          } }));
          break;
        case "exported":
        case "ready":
          content = h("div", { cls: "r-ex-done" },
            title("check", "success", "Exported", `Saved on ${host}, not on this phone`),
            h("div", { cls: "r-ex-name-group" }, h("span", { text: "File on your computer" }), h("div", { cls: "mono r-ex-name", text: name })),
            status === "ready"
              ? h("div", { cls: "r-ex-share" }, button({ label: canShare() ? "Share file" : "Save file", icon: "share", variant: "secondary", cls: "r-btn-block", onClick: share } ))
              : h("div", { cls: "r-ex-share" }, button({ label: "Get a copy on this phone", icon: "share", variant: "secondary", cls: "r-btn-block", onClick: download })),
            status === "ready" && !canShare() && h("p", { cls: "r-hint", text: "Sharing isn’t available in this browser. Save the file instead." }));
          actions.push(button({ label: "Copy name", icon: "copy", variant: "secondary", size: "lg", cls: "r-grow", onClick: copyName }),
            button({ label: "Done", variant: "primary", size: "lg", cls: "r-grow", onClick: close }));
          break;
        case "failed":
        case "cancelled":
          content = h("div", { cls: "r-ex-done" }, title("st-error", "error", status === "cancelled" ? "Download cancelled" : "Export failed", error));
          actions.push(button({ label: "Close", variant: "secondary", size: "lg", cls: "r-grow", onClick: close }),
            button({ label: "Try again", variant: "primary", size: "lg", cls: "r-grow", onClick: startExport }));
          break;
        default:
          content = h("div", { cls: "r-ex-done" }, title("lock", "error", "Export unavailable", error));
          actions.push(button({ label: "Close", variant: "secondary", size: "lg", cls: "r-btn-block", onClick: close }));
      }
      body.replaceChildren(content);
      foot.hidden = false;
      foot.replaceChildren(h("div", { cls: "r-ex-actions" }, ...actions));
    }

    async function startExport() {
      dispose();
      const gated = ctx.gate("exportHtml");
      if (!gated.ok) { status = "locked"; error = M.lockMessage(ctx.state(), gated, "Export HTML"); render(); return; }
      const mine = ++seq;
      status = "exporting"; error = ""; render();
      const result = await ctx.act("exportHtml", { tabId }, { label: "Export HTML", retry: false });
      if (mine !== seq) return;
      if (!result.ok) { status = "failed"; error = M.errorFeedback(result.error).text; render(); return; }
      const data = I.exportResult(result.value);
      if (!data) { status = "failed"; error = "The desktop did not provide a downloadable file."; render(); return; }
      ({ downloadId, name } = data);
      status = "exported"; render();
    }

    async function download() {
      const token = root.localStorage.getItem(TOKEN_KEY);
      if (!token) { status = "failed"; error = "This phone’s pairing expired. Pair again to get a copy."; render(); return; }
      if (!ctx.proto?.canDownload()) { status = "failed"; error = "This desktop does not support phone downloads."; render(); return; }
      const mine = ++seq;
      abort = new root.AbortController();
      status = "downloading"; render();
      try {
        const blob = await root.OMP_REMOTE_PROTO.download(downloadId, token, (path, options) => root.fetch(path, { ...options, signal: abort.signal }));
        if (mine !== seq) return;
        // File sharing must be a separate tap on iOS: the async download loses the gesture.
        file = new root.File([blob], name, { type: blob.type || HTML });
        status = "ready"; render();
      } catch (cause) {
        if (mine !== seq) return;
        const problem = I.downloadError(cause);
        status = "failed"; error = problem.text; render();
      } finally { if (mine === seq) abort = null; }
    }
    const canShare = () => file && typeof root.navigator.share === "function" && (typeof root.navigator.canShare !== "function" || root.navigator.canShare({ files: [file] }));
    async function share() {
      if (!file) return;
      if (canShare()) {
        try { await root.navigator.share({ files: [file], title: name }); }
        catch (err) { if (err.name !== "AbortError") ui.toast({ tone: "error", text: "Couldn’t share the file. Try Save file instead." }); }
      } else {
        if (!url) url = root.URL.createObjectURL(file);
        const link = h("a", { attrs: { href: url, download: name, "aria-label": `Save ${name}` } });
        el.append(link); link.click(); link.remove();
      }
    }
    async function copyName() {
      try { await root.navigator.clipboard.writeText(name); ui.toast({ tone: "ok", text: "File name copied" }); }
      catch { ui.toast({ tone: "error", text: "Couldn’t copy the file name." }); }
    }

    return {
      el,
      show(params) {
        hiding = false; tabId = params?.tabId ?? ctx.anchorTab(); seq++;
        name = ""; downloadId = ""; status = "idle"; error = ""; dispose();
        ghost.firstChild.textContent = ctx.state().tabs.find(t => t.id === tabId)?.title ?? "Chat";
        sheet = ui.openSheet({ label: "Export HTML", bare: true, full: false, showClose: false,
          body: () => h("div"), footer: () => h("div"),
          onClose: () => { sheet = null; if (!hiding) ui.back(); },
        });
        startExport();
      },
      hide() { hiding = true; seq++; dispose(); if (sheet) { sheet.close("hide"); sheet = null; } },
    };
  }
  root.OMP_REMOTE_UI.registerScreen("export", factory);
})(typeof window !== "undefined" ? window : globalThis);
