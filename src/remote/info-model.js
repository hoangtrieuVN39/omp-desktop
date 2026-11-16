// Pure logic behind the Usage, Approvals and Export HTML screens (Usage /
// ApprovalRules / ExportHtml .dc.html): the `usage` query's dashboard stats as
// KPIs and bars, the approval mode and always-allow rules of a project, the
// export result and download error copy. No DOM, network or clock of its own.
// Exposes window.OMP_REMOTE_INFO.
(function (root) {
  const finite = v => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const baseName = path => String(path ?? "").split(/[\\/]+/).filter(Boolean).pop() || String(path ?? "");

  // ── usage ───────────────────────────────────────────────────────────────
  function money(v) { return `$${finite(v).toFixed(2)}`; }
  function count(v) {
    const n = finite(v);
    if (n < 1e4) return String(Math.round(n));
    if (n < 1e6) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
    if (n < 1e9) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
    return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  }
  // Bars as a share of `total`, at least 2% wide when there is any cost, 100% at most.
  const share = (v, total) => (total > 0 && v > 0 ? Math.min(100, Math.max(2, Math.round((v / total) * 100))) : 0);
  const AGENT_LABEL = { main: "Main agents", subagent: "Subagents", advisor: "Advisors" };

  // DashboardStats (src-tauri/src/stats.rs) → { empty, kpis, models, folders, agents, unpriced }.
  function usage(data) {
    const o = data?.overall;
    if (!o || finite(o.totalRequests) <= 0) return { empty: true };
    const total = finite(o.totalCost);
    const bars = (list, name) => [...(Array.isArray(list) ? list : [])]
      .sort((a, b) => finite(b.totalCost) - finite(a.totalCost))
      .map(item => ({ label: name(item), cost: money(item.totalCost), pct: share(finite(item.totalCost), total), requests: finite(item.totalRequests) }));
    const speed = o.avgTokensPerSecond;
    return {
      empty: false,
      kpis: [
        { label: "Cost", value: money(total) },
        { label: "Requests", value: finite(o.totalRequests).toLocaleString("en-US") },
        { label: "Tokens", value: count(finite(o.totalInputTokens) + finite(o.totalOutputTokens)) },
        { label: "Speed", value: typeof speed === "number" && Number.isFinite(speed) ? String(Math.round(speed)) : "—", unit: typeof speed === "number" ? "tok/s" : "" },
      ],
      models: bars(data.byModel, m => m.model || m.provider || "unknown"),
      folders: bars(data.byFolder, f => baseName(f.folder)),
      agents: (Array.isArray(data.byAgentType) ? data.byAgentType : []).map(a => ({
        label: AGENT_LABEL[a.agentType] ?? a.agentType, detail: `${finite(a.totalRequests).toLocaleString("en-US")} req · ${money(a.totalCost)}`,
      })),
      unpriced: finite(o.unpricedRequests),
    };
  }

  // ── approvals ───────────────────────────────────────────────────────────
  const MODES = [
    { value: "always-ask", label: "Always ask", blurb: "Every tool call needs approval" },
    { value: "write", label: "Write", blurb: "Edits run freely; commands ask" },
    { value: "yolo", label: "Yolo", blurb: "Nothing asks. Use with care." },
  ];
  const modeLabel = value => MODES.find(m => m.value === value)?.label ?? String(value ?? "");

  // The mode a tab's project runs: its override, else the default. The phone only
  // knows the project's folder NAME, the desktop keys overrides by full path, so
  // the override is matched by its last path segment; two folders that share a
  // name make the match `ambiguous` (the default is then shown).
  function projectMode(view, projectName) {
    const fallback = MODES.some(m => m.value === view?.default) ? view.default : "write";
    const hits = Object.entries(view?.projects ?? {}).filter(([path, mode]) => baseName(path) === projectName && MODES.some(m => m.value === mode));
    if (hits.length === 1) return { mode: hits[0][1], source: "project", ambiguous: false };
    return { mode: fallback, source: "default", ambiguous: hits.length > 1 };
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hhmm = d => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  // "today 14:20", "yesterday 09:05", "12 Nov", "12 Nov 2024"; "" when unknown.
  function whenLabel(iso, now = Date.now()) {
    const ms = typeof iso === "number" ? iso : Date.parse(iso);
    if (!Number.isFinite(ms)) return "";
    const then = new Date(ms), today = new Date(now);
    const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((day(today) - day(then)) / 86400000);
    if (diff === 0) return `today ${hhmm(then)}`;
    if (diff === 1) return `yesterday ${hhmm(then)}`;
    const label = `${then.getDate()} ${MONTHS[then.getMonth()]}`;
    return then.getFullYear() === today.getFullYear() ? label : `${label} ${then.getFullYear()}`;
  }

  // approval_rules_list → rows: { key, tool, scope, detail }. Newest grant first.
  function rules(list, now) {
    return (Array.isArray(list) ? list : []).filter(r => r && typeof r.tool === "string" && typeof r.scope === "string")
      .map(r => ({
        key: `${r.scope}\0${r.tool}`, tool: r.tool, scope: r.scope, at: Date.parse(r.grantedAt),
        detail: [r.scope === "project" ? "Always, this project" : "This session", whenLabel(r.grantedAt, now)].filter(Boolean).join(" · "),
      }))
      .sort((a, b) => (Number.isFinite(b.at) ? b.at : 0) - (Number.isFinite(a.at) ? a.at : 0));
  }

  // Copy of the "switch mode" confirmation (CopyDeck confirm.mode).
  function modeConfirm(project, mode, tabTitle) {
    const label = modeLabel(mode);
    const tab = tabTitle || "this session";
    return {
      title: `Switch ${project || "this project"} to ${label}?`,
      body: `The agent in ${tab} restarts with the new mode as soon as it’s idle.${mode === "yolo" ? ` Nothing will ask for approval in ${project ? "this project" : "this session"}.` : ""}`,
      confirmLabel: "Switch and restart when idle",
    };
  }

  // ── export ──────────────────────────────────────────────────────────────
  const ID = /^[A-Za-z0-9_-]{1,64}$/;
  // The `exportHtml` ack → { downloadId, name } or null.
  function exportResult(value) {
    if (!value || typeof value.downloadId !== "string" || !ID.test(value.downloadId)) return null;
    return { downloadId: value.downloadId, name: typeof value.name === "string" && value.name ? value.name : "export.html" };
  }
  // Failure of OMP_REMOTE_PROTO.download → what the phone says.
  function downloadError(error) {
    switch (error?.code) {
      case "not-found": return { text: "The file was already taken or expired.", again: true };
      case "forbidden": return { text: "This phone isn’t allowed to download it.", again: false };
      case "not-allowed": return { text: "This phone has no download access. Pair again.", again: false };
      case "network": return { text: "Couldn’t reach the desktop to download the file.", again: true };
      case "cancelled": return { text: "Download cancelled. Export again to get another copy.", again: true };
      default: return { text: error?.message || "Download failed.", again: true };
    }
  }

  root.OMP_REMOTE_INFO = { MODES, modeLabel, usage, projectMode, whenLabel, rules, modeConfirm, exportResult, downloadError, baseName, money, count };
  if (typeof module !== "undefined" && module.exports) module.exports = root.OMP_REMOTE_INFO;
})(typeof window !== "undefined" ? window : globalThis);
