// Review tab view-model (Review.dc.html): pure mapping from the desktop's
// git answers to what the phone draws. No DOM, network or clock, so
// tests/test-remote-review.mjs drives it directly.
//   gitStatus -> StatusView { repo: { name, branch, head, ahead, behind }, tree, changed, truncated, folder }
//   prStatus  -> PrAutomationSnapshot | null | { stale: true }
//   gitBranches -> [{ name, remote, at }]          (src-tauri git_browser/*.rs, pr_automation/mod.rs)
// Exposes window.OMP_REMOTE_REVIEW (module.exports under Node).
(function (root) {
  const COPY = {
    notGit: "This project isn’t a git repository.",
    branchLocked: "Available when the agent is idle. Stop it or wait for this turn to end.",
    tooBig: "Diff too large to show in full. Showing the first 2,000 lines.",
    noTab: "Open a session on the desktop first — the phone acts through an open tab.",
  };
  const clean = branch => `No changes. Working tree is clean${branch ? ` on ${branch}` : ""}.`;

  // StatusKind as the desktop serialises it. `tone` picks the badge colours.
  const KINDS = {
    Modified: { code: "M", word: "modified", tone: "amber", rank: 0 },
    Added: { code: "A", word: "added", tone: "lime", rank: 1 },
    Renamed: { code: "R", word: "renamed", tone: "accent", rank: 2 },
    Deleted: { code: "D", word: "deleted", tone: "rose", rank: 3 },
    Untracked: { code: "U", word: "untracked", tone: "dashed", rank: 4 },
  };
  const kindOf = status => (Object.hasOwn(KINDS, status) ? KINDS[status] : null);

  // Whether rejecting deletes the file outright: no HEAD blob to restore
  // (same rule as the desktop's OMP_GIT_BROWSER.discardDeletes).
  const discardDeletes = status => status === "Untracked" || status === "Added" || status === "Renamed";

  // "src/remote/ws.ts" -> { dir: "src/remote/", name: "ws.ts" }.
  function splitPath(path) {
    const text = String(path ?? "");
    const cut = text.lastIndexOf("/");
    return { dir: cut < 0 ? "" : text.slice(0, cut + 1), name: cut < 0 ? text : text.slice(cut + 1) };
  }

  function walk(node, out) {
    if (!node) return out;
    if (!node.dir) { if (node.status) out.push(node); return out; }
    for (const child of node.children ?? []) walk(child, out);
    return out;
  }

  function fileRow(node) {
    const kind = kindOf(node.status);
    const { dir, name } = splitPath(node.path);
    return { path: node.path, name, dir, status: node.status, kind, sub: `${dir}${dir ? " · " : ""}${kind.word}` };
  }

  // Sessions remember which files this phone staged (gitStatus folds staged
  // and unstaged changes together and does not say which is which). An entry
  // lasts while the file keeps the same status; anything else forgets it.
  function createAccepted() {
    const map = new Map();
    return {
      mark(path, status) { map.set(path, status); },
      has(path, status) { return map.get(path) === status; },
      forget(path) { map.delete(path); },
      size: () => map.size,
      prune(rows) {
        const live = new Map(rows.map(row => [row.path, row.status]));
        for (const [path, status] of [...map]) if (live.get(path) !== status) map.delete(path);
      },
    };
  }

  // Changed files of a StatusView split into those still to review and those
  // this phone already accepted; ordered by kind (M, A, R, D, U) then path.
  function changeList(view, accepted) {
    const rows = walk(view?.tree, []).filter(node => kindOf(node.status)).map(fileRow)
      .sort((a, b) => a.kind.rank - b.kind.rank || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    accepted?.prune(rows);
    const done = rows.filter(row => accepted?.has(row.path, row.status));
    return { files: rows.filter(row => !done.includes(row)), accepted: done, total: rows.length };
  }

  // Branch label: name, or the short HEAD id while detached.
  function branchLabel(repo) {
    if (repo?.branch) return { text: repo.branch, detached: false };
    if (repo?.head) return { text: `detached ${String(repo.head).slice(0, 7)}`, detached: true };
    return { text: "no commits yet", detached: true };
  }

  // The tab-less phone errors the Review screen tells apart.
  function classifyError(error) {
    const code = error?.code, message = String(error?.message ?? error ?? "");
    if (code === "no-tab") return "no-tab";
    if (code === "disconnected") return "offline";
    if (code === "unsupported" || code === "unknown") return "unsupported";
    if (/not a git repository|no working tree|has no working tree/i.test(message)) return "not-repo";
    if (/no project folder/i.test(message)) return "no-folder";
    return "error";
  }

  // The tab's busy flag; the Review screen locks branch switching while true.
  function isBusy(state, tabId) {
    const tab = (state?.tabs ?? []).find(item => item.id === tabId);
    if (tab?.busy) return true;
    return Boolean(state?.view && state.view.tabId === tabId && state.view.busy);
  }

  // ── pull request card ─────────────────────────────────────────────────────
  const CHECK_ORDER = { failure: 0, running: 1, queued: 2, success: 3, neutral: 4 };
  const CHECK_WORD = { failure: "failed", running: "running", queued: "queued", neutral: "skipped" };
  const CHECK_ICON = { success: "check", failure: "close", running: "st-running", queued: "st-idle", neutral: "st-idle" };
  const MAX_PILLS = 6;

  // A stale answer (tab mid-switch) is "ask again", never "no PR".
  const prIsStale = value => Boolean(value && typeof value === "object" && value.stale === true);

  function prCard(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !Number.isFinite(snapshot.number) || prIsStale(snapshot)) return null;
    const checks = Array.isArray(snapshot.checks) ? snapshot.checks : [];
    const sorted = checks.map((check, index) => ({ check, index }))
      .sort((a, b) => (CHECK_ORDER[a.check.state] ?? 9) - (CHECK_ORDER[b.check.state] ?? 9) || a.index - b.index)
      .map(entry => entry.check);
    const pills = sorted.slice(0, MAX_PILLS).map(check => ({
      name: check.name, state: check.state, icon: CHECK_ICON[check.state] ?? "st-idle",
      label: CHECK_WORD[check.state] ? `${check.name} · ${CHECK_WORD[check.state]}` : check.name,
    }));
    return {
      number: snapshot.number, title: snapshot.title ?? "", url: snapshot.url ?? "", draft: Boolean(snapshot.isDraft),
      additions: Number(snapshot.additions) || 0, deletions: Number(snapshot.deletions) || 0,
      pills, more: Math.max(0, sorted.length - MAX_PILLS), total: checks.length,
    };
  }
  function prErrorCopy(error) {
    const message = String(error?.message ?? error ?? "");
    if (/\bgh\b|github cli/i.test(message)) return "GitHub CLI isn’t available on the desktop, so pull request status can’t be shown.";
    return message || "Couldn’t load the pull request.";
  }

  // ── branches ──────────────────────────────────────────────────────────────
  // Locals first, then remote-tracking ones; each group keeps the desktop's
  // newest-first order. Every word of `query` must occur in the name.
  function branchGroups(list, query) {
    const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const rows = (Array.isArray(list) ? list : []).filter(item => item && typeof item.name === "string"
      && words.every(word => item.name.toLowerCase().includes(word)));
    return { local: rows.filter(item => !item.remote), remote: rows.filter(item => item.remote) };
  }

  // ── project file browser (tree from gitStatus) ───────────────────────────
  function findNode(tree, path) {
    if (!path) return tree ?? null;
    let node = tree;
    for (const part of path.split("/")) {
      node = (node?.children ?? []).find(child => child.name === part);
      if (!node) return null;
    }
    return node;
  }
  function allFiles(node, out = []) {
    if (!node) return out;
    if (!node.dir) out.push(node); else for (const child of node.children ?? []) allFiles(child, out);
    return out;
  }
  // Entries of one folder (dirs first, as the desktop sorts them), or, with a
  // query, every file whose path contains each word (first `limit`).
  function browseRows(tree, path, query, limit = 100) {
    const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      const hits = allFiles(tree).filter(node => words.every(word => node.path.toLowerCase().includes(word)));
      return { rows: hits.slice(0, limit), more: Math.max(0, hits.length - limit), searching: true };
    }
    const node = findNode(tree, path);
    return { rows: node?.children ?? [], more: 0, searching: false, missing: !node };
  }

  const formatBytes = size => {
    const n = Number(size) || 0;
    if (n < 1024) return `${n} B`;
    return n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  };

  root.OMP_REMOTE_REVIEW = {
    COPY, clean, KINDS, kindOf, discardDeletes, splitPath, changeList, createAccepted, branchLabel, classifyError,
    isBusy, prCard, prErrorCopy, prIsStale, branchGroups, findNode, browseRows, formatBytes,
  };
  // One instance per page, shared by the Review list and the Diff screen.
  root.OMP_REMOTE_REVIEW.accepted = createAccepted();
  if (typeof module !== "undefined" && module.exports) module.exports = root.OMP_REMOTE_REVIEW;
})(typeof window !== "undefined" ? window : globalThis);
