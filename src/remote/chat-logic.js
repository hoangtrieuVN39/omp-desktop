// Pure logic behind the phone's Chat tab (ChatRunning / ChatApproval / ChatViewOnly /
// ChatSE / MessageMenu .dc.html): the composer state machine, slash and @ palettes,
// the phone-side queue strip, the run-state pill and the long-press menu's
// eligibility. No DOM, network or clock, so tests/test-remote-chat.mjs drives it directly.
// Exposes window.OMP_REMOTE_CHAT.
(function (root) {
  const COPY = {
    composerIdle: "Message…",
    composerBusy: "Message, steer or stop…",
    composerAsk: "Reply or add instructions…",
    composerStopped: "Send a new prompt…",
    viewOnlySend: "Sending is off on this phone (View scope)",
    following: "Following on desktop",
    stoppedNote: "Turn stopped from phone",
    steered: "Steered into this turn",
    queued: "Queued",
    tooLong: "Message is too long (max 32 KB).",
    branchBusy: "Available when the agent is idle. Stop it or wait for this turn to end.",
    branchNote: "New branch just before this message. Its text goes back into the composer to edit.",
    forkNote: "New branch that continues after this answer.",
    branchFooter: "The tab keeps its name. The old conversation stays in the tree.",
    switching: "Switching to the new branch…",
    modeSteerAria: "Steer — insert into the running turn",
    modeQueueAria: "Queue — send after this turn",
    noGrant: "Remembering a tool is only available on the desktop for now.",
    pushTitle: tab => `OMP · ${tab}`,
    pushQuestion: "Question waiting",
    pushFinished: "Finished",
  };

  const MAX_TEXT_BYTES = 32768;
  const MAX_QUEUE = 16;
  const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

  function byteLength(text) {
    return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(text).length : unescape(encodeURIComponent(text)).length;
  }
  const tooLong = text => byteLength(String(text ?? "")) > MAX_TEXT_BYTES;
  const hasText = text => String(text ?? "").trim() !== "";

  // ── composer ─────────────────────────────────────────────────────────────
  // What the one action cluster of the composer is. `can` = which action kinds
  // the scope allows ({ prompt, steer, followUp, abort } booleans), `mode` =
  // the Steer | Queue choice a running turn with a draft offers.
  //   locked  no prompt right (View scope): the dashed notice replaces the composer
  //   send    idle                     → prompt
  //   steer   running + text, Steer    → steer
  //   queue   running + text, Queue    → followUp (only when the desktop knows it)
  //   stop    running, no text         → abort
  function composerState({ busy, draft, mode = "steer", uploading = false, can }) {
    if (!can?.prompt) return { kind: "locked", disabled: true, action: null, modes: false, label: "", aria: "Send" };
    const text = hasText(draft);
    if (!busy) return { kind: "send", disabled: !text || uploading, action: "prompt", modes: false, label: "Send", aria: "Send" };
    if (!text) return { kind: "stop", disabled: !can.abort, action: "abort", modes: false, label: "Stop", aria: "Stop the running turn" };
    const queue = mode === "queue" && can.followUp;
    return {
      kind: queue ? "queue" : "steer", disabled: uploading || !(queue ? can.followUp : can.steer),
      action: queue ? "followUp" : "steer", modes: Boolean(can.followUp), label: queue ? "Queue" : "Steer",
      aria: queue ? COPY.modeQueueAria : COPY.modeSteerAria,
    };
  }

  // The request a composer press sends, or null when it must not go out.
  function submitPlan(state, draft, uploadIds = []) {
    if (!state.action || state.disabled) return null;
    if (state.action === "abort") return { kind: "abort", fields: {} };
    const text = String(draft ?? "");
    if (!hasText(text) || tooLong(text)) return null;
    return { kind: state.action, fields: { text, ...(uploadIds.length ? { args: { images: uploadIds.slice() } } : {}) } };
  }

  function composerPlaceholder({ busy, asking, stopped, locked }) {
    if (locked) return COPY.viewOnlySend;
    if (asking) return COPY.composerAsk;
    if (busy) return COPY.composerBusy;
    return stopped ? COPY.composerStopped : COPY.composerIdle;
  }

  // ── slash and @ palettes ─────────────────────────────────────────────────
  // `/co` at the start of the draft, no space typed yet → "co"; else null.
  function slashQuery(draft) {
    const match = /^\/([^\s/]*)$/.exec(String(draft ?? ""));
    return match ? match[1] : null;
  }

  // omp's ranked subsequence score (app/slash-commands.js): 0 = no match.
  function score(query, target) {
    if (!query) return 1;
    if (target === query) return 1000;
    if (target.startsWith(query)) return 900;
    if (target.includes(query)) return 600;
    let qi = 0, gaps = 0, last = -1;
    for (let ti = 0; ti < target.length && qi < query.length; ti++) {
      if (query[qi] === target[ti]) {
        if (last >= 0 && ti - last > 1) gaps++;
        last = ti; qi++;
      }
    }
    return qi === query.length ? Math.max(1, 40 - gaps * 5) : 0;
  }
  // commands: [{ name, description, hint }] from the `commands` query.
  function filterCommands(commands, query, limit = 30) {
    const q = String(query ?? "").toLowerCase();
    return (Array.isArray(commands) ? commands : [])
      .map((cmd, index) => {
        const name = String(cmd?.name ?? "").toLowerCase();
        const byName = score(q, name);
        const byText = q && byName === 0 && String(cmd?.description ?? "").toLowerCase().includes(q) ? 20 : 0;
        return { cmd, index, rank: byName || byText };
      })
      .filter(item => item.cmd?.name && item.rank > 0)
      .sort((a, b) => b.rank - a.rank || a.index - b.index)
      .slice(0, limit)
      .map(item => item.cmd);
  }
  const commandText = cmd => `/${cmd.name} `;

  // The `@` token the caret sits in (a `@` at the start or after whitespace or "(").
  function mentionToken(text, caret) {
    if (typeof text !== "string" || typeof caret !== "number" || caret < 0 || caret > text.length) return null;
    let i = caret - 1;
    while (i >= 0 && text[i] !== "@") { if (/\s/.test(text[i])) return null; i--; }
    if (i < 0) return null;
    const before = i > 0 ? text[i - 1] : null;
    if (before !== null && !/\s/.test(before) && before !== "(") return null;
    const query = text.slice(i + 1, caret);
    return query.includes("@") ? null : { start: i, end: caret, query };
  }
  function applyToken(text, range, insert) {
    return { text: text.slice(0, range.start) + insert + text.slice(range.end), caret: range.start + insert.length };
  }
  // `files` query items are { path, isDir } (or plain strings).
  function fileItem(raw) {
    const path = typeof raw === "string" ? raw : raw?.path;
    return typeof path === "string" && path ? { path, isDir: typeof raw === "object" && Boolean(raw.isDir) } : null;
  }
  function mentionInsert(item) {
    const stayOpen = item.isDir && !/[\s@]/.test(item.path);
    return stayOpen ? `@${item.path}/` : `@${item.path} `;
  }

  // ── queue strip ──────────────────────────────────────────────────────────
  // The view carries no queue, so the phone keeps what it queued itself
  // (`followUp`). An item goes once a user message with its text shows up
  // beyond those that were there when it was queued. A desktop that later
  // adds `view.queue` ([{ text, queue }]) wins.
  const userCount = (messages, text) => (messages ?? []).filter(m => m.role === "user" && m.text === text).length;
  function queueAdd(items, entry, messages) {
    if (items.length >= MAX_QUEUE) return items;
    const same = items.filter(item => item.text === entry.text).length;
    return [...items, { text: entry.text, queue: entry.queue ?? "followUp", seen: userCount(messages, entry.text) + same }];
  }
  function queuePrune(items, messages) {
    return items.filter(item => userCount(messages, item.text) <= item.seen);
  }
  function queueRemoveItem(items, item) {
    const at = items.indexOf(item);
    return at < 0 ? items : [...items.slice(0, at), ...items.slice(at + 1)];
  }
  function queuePromoteItem(items, item) {
    const at = items.indexOf(item);
    return at <= 0 ? items : [item, ...items.slice(0, at), ...items.slice(at + 1)];
  }
  function queueOf(view, local) {
    return Array.isArray(view?.queue) ? view.queue.filter(item => hasText(item?.text)).map(item => ({ text: item.text, queue: item.queue === "steering" ? "steering" : "followUp" })) : local;
  }

  // The composer's model chip: "opus · high", or the sheet's name before the desktop says.
  function modelChip(view) {
    const name = view?.model?.name ?? view?.model?.id;
    if (!name) return "Model & modes";
    const short = String(name).replace(/^(claude|gpt)[-\s]*/i, "").trim() || String(name);
    return view?.thinkingLevel && view.thinkingLevel !== "off" ? `${short} · ${view.thinkingLevel}` : short;
  }
  // The strip under the header: "Plan 3/7 · <current task>" from view.todos, or null.
  function planStrip(view) {
    const tasks = (Array.isArray(view?.todos) ? view.todos : []).flatMap(phase => Array.isArray(phase?.tasks) ? phase.tasks : []);
    const live = tasks.filter(t => t.status !== "abandoned");
    if (!live.length) return null;
    const done = live.filter(t => t.status === "completed").length;
    const current = live.find(t => t.status === "in_progress") ?? live.find(t => t.status === "pending");
    return { done, total: live.length, current: current?.content ?? "", pct: Math.round((done / live.length) * 100) };
  }
  // The line under the composer: "62% context · $1.84 this session", or null.
  function contextLine(view) {
    const c = view?.context;
    if (!c) return null;
    const pct = typeof c.pct === "number" ? Math.max(0, Math.min(100, Math.round(c.pct))) : null;
    const cost = typeof c.cost === "string" && c.cost ? c.cost : null;
    return pct === null && !cost ? null : { pct, cost };
  }

  // An edit card's inline preview: counts and the first changed lines of a unified
  // diff, or null when the output is not one (headers and context lines are skipped).
  function diffPreview(output, max = 4) {
    if (typeof output !== "string" || !output) return null;
    const lines = output.split(/\r?\n/);
    let add = 0, rm = 0;
    const shown = [];
    for (const raw of lines) {
      if (/^(\+\+\+|---) /.test(raw) || /^@@/.test(raw)) continue;
      const k = raw.startsWith("+") ? "add" : raw.startsWith("-") ? "rm" : null;
      if (!k) continue;
      if (k === "add") add++; else rm++;
      if (shown.length < max) shown.push({ kind: k, text: raw.slice(1).replace(/^\s?/, "") });
    }
    return add + rm === 0 ? null : { add, rm, lines: shown };
  }

  // ── run state ────────────────────────────────────────────────────────────
  // The status pill of the header: { id, text, icon, dot }.
  function runState({ tab, view, stopped }) {
    const messages = view?.messages ?? [];
    const asking = Boolean(tab?.hasAsk || view?.asks?.length);
    if (asking) return { id: "waiting", text: "Waiting", icon: "st-waiting", dot: false };
    if (view?.busy || tab?.busy) {
      const last = messages.at(-1);
      const tool = last?.role === "tool" ? last.tool?.name : "";
      return { id: "running", text: tool ? `Running ${tool}` : "Thinking…", icon: "st-running", dot: true };
    }
    if (stopped) return { id: "idle", text: "Stopped", icon: "stop", dot: true };
    if (tab?.status === "error") return { id: "error", text: "Error", icon: "st-error", dot: false };
    if (tab?.status === "finished") return { id: "finished", text: "Finished", icon: "check", dot: false };
    return { id: "idle", text: "Idle", icon: "st-idle", dot: true };
  }

  // ── transcript helpers ───────────────────────────────────────────────────
  const BASH_TOOLS = /^(bash|shell|sh|exec|python|run|terminal|powershell|cmd)$/i;
  const EDIT_TOOLS = /^(edit|write|patch|multiedit|replace|apply_patch|notebook_edit)$/i;
  const isEditTool = name => EDIT_TOOLS.test(name ?? "");
  function toolIcon(name) {
    if (BASH_TOOLS.test(name ?? "")) return "tool-bash";
    return EDIT_TOOLS.test(name ?? "") ? "slash" : "tool-file";
  }
  const isCommandTool = name => BASH_TOOLS.test(name ?? "");
  // The last `rows` non-empty lines of a running tool's output.
  function outputTail(text, rows = 3) {
    return String(text ?? "").split("\n").map(line => line.trimEnd()).filter(Boolean).slice(-rows);
  }
  // Whether the tool card at `index` is the live one: the tail of a running turn.
  const isLiveTool = (messages, index, busy) => Boolean(busy) && index === messages.length - 1 && messages[index]?.role === "tool";

  // ── long-press menu ──────────────────────────────────────────────────────
  // The session entry omp knows a message by (branchAt / forkAt `entryId`).
  function entryIdOf(message) {
    const raw = message?.entryId ?? (message?.idSynthetic ? null : message?.id);
    return typeof raw === "string" && ID_PATTERN.test(raw) ? raw : null;
  }
  // An assistant reply no later assistant or tool row follows before the next
  // user message; the tail of a turn that is still running is not final.
  function isFinalAnswer(messages, index, busy) {
    if (messages[index]?.role !== "assistant" || !hasText(messages[index].text)) return false;
    for (let i = index + 1; i < messages.length; i++) {
      const role = messages[i].role;
      if (role === "user") return true;
      if (role === "assistant" || role === "tool") return false;
    }
    return !busy;
  }
  const turnNumber = (messages, index) => messages.slice(0, index + 1).filter(m => m.role === "user").length;

  // Entries of the long-press menu for messages[index]. `gate(kind)` is
  // ctx.gate: { ok, label }. A locked entry keeps its place and says why.
  function messageMenu({ messages, index, busy, gate }) {
    const message = messages[index];
    if (!message || (message.role !== "user" && message.role !== "assistant")) return null;
    const entryId = entryIdOf(message);
    const entries = [];
    const user = message.role === "user";
    const final = !user && isFinalAnswer(messages, index, busy);
    if ((user || final) && entryId) {
      const kind = user ? "branchAt" : "forkAt";
      const gated = gate(kind);
      entries.push({
        id: user ? "branch" : "fork", icon: user ? "branch" : "fork", label: user ? "Branch from here" : "Fork from here",
        note: busy ? COPY.branchBusy : user ? COPY.branchNote : COPY.forkNote,
        locked: Boolean(busy) || !gated.ok, lockLabel: busy ? "" : gated.label, scopeLocked: !gated.ok, entryId, kind,
      });
    }
    entries.push({ id: "copy", icon: "copy", label: "Copy text", locked: !hasText(message.text), lockLabel: "" });
    return {
      user, final, entryId, entries, text: message.text ?? "",
      heading: user ? null : final ? `Final answer · turn ${turnNumber(messages, index)}` : "Assistant reply",
      footer: entries.some(e => e.id === "branch" || e.id === "fork") ? COPY.branchFooter : null,
    };
  }

  const chat = {
    COPY, MAX_TEXT_BYTES, MAX_QUEUE, byteLength, tooLong, hasText,
    composerState, submitPlan, composerPlaceholder,
    slashQuery, filterCommands, commandText, mentionToken, applyToken, fileItem, mentionInsert,
    queueAdd, queuePrune, queueRemoveItem, queuePromoteItem, queueOf,
    isEditTool, diffPreview, modelChip, planStrip, contextLine, runState, toolIcon, isCommandTool, outputTail, isLiveTool,
    entryIdOf, isFinalAnswer, turnNumber, messageMenu,
  };
  if (typeof window !== "undefined") window.OMP_REMOTE_CHAT = chat;
  if (typeof module !== "undefined" && module.exports) module.exports = chat;
})(typeof window !== "undefined" ? window : globalThis);
