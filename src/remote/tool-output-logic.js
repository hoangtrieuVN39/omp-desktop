// Pure logic of the phone's Tool output screen (ToolOutput.dc.html): the header
// facts, line splitting, the in-output search and the diff line classes. The
// `toolOutput` query answers { id, tool, title, status, output, truncated, diff? }.
// No DOM, so tests/test-remote-tool-output.mjs drives it directly.
// Exposes window.OMP_REMOTE_TOOLOUT.
(function (root) {
  const CHUNK = 200; // lines rendered at first and per "load more"
  const MAX_MATCHES = 2000;

  function splitLines(text) {
    const value = String(text ?? "");
    if (value === "") return [];
    const lines = value.replace(/\r\n?/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  }

  // Every case-insensitive hit of `query`: [{ line, start, end }] in reading order.
  function findMatches(lines, query) {
    const needle = String(query ?? "").toLowerCase();
    if (!needle) return [];
    const out = [];
    for (let line = 0; line < lines.length && out.length < MAX_MATCHES; line++) {
      const hay = lines[line].toLowerCase();
      for (let from = hay.indexOf(needle); from !== -1 && out.length < MAX_MATCHES; from = hay.indexOf(needle, from + needle.length)) {
        out.push({ line, start: from, end: from + needle.length });
      }
    }
    return out;
  }
  // Next/previous match index, wrapping; -1 when there is none.
  function stepMatch(index, count, dir) {
    if (count <= 0) return -1;
    if (index < 0) return dir < 0 ? count - 1 : 0;
    return (index + dir + count) % count;
  }
  // "1 of 2", "No matches" or "" for an empty query.
  function matchLabel(index, count, query) {
    if (!query) return "";
    return count ? `${index + 1} of ${count}${count >= MAX_MATCHES ? "+" : ""}` : "No matches";
  }
  // Pieces of one line around its matches: [{ text, match?: matchIndex }].
  function linePieces(line, text, matches) {
    const hits = matches.map((m, index) => ({ m, index })).filter(item => item.m.line === line);
    if (!hits.length) return [{ text }];
    const out = [];
    let at = 0;
    for (const { m, index } of hits) {
      if (m.start > at) out.push({ text: text.slice(at, m.start) });
      out.push({ text: text.slice(m.start, m.end), match: index });
      at = m.end;
    }
    if (at < text.length) out.push({ text: text.slice(at) });
    return out;
  }

  // add | rm | hunk | file | ctx for one unified-diff line.
  function diffClass(line) {
    if (/^(\+\+\+|---) /.test(line)) return "file";
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "rm";
    return "ctx";
  }
  function diffStat(lines) {
    let add = 0, rm = 0;
    for (const line of lines) { const kind = diffClass(line); if (kind === "add") add++; else if (kind === "rm") rm++; }
    return { add, rm };
  }

  // Failure markers the output itself shows ("✗", "FAIL", "Error:") tint their line.
  const FAIL_LINE = /(^|\s)(✗|✖|FAIL(ED)?\b|Error:|error:|AssertionError)/;
  const OK_MARK = /^(\s*)(✓|✔)/;
  const lineTone = text => (FAIL_LINE.test(text) ? "fail" : OK_MARK.test(text) ? "ok" : "");

  function statusTone(status) {
    const text = String(status ?? "").toLowerCase();
    if (/err|fail|exit [1-9]|denied|cancel/.test(text)) return "error";
    if (/run|pending|progress/.test(text)) return "running";
    return text ? "ok" : "";
  }
  const plural = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  // The facts under the title: status · N lines · cut note.
  function headerFacts(detail, lineCount) {
    const parts = [];
    if (detail?.status) parts.push({ text: String(detail.status), tone: statusTone(detail.status) });
    parts.push({ text: plural(lineCount, "line", "lines") });
    if (detail?.truncated) parts.push({ text: "cut at 400 KB" });
    return parts;
  }
  // "bash" + the card title → the screen's heading pieces.
  const headTitle = detail => ({ tool: detail?.tool || "tool", title: detail?.title || "" });
  const loadedNote = (shown, total) => (shown >= total ? "" : `Lines 1–${shown.toLocaleString("en-US")} loaded · rest loads as you scroll`);

  const api = { CHUNK, MAX_MATCHES, splitLines, findMatches, stepMatch, matchLabel, linePieces, diffClass, diffStat, lineTone, statusTone, headerFacts, headTitle, loadedNote };
  if (typeof window !== "undefined") window.OMP_REMOTE_TOOLOUT = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
