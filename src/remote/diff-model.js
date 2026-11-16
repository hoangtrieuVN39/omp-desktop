// Diff screen view-model (Diff.dc.html): folds the desktop's inline file view
// into display rows with "⋯ N unchanged lines" separators and the list of
// changes to jump between. Pure; tests/test-remote-diff.mjs drives it.
//   gitFile -> FileView { path, kind: Text|Binary|Missing|TooLarge, status,
//                         adds, rems, lines: [{ kind: ctx|add|rem, old, new, text }],
//                         truncated }          (src-tauri git_browser/file.rs)
// Exposes window.OMP_REMOTE_DIFF (module.exports under Node).
(function (root) {
  const CONTEXT = 2;       // unchanged lines kept around a change
  const MIN_FOLD = 2;      // a separator hides at least this many lines
  const MAX_ROWS = 2000;   // CopyDeck diff.tooBig: "Showing the first 2,000 lines"

  // What the screen shows for a file view: diff | clean | binary | too-large | missing.
  function stateOf(view) {
    if (!view || typeof view !== "object") return "missing";
    switch (view.kind) {
      case "Binary": return "binary";
      case "TooLarge": return "too-large";
      case "Missing": return "missing";
      default: return (view.lines ?? []).some(line => line.kind !== "ctx") ? "diff" : "clean";
    }
  }

  // View -> { rows, changes, adds, rems, capped }.
  //   rows    [{ type: "line", kind, old, new, text } | { type: "fold", id, count }]
  //   changes [{ from, to, adds, rems }]  row indexes (inclusive) of each run of
  //           added/removed lines: a replaced block is one change.
  // `expanded` is a Set of fold ids (the index of a fold's first line in
  // view.lines) the person opened.
  function build(view, { context = CONTEXT, expanded = new Set(), maxRows = MAX_ROWS } = {}) {
    const lines = Array.isArray(view?.lines) ? view.lines : [];
    const near = new Uint8Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].kind === "ctx") continue;
      for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) near[j] = 1;
    }
    const rows = [], changes = [];
    let open = null, openUntil = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.kind !== "ctx") {
        if (!open) { open = { from: rows.length, to: rows.length, adds: 0, rems: 0 }; changes.push(open); }
        open.to = rows.length;
        if (line.kind === "add") open.adds++; else open.rems++;
      } else open = null;
      if (line.kind === "ctx" && !near[i] && i >= openUntil) {
        let end = i;
        while (end < lines.length && lines[end].kind === "ctx" && !near[end]) end++;
        if (expanded.has(i)) openUntil = end;
        else if (end - i >= MIN_FOLD) {
          rows.push({ type: "fold", id: i, count: end - i });
          i = end - 1;
          continue;
        }
      }
      rows.push({ type: "line", kind: line.kind, old: line.old ?? null, new: line.new ?? null, text: line.text ?? "" });
    }
    let capped = false;
    if (rows.length > maxRows) {
      capped = true;
      rows.length = maxRows;
      while (changes.length && changes.at(-1).from >= maxRows) changes.pop();
      if (changes.length && changes.at(-1).to >= maxRows) changes.at(-1).to = maxRows - 1;
    }
    const adds = Number.isInteger(view?.adds) ? view.adds : lines.filter(line => line.kind === "add").length;
    const rems = Number.isInteger(view?.rems) ? view.rems : lines.filter(line => line.kind === "rem").length;
    return { rows, changes, adds, rems, capped: capped || Boolean(view?.truncated) };
  }

  // Digits of the largest line number: the gutter width follows it.
  function gutterDigits(rows) {
    let max = 0;
    for (const row of rows) if (row.type === "line") max = Math.max(max, row.old ?? 0, row.new ?? 0);
    return Math.max(3, String(max).length);
  }

  // The change at or just above `top` row, for scroll-synced "Change N of M".
  function changeAt(changes, rowIndex) {
    let at = 0;
    for (let i = 0; i < changes.length; i++) if (changes[i].from <= rowIndex) at = i;
    return at;
  }

  const plural = (n, one, many) => (n === 1 ? one : many);

  // Reject confirm copy (CopyDeck): a tracked file goes back to HEAD; a file with
  // no committed version is deleted instead.
  function rejectCopy(name, status, adds, rems, discardDeletes) {
    if (discardDeletes) {
      return {
        title: `Delete ${name}?`, deletes: true,
        parts: [{ text: "It has no committed version, so rejecting " }, { bold: "deletes the file" }, { text: ". This can’t be undone." }],
        confirmLabel: "Delete file",
      };
    }
    const total = adds + rems;
    return {
      title: `Discard changes to ${name}?`, deletes: false,
      parts: [
        { text: "The file goes back to the last commit. " },
        { bold: `${adds} added and ${rems} removed ${plural(total, "line", "lines")}` },
        { text: ` ${plural(total, "is", "are")} lost. This can’t be undone.` },
      ],
      confirmLabel: "Discard changes",
    };
  }
  const doneText = (kind, name) => (kind === "accept" ? `Staged ${name}` : kind === "delete" ? `Deleted ${name}` : `Discarded ${name}`);

  root.OMP_REMOTE_DIFF = { CONTEXT, MAX_ROWS, stateOf, build, gutterDigits, changeAt, rejectCopy, doneText };
  if (typeof module !== "undefined" && module.exports) module.exports = root.OMP_REMOTE_DIFF;
})(typeof window !== "undefined" ? window : globalThis);
