// Phone view-model: pure functions behind the Sessions, session-menu, connection
// and pairing screens (tab grouping, status mapping, scope gating, relative
// times, error copy). No DOM, network or clock of its own (`now` is a
// parameter), so tests/test-remote-model.mjs drives it directly. All user
// facing English copy that screens share lives in COPY (copy deck:
// docs/phone-remote design CopyDeck).
// Exposes window.OMP_REMOTE_MODEL.
(function (root) {
  const COPY = {
    tabSwitchHint: "Opening this tab also switches the desktop to it.",
    emptyTabs: "No open tabs. Start a session or resume one below.",
    scopeView: "View only. Change this phone’s scope on the desktop.",
    scopeSetOnDesktop: "Scope is set on the desktop in Settings › Paired phones.",
    opPending: "Waiting for desktop…",
    opNoAnswer: "Desktop didn’t answer",
    opExpired: "Expired before it was sent",
    opBusy: "Busy — 16 actions queued. Try in a moment.",
    opNotAllowed: "Not allowed for this phone’s scope.",
    opTooOld: "This desktop is too old for that. Update OMP Desktop.",
    opOffline: "Not connected to the desktop.",
    pairSafari: "Add to Home Screen and open OMP from there to get notifications.",
    pairWrong: "That QR isn’t from this desktop.",
  };

  const STATUS = {
    waiting: { id: "waiting", label: "Waiting", icon: "st-waiting" },
    running: { id: "running", label: "Running", icon: "st-running" },
    error: { id: "error", label: "Request failed", icon: "st-error" },
    finished: { id: "finished", label: "Finished", icon: "st-done" },
    idle: { id: "idle", label: "Idle", icon: "st-idle" },
  };
  // The desktop publishes busy / hasAsk for every tab. `status` ("error",
  // "finished") and `unread` are optional extras a later desktop may add.
  function statusOf(tab) {
    if (tab?.hasAsk) return STATUS.waiting;
    if (tab?.busy) return STATUS.running;
    if (tab?.status === "error") return STATUS.error;
    if (tab?.status === "finished") return STATUS.finished;
    return STATUS.idle;
  }
  const ORDER = { running: 0, finished: 1, error: 2, idle: 3 };

  // Waiting tabs get their own block; the rest keep the desktop's order but
  // running tabs come first, then failed, finished, idle (stable).
  function groupTabs(tabs) {
    const list = Array.isArray(tabs) ? tabs : [];
    const waiting = list.filter(tab => tab.hasAsk);
    const open = list.filter(tab => !tab.hasAsk)
      .map((tab, index) => ({ tab, index, rank: ORDER[statusOf(tab).id] }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(entry => entry.tab);
    return { waiting, open, total: list.length };
  }

  // Epoch ms from an ISO string, ms or seconds; null when unknown.
  function toMs(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
    if (typeof value === "string" && value) {
      const ms = Date.parse(value);
      return Number.isNaN(ms) ? null : ms;
    }
    return null;
  }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // "now", "2m", "5h", "Yesterday", "3d", "12 Nov", "12 Nov 2024".
  function relativeTime(value, now = Date.now()) {
    const ms = toMs(value);
    if (ms === null) return "";
    const diff = Math.max(0, now - ms);
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const day = date => Math.floor((date.getTime() - date.getTimezoneOffset() * 60000) / 86400000);
    const then = new Date(ms), today = new Date(now);
    const days = day(today) - day(then);
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days}d`;
    const label = `${then.getDate()} ${MONTHS[then.getMonth()]}`;
    return then.getFullYear() === today.getFullYear() ? label : `${label} ${then.getFullYear()}`;
  }

  // Search of the saved list: every word must occur in title, project or preview.
  function filterSaved(list, query) {
    const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return list.slice();
    return list.filter(item => {
      const hay = `${item.title ?? ""} ${item.project ?? ""} ${item.preview ?? ""}`.toLowerCase();
      return words.every(word => hay.includes(word));
    });
  }
  function filterProjects(list, query) {
    const q = String(query ?? "").trim().toLowerCase();
    return q ? list.filter(p => String(p.name ?? "").toLowerCase().includes(q)) : list.slice();
  }
  // "Recent · 4 open tabs" under a project in the new-session sheet.
  function projectDetail(project, tabs) {
    const open = (tabs ?? []).filter(tab => tab.project === project.name).length;
    if (open > 0) return `Recent · ${open} open ${open === 1 ? "tab" : "tabs"}`;
    return project.open ? "Open on the desktop" : "Recent project";
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function projectLine(tab, now) {
    const parts = [tab.project, statusOf(tab).label];
    const when = relativeTime(tab.updatedAt, now);
    if (when && !tab.busy && !tab.hasAsk) parts.push(when);
    return parts.filter(Boolean).join(" · ");
  }

  // ── scopes ───────────────────────────────────────────────────────────────
  const LEVEL = { view: 0, control: 1, manage: 2 };
  const SCOPES = {
    view: { id: "view", label: "View only", short: "View", blurb: "Read, get pushes", summary: "You can read every tab and get notifications." },
    control: { id: "control", label: "Control", short: "Control", blurb: "+ prompt, steer, stop, answer", summary: "You can also send prompts, steer, stop and answer questions." },
    manage: { id: "manage", label: "Manage", short: "Manage", blurb: "+ sessions, git, model", summary: "You can also manage sessions, git and models." },
  };
  const scopeSummary = scope => (SCOPES[scope] ?? SCOPES.view).summary;
  const cap = word => word.charAt(0).toUpperCase() + word.slice(1);
  const protoTables = () => root.OMP_REMOTE_PROTO
    ?? (typeof require === "function" ? require("./protocol.js") : { ACTIONS: {}, LEGACY_ACTIONS: [] });

  // Whether `kind` may be sent now. `conn` is { connected, legacy, scope }.
  // A legacy desktop (protocol 1) acts as `control` with its five old actions.
  function gate(conn, kind) {
    const { ACTIONS, LEGACY_ACTIONS } = protoTables();
    if (!conn?.connected) return { ok: false, reason: "offline", needs: null, label: "" };
    if (conn.legacy) {
      return LEGACY_ACTIONS.includes(kind)
        ? { ok: true, reason: null, needs: null, label: "" }
        : { ok: false, reason: "legacy", needs: null, label: "Update desktop" };
    }
    const needs = Object.hasOwn(ACTIONS, kind) ? ACTIONS[kind] : null;
    if (needs === null) return { ok: false, reason: "unknown", needs: null, label: "" };
    if ((LEVEL[conn.scope] ?? 0) >= LEVEL[needs]) return { ok: true, reason: null, needs, label: "" };
    return { ok: false, reason: "scope", needs, label: `Needs ${cap(needs)}` };
  }
  // The toast a tap on a locked control shows.
  function lockMessage(conn, gated, actionLabel) {
    if (gated.reason === "legacy") return COPY.opTooOld;
    if (gated.reason === "offline") return COPY.opOffline;
    if (conn?.scope === "view") return COPY.scopeView;
    const have = SCOPES[conn?.scope]?.short ?? "View";
    return `This phone has ${have}. ${actionLabel} needs ${cap(gated.needs ?? "manage")} — change it on the desktop.`;
  }

  // ── connection ───────────────────────────────────────────────────────────
  // phase: unpaired | connecting | connected | reconnecting | offline | revoked.
  // After a connection existed, the first quick retries read as
  // "reconnecting"; a not-ready desktop (4503) or several failures read as
  // "offline" (desktop off, asleep or not on Tailscale).
  function phaseAfterClose({ code, attempt, hadConnection }) {
    if (code === 4401) return "revoked";
    if (code === 4503 || attempt >= 3 || !hadConnection && attempt >= 1) return "offline";
    return "reconnecting";
  }
  // ── theme ────────────────────────────────────────────────────────────────
  const THEME_COLORS = { aurora: "#0B0D12", daylight: "#F3F4F7", phosphor: "#040804" };
  // Text colour for a button filled with the desktop's accent: whichever of
  // near-black and white contrasts more. null when `hex` is not a colour.
  function onAccent(hex) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
    if (!m) return null;
    const full = m[1].length === 3 ? [...m[1]].map(c => c + c).join("") : m[1];
    const lin = i => { const v = parseInt(full.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const lum = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
    return 1.05 / (lum + 0.05) > (lum + 0.05) / 0.054 ? "#FFFFFF" : "#0B0D12";
  }
  const hhmm = ms => {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  };
  // The banner under the header for a connection phase, or null.
  function bannerFor(conn) {
    switch (conn?.phase) {
      case "connecting":
      case "reconnecting":
        return { id: "reconnecting", tone: "warn", icon: "st-running", spin: true, text: conn.phase === "connecting" ? "Connecting…" : "Reconnecting · catching up" };
      case "offline":
        return { id: "offline", tone: "error", icon: "offline", text: conn.lastSeenAt ? `Desktop offline · showing ${hhmm(conn.lastSeenAt)}` : "Desktop offline", action: "Retry" };
      case "revoked":
        return { id: "revoked", tone: "error", icon: "lock", text: "Access revoked → back to pairing" };
      default:
        return null;
    }
  }
  const CONNECTION_VIEW = {
    connected: { label: "Connected", tone: "ok", body: tabs => `Live. ${plural(tabs, "open tab", "open tabs")}.` },
    connecting: { label: "Connecting…", tone: "warn", body: () => "Reaching your desktop." },
    reconnecting: { label: "Reconnecting…", tone: "warn", body: () => "iOS closed the connection while the app was in the background. Catching up on missed events." },
    offline: { label: "Offline", tone: "error", body: (_n, at) => `The desktop is off, asleep, or not on Tailscale.${at ? ` What you see is from ${hhmm(at)}.` : ""}` },
    revoked: { label: "Removed", tone: "error", body: () => "The desktop revoked access. Pair again to reconnect." },
    unpaired: { label: "Not paired", tone: "error", body: () => "Pair this phone with your desktop to continue." },
  };
  function connectionView(conn) {
    const entry = CONNECTION_VIEW[conn?.phase] ?? CONNECTION_VIEW.unpaired;
    return { label: entry.label, tone: entry.tone, body: entry.body(conn?.tabCount ?? 0, conn?.lastSeenAt) };
  }

  // First DNS label of the page host ("dmm" for dmm.tail3c2935.ts.net).
  function hostName(hostname) {
    const host = String(hostname ?? "").split(":")[0];
    if (!host || /^\d+(\.\d+){3}$/.test(host) || host.includes("[")) return host || "Desktop";
    return host.split(".")[0] || "Desktop";
  }
  // The device name is the user agent the page paired with; show a short label.
  function deviceLabel(name) {
    const text = String(name ?? "").trim();
    if (/iPhone/.test(text)) return "iPhone";
    if (/iPad/.test(text)) return "iPad";
    if (/Android/.test(text)) return "Android phone";
    if (/Macintosh|Windows|Linux|X11/.test(text)) return "Browser";
    return text.slice(0, 40) || "This phone";
  }

  // ── operation feedback ───────────────────────────────────────────────────
  // Maps a failed request (protocol.js error: { code, message }) to the toast.
  function errorFeedback(error) {
    const code = error?.code, message = String(error?.message ?? "");
    if (code === "timeout" || /did not answer/i.test(message)) return { text: COPY.opNoAnswer, tone: "error", retry: "Retry" };
    if (/expired/i.test(message)) return { text: COPY.opExpired, tone: "error", retry: "Send again" };
    if (code === "busy" || /^busy$/i.test(message)) return { text: COPY.opBusy, tone: "warn", retry: null };
    if (code === "not-allowed" || /not allowed/i.test(message)) return { text: COPY.opNotAllowed, tone: "lock", retry: null };
    if (code === "disconnected" || /not connected|connection lost/i.test(message)) return { text: COPY.opOffline, tone: "error", retry: "Retry" };
    if (code === "unsupported") return { text: COPY.opTooOld, tone: "error", retry: null };
    return { text: message || "Something went wrong", tone: "error", retry: "Retry", mono: true };
  }

  // ── notifications ────────────────────────────────────────────────────────
  // off | on | pending | unavailable | needs-install | no-key
  function pushState({ installed, supported, key, enabled, pending }) {
    if (!supported || !installed) return installed ? "unavailable" : "needs-install";
    if (enabled) return "on";
    if (pending) return "pending";
    return key ? "off" : "no-key";
  }

  // ── pairing ──────────────────────────────────────────────────────────────
  const PAIR_ERRORS = {
    camera: { title: "Camera access is off", body: installed => `Allow camera for this ${installed ? "app in iOS Settings" : "site in your browser settings"}, then try again.` },
    unavailable: { title: "Camera not available", body: () => "This device or browser cannot open the camera. Open the pairing link from the desktop instead." },
    wrong: { title: "That QR isn’t from this desktop", body: () => "Scan the code shown in OMP Desktop › Pair phone." },
    expired: { title: "This code expired or was already used", body: () => "Make a new code on the desktop. Each one works once, for 5 minutes." },
    limited: { title: "Too many attempts", body: () => "Wait a minute, then scan a fresh code." },
    network: { title: "Couldn’t reach the desktop", body: () => "Check that the desktop is on and this phone is on Tailscale, then try again." },
    revoked: { title: "This phone was removed", body: () => "The desktop revoked access. Pair again to reconnect." },
  };
  function pairError(kind, installed) {
    const entry = PAIR_ERRORS[kind];
    return entry ? { kind, title: entry.title, body: entry.body(installed) } : null;
  }
  // Failed POST /pair → error kind.
  function pairFailureKind(status) {
    if (status === 429) return "limited";
    if (status === 0 || status === undefined) return "network";
    return "expired";
  }

  const model = {
    COPY, STATUS, SCOPES, LEVEL, statusOf, groupTabs, relativeTime, filterSaved, filterProjects, projectDetail,
    projectLine, plural, gate, lockMessage, phaseAfterClose, bannerFor, connectionView, hostName, deviceLabel,
    errorFeedback, pushState, pairError, pairFailureKind, hhmm, scopeSummary, onAccent, THEME_COLORS,
  };
  if (typeof window !== "undefined") window.OMP_REMOTE_MODEL = model;
  if (typeof module !== "undefined" && module.exports) module.exports = model;
})(typeof window !== "undefined" ? window : globalThis);
