// Pure logic behind the Agents tab and the subagent detail screen (Agents.dc.html):
// status mapping, grouping by the task call that spawned each agent, totals,
// number formatting, the plan (todo) summary and the subagent transcript
// mapper. No DOM, network or clock of its own (`now` is a parameter).
//
// Data contract. The phone's view frame (app/remote-view.js buildView) does not
// carry subagent or plan data yet. This module reads two OPTIONAL fields of it
// and falls back to what exists (the `task` tool cards of view.messages):
//   view.subagents  [{ id, index?, agent, description?, status, assignment?, task?,
//                      parentToolCallId?, startedAt?, endedAt?, tokens?, cost?, durationMs?,
//                      toolCount?, requests?, currentTool?, currentToolArgs?, lastIntent?,
//                      contextTokens?, contextWindow?, error? }]
//        status: pending | running | completed | failed | aborted. A record may also nest
//        the metrics under `progress` (the desktop's OMP_SUBAGENTS record); both are read.
//   view.todos      [{ name, tasks: [{ content, status }] }]   status: pending | in_progress |
//                   completed | abandoned (omp's todoPhases)
// Exposes window.OMP_REMOTE_AGENTS.
(function (root) {
  const STATUS = {
    running: { id: "running", label: "Running", icon: "st-running", tone: "running" },
    pending: { id: "running", label: "Starting", icon: "st-running", tone: "running" },
    completed: { id: "done", label: "Done", icon: "st-done", tone: "done" },
    failed: { id: "failed", label: "Failed", icon: "st-error", tone: "failed" },
    aborted: { id: "stopped", label: "Stopped", icon: "stop", tone: "stopped" },
    idle: { id: "idle", label: "Idle", icon: "st-idle", tone: "stopped" },
  };
  const statusOf = key => STATUS[key] ?? STATUS.idle;
  const isLive = agent => agent?.status.id === "running";

  const num = value => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const str = value => (typeof value === "string" ? value : "");

  // 18200 → "18.2k", 3.1e6 → "3.1M"; null stays null.
  function fmtTokens(value) {
    const n = num(value);
    if (n === null) return null;
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 2 : 1).replace(/\.?0+$/, "")}k`;
    return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  }
  // Under 10 cents three decimals (the desktop's own rule), else two.
  function fmtCost(value) {
    const n = num(value);
    if (n === null) return null;
    if (n === 0) return "$0.00";
    return n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
  }
  // 58000 → "58s", 102000 → "1m 42s", 3_900_000 → "1h 05m".
  function fmtDuration(ms) {
    const n = num(ms);
    if (n === null) return null;
    const secs = Math.max(0, Math.round(n / 1000));
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, "0")}s`;
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
  }

  const TASK_TOOLS = new Set(["task", "quick_task"]);

  // One subagent record → what the screens draw. `now` only matters for running agents.
  function mapAgent(raw, now) {
    const p = raw.progress ?? {};
    const pick = key => (num(p[key]) ?? num(raw[key]));
    const status = statusOf(str(raw.status) || "running");
    const startedAt = num(raw.startedAt);
    const reported = pick("durationMs");
    const elapsed = status.id === "running" && startedAt !== null && now != null
      ? Math.max(reported ?? 0, now - startedAt) : reported ?? (startedAt !== null && num(raw.endedAt) !== null ? raw.endedAt - startedAt : null);
    const contextTokens = pick("contextTokens"), contextWindow = pick("contextWindow");
    const kind = str(raw.agent), description = str(raw.description ?? p.description);
    return {
      id: str(raw.id), index: num(raw.index) ?? 0, status,
      title: [kind, description].filter(Boolean).join(" · ") || str(raw.id),
      kind, description,
      task: str(raw.assignment ?? raw.task),
      callId: str(raw.parentToolCallId) || null,
      tokens: pick("tokens"), cost: pick("cost"), elapsed, startedAt,
      tools: pick("toolCount"), requests: pick("requests"),
      currentTool: str(p.currentTool ?? raw.currentTool),
      currentArgs: str(p.currentToolArgs ?? raw.currentToolArgs),
      intent: str(p.lastIntent ?? raw.lastIntent),
      context: contextTokens !== null && contextWindow ? Math.min(1, contextTokens / contextWindow) : null,
      error: str(raw.error),
      actionable: true,
    };
  }

  // A running count for a task call that has no live data: from the `task` tool
  // cards of the view. They carry no agent id, so they can't be opened or steered.
  function cardAgents(view) {
    const busy = Boolean(view?.busy);
    const cards = (view?.messages ?? []).filter(m => m.role === "tool" && TASK_TOOLS.has(m.tool?.name));
    return cards.map((m, index) => {
      const open = busy && !str(m.tool?.output).trim() && index === cards.length - 1;
      return {
        id: str(m.id), index, status: statusOf(open ? "running" : "completed"),
        title: str(m.tool?.summary) || str(m.text) || "task", kind: "task", description: str(m.tool?.summary), task: "",
        callId: str(m.id), tokens: null, cost: null, elapsed: null, startedAt: null, tools: null, requests: null,
        currentTool: "", currentArgs: "", intent: "", context: null, error: "", actionable: false,
      };
    });
  }

  const parentOf = id => { const i = id.lastIndexOf("."); return i < 0 ? null : id.slice(0, i); };

  // Agents grouped by the main-session task call that spawned the root of their
  // nesting chain; nested agents (`Parent.Child`) follow their parent, indented.
  function group(agents, view) {
    const byId = new Map(agents.map(a => [a.id, a]));
    const rootCall = agent => {
      let cur = agent;
      for (let pid = parentOf(cur.id); pid && byId.has(pid); pid = parentOf(cur.id)) cur = byId.get(pid);
      return cur.callId ?? "";
    };
    const groups = new Map();
    for (const agent of agents) {
      const key = rootCall(agent);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(agent);
    }
    const bySpawn = (a, b) => a.index - b.index || a.id.localeCompare(b.id);
    const cards = new Map((view?.messages ?? []).filter(m => m.role === "tool").map(m => [m.id, m]));
    return [...groups].map(([callId, list]) => {
      const ids = new Set(list.map(a => a.id));
      const kids = new Map(), roots = [];
      for (const agent of list) {
        const pid = parentOf(agent.id);
        if (pid && ids.has(pid)) { if (!kids.has(pid)) kids.set(pid, []); kids.get(pid).push(agent); } else roots.push(agent);
      }
      const rows = [];
      const visit = (agent, depth) => { rows.push({ agent, depth }); for (const kid of (kids.get(agent.id) ?? []).sort(bySpawn)) visit(kid, depth + 1); };
      roots.sort(bySpawn).forEach(agent => visit(agent, 0));
      const card = cards.get(callId);
      const label = str(card?.tool?.summary) || str(card?.text);
      return { callId: callId || null, title: label ? `task · ${label}` : "task", rows };
    });
  }

  function totals(agents) {
    const t = { total: agents.length, running: 0, done: 0, failed: 0, stopped: 0, cost: 0, hasCost: false };
    for (const a of agents) {
      if (a.status.id === "running") t.running++;
      else if (a.status.id === "done") t.done++;
      else if (a.status.id === "failed") t.failed++;
      else t.stopped++;
      if (a.cost !== null) { t.cost += a.cost; t.hasCost = true; }
    }
    return t;
  }

  // "2 running · 1 done · 1 failed · $0.74" (zero parts left out).
  function summaryParts(t) {
    const parts = [];
    if (t.running) parts.push({ text: `${t.running} running`, accent: true });
    if (t.done) parts.push({ text: `${t.done} done` });
    if (t.failed) parts.push({ text: `${t.failed} failed` });
    if (t.stopped) parts.push({ text: `${t.stopped} stopped` });
    if (t.hasCost) parts.push({ text: fmtCost(t.cost) });
    return parts;
  }

  // The data of the Agents tab for a view frame. `source` says where it came from:
  // "subagents" (view.subagents), "cards" (task tool cards only) or "none".
  function build(view, now) {
    const raw = Array.isArray(view?.subagents) ? view.subagents.filter(a => a && typeof a.id === "string") : null;
    const agents = raw ? raw.map(a => mapAgent(a, now)) : cardAgents(view);
    return {
      source: raw ? "subagents" : agents.length ? "cards" : "none",
      agents, groups: group(agents, view), totals: totals(agents), plan: plan(view?.todos),
    };
  }

  // ── plan ────────────────────────────────────────────────────────────────
  const TODO = {
    in_progress: { id: "active", icon: "st-running" },
    completed: { id: "done", icon: "check" },
    abandoned: { id: "done", icon: "check" },
    pending: { id: "todo", icon: null },
  };
  function plan(todos) {
    if (!Array.isArray(todos)) return null;
    const phases = todos.map(phase => ({
      name: str(phase?.name),
      tasks: (Array.isArray(phase?.tasks) ? phase.tasks : []).map(task => ({
        text: str(task?.content), state: (TODO[task?.status] ?? TODO.pending),
        abandoned: task?.status === "abandoned",
      })).filter(task => task.text),
    })).filter(phase => phase.tasks.length);
    if (!phases.length) return null;
    const all = phases.flatMap(phase => phase.tasks);
    const done = all.filter(task => task.state.id === "done").length;
    return { phases, total: all.length, done, title: `Plan · ${done} of ${all.length} done` };
  }

  // ── transcript ──────────────────────────────────────────────────────────
  const blockText = content => (typeof content === "string" ? content
    : (Array.isArray(content) ? content : []).filter(b => b?.type === "text").map(b => str(b.text)).join("\n"));
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

  // Tool call arguments → one line: a lone value bare, several as `key value · key value`.
  function formatArgs(args) {
    if (args == null) return "";
    let text;
    if (typeof args === "string") text = args;
    else {
      const entries = Object.entries(args).filter(([, v]) => v != null && typeof v !== "object");
      text = entries.length === 1 ? String(entries[0][1])
        : entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(" · ") : JSON.stringify(args);
    }
    return clip(text, 140);
  }

  // omp session messages → display entries: { kind: user | assistant | call | result, ... }.
  // `limit` keeps the newest entries; `hidden` counts the older ones left out.
  function transcript(messages, limit = 80) {
    const out = [];
    for (const m of Array.isArray(messages) ? messages : []) {
      if (m?.role === "toolResult") {
        const lines = blockText(m.content).split("\n").filter(Boolean);
        out.push({ kind: "result", tool: str(m.toolName), error: Boolean(m.isError), text: clip(lines.slice(0, 4).join("\n"), 600), more: lines.length > 4 });
      } else if (m?.role === "user" || m?.role === "assistant") {
        const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
        for (const b of blocks) {
          if (b?.type === "text" && str(b.text).trim()) out.push({ kind: m.role, text: clip(b.text.trim(), 4000) });
          else if (b?.type === "toolCall") out.push({ kind: "call", tool: str(b.name), text: formatArgs(b.arguments) });
        }
      }
    }
    const hidden = Math.max(0, out.length - limit);
    return { entries: hidden ? out.slice(hidden) : out, hidden };
  }

  root.OMP_REMOTE_AGENTS = {
    STATUS, statusOf, isLive, fmtTokens, fmtCost, fmtDuration, mapAgent, build, group, totals, summaryParts, plan, transcript, formatArgs,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.OMP_REMOTE_AGENTS;
})(typeof window !== "undefined" ? window : globalThis);
