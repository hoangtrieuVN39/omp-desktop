// ToolOutput.dc.html: full output/diff for a tool card, with search, line
// numbers, copy and jump controls. `toolOutput` is a read-only query; no
// project paths are sent to the desktop. Chunks render as the reader scrolls
// so a 400 KB response does not create thousands of DOM nodes at once.
(function (root) {
  const UI = root.OMP_REMOTE_UI;
  const T = root.OMP_REMOTE_TOOLOUT;
  const CHUNK = T.CHUNK;

  function factory(ctx) {
    const { h, icon, iconButton, button } = ctx.P;
    const close = iconButton({ icon: "back", label: "Close output", onClick: () => UI.back() });
    const title = h("div", { cls: "r-output-title" });
    const facts = h("div", { cls: "r-output-facts" });
    const copy = iconButton({ icon: "copy", label: "Copy all output", onClick: () => {
      if (detail) root.OMP_REMOTE_CHAT_TRANSCRIPT.copyText(ctx, detail.diff ?? detail.output ?? "");
    } });
    const search = h("input", { cls: "r-output-search", attrs: { type: "search", "aria-label": "Find in output", placeholder: "Find in output", autocomplete: "off" } });
    const matchCount = h("span", { cls: "r-output-count" });
    const prev = iconButton({ icon: "chevron-up", label: "Previous match", onClick: () => step(-1) });
    const next = iconButton({ icon: "chevron-down", label: "Next match", onClick: () => step(1) });
    const note = h("div", { cls: "r-output-note" });
    const linesHost = h("div", { cls: "r-output-lines" });
    const scroll = h("div", { cls: "r-output-scroll", attrs: { role: "region", "aria-label": "Tool output", tabindex: "0" } }, linesHost);
    const foot = h("div", { cls: "r-output-foot" },
      button({ label: "Jump to top", variant: "secondary", onClick: () => { scroll.scrollTop = 0; } }),
      button({ label: "Jump to end", variant: "secondary", onClick: () => { showAll(); scroll.scrollTop = scroll.scrollHeight; } }));
    const header = h("header", { cls: "r-output-header" }, h("div", { cls: "r-output-main" }, close, h("div", { cls: "r-output-heading" }, title, facts), copy),
      h("div", { cls: "r-output-search-row" }, h("label", { cls: "r-output-field" }, icon("search", { size: 16 }), search, matchCount), prev, next));
    const el = h("section", { cls: "r-screen r-output-screen", attrs: { "aria-label": "Tool output" } }, header, note, scroll, foot);
    let detail = null, lines = [], matches = [], current = -1, shown = 0, isDiff = false, request = 0;
    let params = null;

    function updateHeader() {
      const head = T.headTitle(detail);
      title.replaceChildren(...[h("span", { text: head.tool }), head.title && h("span", { cls: "mono", text: ` · ${head.title}` })].filter(Boolean));
      facts.replaceChildren(...T.headerFacts(detail, lines.length).map(part => h("span", { cls: part.tone ? `r-output-fact-${part.tone}` : "", text: part.text })));
      note.textContent = detail?.truncated ? "Output cut at 400 KB on the desktop. The rest isn’t available on this phone." : T.loadedNote(shown, lines.length);
      copy.disabled = !detail || (!detail.output && !detail.diff);
    }
    function drawLine(index) {
      const value = lines[index];
      const cls = isDiff ? `r-output-${T.diffClass(value)}` : T.lineTone(value) ? `r-output-${T.lineTone(value)}` : "";
      const fragments = T.linePieces(index, value, matches).map(piece =>
        piece.match === undefined ? root.document.createTextNode(piece.text) : h("mark", { cls: piece.match === current ? "is-current" : "", text: piece.text }));
      return h("div", { cls: `r-output-line ${cls}` }, h("span", { cls: "r-output-num", text: String(index + 1) }), h("span", { cls: "r-output-text" }, ...fragments));
    }
    function appendLines(to) {
      const limit = Math.min(lines.length, to);
      if (limit <= shown) return;
      const fragment = root.document.createDocumentFragment();
      for (let i = shown; i < limit; i++) fragment.append(drawLine(i));
      linesHost.append(fragment);
      shown = limit; updateHeader();
    }
    function showAll() { appendLines(lines.length); }
    function renderMatches() {
      // Search highlights only loaded lines; more lines are rendered lazily.
      linesHost.replaceChildren(); const n = shown; shown = 0; appendLines(n);
      matchCount.textContent = T.matchLabel(current, matches.length, search.value);
      prev.disabled = next.disabled = !matches.length;
    }
    function step(dir) {
      current = T.stepMatch(current, matches.length, dir);
      if (current < 0) return;
      appendLines(Math.max(shown, Math.ceil((matches[current].line + 1) / CHUNK) * CHUNK));
      renderMatches();
      linesHost.querySelectorAll("mark.is-current")[0]?.scrollIntoView({ block: "center" });
    }
    search.addEventListener("input", () => {
      matches = T.findMatches(lines, search.value);
      current = matches.length ? 0 : -1;
      renderMatches();
    });
    scroll.addEventListener("scroll", () => {
      if (shown < lines.length && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 300) appendLines(shown + CHUNK);
    });
    async function show(nextParams) {
      params = nextParams ?? {};
      const seq = ++request;
      const messageId = params.messageId;
      detail = null; lines = []; matches = []; current = -1; shown = 0; isDiff = false; search.value = "";
      linesHost.replaceChildren(); note.textContent = "Loading output…"; updateHeader();
      if (!messageId) { note.textContent = "No output selected."; return; }
      try {
        const data = await ctx.query("toolOutput", { tabId: params.tabId, args: { messageId } });
        if (seq !== request) return;
        detail = data;
        isDiff = typeof data?.diff === "string" && Boolean(data.diff);
        lines = T.splitLines(isDiff ? data.diff : data?.output);
        appendLines(CHUNK);
        renderMatches();
        if (isDiff) {
          const counts = T.diffStat(lines);
          facts.append(h("span", { cls: "r-output-add", text: `+${counts.add}` }), h("span", { cls: "r-output-rm", text: `−${counts.rm}` }));
        }
      } catch (error) {
        if (seq !== request) return;
        note.textContent = error.message || "Couldn’t load output.";
      }
    }
    function hide() { request++; }
    return { el, show, hide };
  }

  UI.registerScreen("tool-output", factory);
})(typeof window !== "undefined" ? window : globalThis);
