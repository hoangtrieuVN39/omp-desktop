/* app/remote-ops.js — the phone's actions and queries beyond prompt / steer /
   abort / answer (protocol 2, docs/phone-remote/PLAN.md). Rust has already
   checked the device's scope and the request's size (remote/scope.rs); this
   module checks each request's arguments again — the phone is untrusted —
   and maps it onto existing OMP_BRIDGE methods. It never accepts a path from
   the phone: projects and saved sessions are named by opaque ids that only
   resolve against lists the desktop itself produced. */
(function () {
  "use strict";

  const MAX_TOOL_OUTPUT = 400 * 1024;
  const MAX_FILES = 50;
  const MAX_SAVED = 200;
  const APPROVAL_MODES = ["always-ask", "write", "yolo"];
  const QUEUES = ["steering", "followUp"];
  const GOAL_OPS = ["pause", "resume", "drop"];

  // Stable opaque id for a desktop-side path (FNV-1a, 64-bit as two halves).
  function opaqueId(path) {
    let h1 = 0x811c9dc5, h2 = 0x050c5d1f;
    for (let i = 0; i < path.length; i++) {
      const c = path.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x01000193 ^ 0x5bd1e995) >>> 0;
    }
    return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }

  function folderName(path) {
    const parts = String(path ?? "").split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }

  /** Projects the phone may name: recent folders plus open tabs' folders,
   *  newest first, without duplicates. `path` stays on the desktop. */
  function projectList(snapshot) {
    const seen = new Map();
    for (const s of snapshot?.sessions ?? []) {
      if (s.path && !seen.has(s.path)) seen.set(s.path, { path: s.path, open: true });
    }
    for (const r of snapshot?.recentProjects ?? []) {
      const path = typeof r === "string" ? r : r?.path;
      if (path && !seen.has(path)) seen.set(path, { path, open: false });
    }
    return [...seen.values()].map(p => ({ ...p, id: opaqueId(p.path), name: folderName(p.path) }));
  }

  // ── argument checks ──────────────────────────────────────────────────────
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const str = (v, max = 32 * 1024) => typeof v === "string" && v.length <= max;
  const nonBlank = (v, max) => str(v, max) && v.trim() !== "";
  const id = v => typeof v === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(v);
  /** A project-relative path: no absolute path, drive, `..` or NUL. */
  function relPath(v) {
    if (!str(v, 1024) || v === "" || v.includes("\0")) return false;
    if (/^([A-Za-z]:|[\\/])/.test(v)) return false;
    return !v.split(/[\\/]+/).includes("..");
  }
  const uploadIds = v => v === undefined || (Array.isArray(v) && v.length <= 8 && v.every(id));

  const bad = "invalid arguments";
  const need = ok => (ok ? null : bad);

  /** Error text for `args` of `kind`, or null when they are acceptable. */
  function invalidArgs(kind, args, text) {
    const a = isObj(args) ? args : {};
    switch (kind) {
      case "prompt": case "steer": case "followUp":
        return need(nonBlank(text) && uploadIds(a.images));
      case "queueRemove": case "queueSendNow":
        return need(nonBlank(a.text) && QUEUES.includes(a.queue));
      case "queuePromote": return need(nonBlank(a.text));
      case "subagentSteer": return need(id(a.agentId) && nonBlank(a.text));
      case "subagentCancel": case "subagentTranscript": return need(id(a.agentId));
      case "setModel": return need(nonBlank(a.provider, 200) && nonBlank(a.id, 200));
      case "setThinking": return need(nonBlank(a.level, 32));
      case "goalStart":
        return need(nonBlank(a.objective) && (a.tokenBudget === undefined
          || (Number.isInteger(a.tokenBudget) && a.tokenBudget > 0)));
      case "goalOp": return need(GOAL_OPS.includes(a.op));
      case "openProject": case "newTab": return need(id(a.projectId) && (a.profile === undefined || id(a.profile)));
      case "resumeSession": return need(id(a.sessionId));
      case "renameTab": return need(nonBlank(a.title, 200));
      case "switchProfile": return need(id(a.profileId));
      case "branchAt": case "forkAt": return need(id(a.entryId));
      case "gitAccept": case "gitReject": case "gitFile": case "readFile": return need(relPath(a.path));
      case "gitSwitchBranch": return need(nonBlank(a.name, 255) && typeof a.remote === "boolean");
      case "approvalRevoke": return need(nonBlank(a.tool, 200) && nonBlank(a.scope, 64));
      case "approvalModeProject": return need(a.mode === null || APPROVAL_MODES.includes(a.mode));
      case "files": return need(str(a.query ?? "", 200));
      case "savedSessions": return need(a.projectId === undefined || id(a.projectId));
      case "toolOutput": return need(id(a.messageId));
      default: return null;
    }
  }

  // ── result shaping ───────────────────────────────────────────────────────
  function clip(text, max) {
    if (typeof text !== "string" || text.length <= max) return text;
    const code = text.charCodeAt(max - 1);
    return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
  }

  /** The full output of one tool card, for a tap on the phone. */
  function toolDetail(snapshot, messageId) {
    const message = (snapshot?.messages ?? []).find(m => (m.id ?? m._toolCallId) === messageId);
    if (!message || (message.kind ?? message.role) !== "tool") return null;
    const output = window.OMP_REMOTE_VIEW?.toolOutput?.(message) ?? "";
    return {
      id: messageId,
      tool: typeof message.tool === "string" ? message.tool : message.tool?.name ?? "",
      title: message.title ?? "",
      status: message.status ?? "",
      output: clip(output, MAX_TOOL_OUTPUT),
      truncated: output.length > MAX_TOOL_OUTPUT,
      ...(typeof message.diffText === "string" ? { diff: clip(message.diffText, MAX_TOOL_OUTPUT) } : {}),
    };
  }

  /** Saved sessions without their file paths, keyed by opaque id. */
  function savedView(list) {
    return (list ?? []).slice(0, MAX_SAVED).map(s => ({
      id: opaqueId(s.path), title: s.title ?? "", project: s.projectName ?? folderName(s.cwd),
      updatedAt: s.updatedAt ?? s.timestamp ?? null, messageCount: s.messageCount ?? 0,
      preview: clip(s.preview ?? "", 300),
    }));
  }

  /** Unwrap a bridge `{ok, value | error}`; throw its error. */
  function unwrap(result) {
    if (result && typeof result === "object" && "ok" in result) {
      if (result.ok === false) throw new Error(result.error ?? "failed");
      return "value" in result ? result.value : result;
    }
    return result;
  }

  /** Operations that run without activating a tab. */
  const TABLESS = new Set(["projects", "profiles", "approvalModes"]);

  /**
   * Run one op. `ctx`: { bridge, snapshot(), deviceId, tabId, entry(),
   * check() }. Resolves to the data for the phone (or undefined); throws a
   * display error. The caller activated the tab; `check` throws unless the
   * request is still valid and that tab still active, and runs right before
   * every side effect that follows an await — a desktop tab switch during
   * the wait must not land the change on another tab's session or project.
   */
  async function run(kind, args, text, ctx) {
    const { bridge } = ctx;
    const check = ctx.check ?? (() => {});
    const a = isObj(args) ? args : {};
    const snap = ctx.snapshot();
    const project = () => {
      const p = projectList(snap).find(item => item.id === a.projectId);
      if (!p) throw new Error("unknown project");
      return p.path;
    };
    const takeImages = async () => {
      const out = [];
      for (const uploadId of a.images ?? []) {
        const image = await bridge.remoteTakeUpload(ctx.deviceId, uploadId);
        if (!image) throw new Error("image upload missing");
        out.push({ type: "image", data: image.data, mimeType: image.mimeType });
      }
      return out;
    };
    const truthy = async (call, error) => { if ((await call) === false) throw new Error(error); };
    switch (kind) {
      // actions
      case "followUp": {
        const images = await takeImages();
        check();
        await bridge.followUp(text, images);
        return undefined;
      }
      case "queueRemove": return truthy(bridge.removeQueuedMessage(a.text, a.queue), "no longer queued");
      case "queuePromote": return truthy(bridge.promoteQueuedMessage(a.text), "no longer queued");
      case "queueSendNow": return truthy(bridge.sendQueuedNow(a.text, a.queue), "no longer queued");
      case "stopRetry": unwrap(await bridge.stopRetry()); return undefined;
      case "subagentSteer": await bridge.steerSubagent(a.agentId, a.text); return undefined;
      case "subagentCancel": return truthy(bridge.cancelSubagent(a.agentId), "subagent is not running");
      case "exportHtml": {
        const path = await bridge.exportHtmlFile();
        if (typeof path !== "string" || !path) throw new Error("export failed");
        const downloadId = await bridge.remoteOfferDownload(ctx.deviceId, path);
        return { downloadId, name: folderName(path) };
      }
      case "setModel": {
        const model = (snap.models ?? []).find(m => m.provider === a.provider && m.id === a.id);
        if (!model) throw new Error("unknown model");
        bridge.setModel(model);
        return undefined;
      }
      case "setThinking": {
        const levels = await bridge.thinkingLevels();
        if (!levels.includes(a.level)) throw new Error("level not supported by this model");
        check();
        await bridge.setThinkingLevel(a.level);
        return undefined;
      }
      case "compact": bridge.compact(); return undefined;
      case "goalStart": unwrap(await bridge.goalStart(a.objective, a.tokenBudget ?? null, [], "")); return undefined;
      case "goalOp": unwrap(await bridge.goalOp(a.op)); return undefined;
      case "openProject": return { tabId: await bridge.openProject(project()) };
      case "newTab": {
        if (a.profile !== undefined && !(snap.profiles ?? []).some(p => p.id === a.profile)) throw new Error("unknown profile");
        return { tabId: await bridge.openSession(project(), a.profile) };
      }
      case "resumeSession": {
        const list = await bridge.listSavedSessions(null);
        const session = (list ?? []).find(s => opaqueId(s.path) === a.sessionId);
        if (!session) throw new Error("unknown session");
        check();
        const tabId = await bridge.resumeSession(session);
        if (!tabId) throw new Error("could not open the session");
        return { tabId };
      }
      case "closeTab": return truthy(bridge.closeSession(ctx.tabId), "tab could not be closed");
      case "renameTab": await bridge.renameSession(ctx.tabId, a.title); return undefined;
      case "switchProfile": unwrap(await bridge.switchSessionProfile(ctx.tabId, a.profileId)); return undefined;
      case "branchAt": return { text: unwrap(await bridge.branchAt(a.entryId))?.text ?? "" };
      case "forkAt": unwrap(await bridge.forkAt(a.entryId)); return undefined;
      case "gitAccept": await bridge.workspaceAccept(a.path); return undefined;
      case "gitReject": await bridge.workspaceReject(a.path); return undefined;
      case "gitSwitchBranch": {
        const branches = unwrap(await bridge.gitBranches()) ?? [];
        if (!branches.some(b => b.name === a.name && Boolean(b.remote) === a.remote)) throw new Error("unknown branch");
        check();
        unwrap(await bridge.gitSwitchBranch(a.name, a.remote));
        return undefined;
      }
      case "approvalRevoke": await bridge.revokeApprovalRule(a.tool, a.scope); return undefined;
      case "approvalModeProject": {
        const path = ctx.entry()?.path;
        if (!path) throw new Error("tab has no project folder");
        unwrap(await bridge.setApprovalModeProject(path, a.mode));
        return undefined;
      }
      // queries
      case "projects": return projectList(snap).map(({ id: pid, name, open }) => ({ id: pid, name, open }));
      case "profiles": return (snap.profiles ?? []).map(p => ({ id: p.id, name: p.name ?? p.id }));
      case "savedSessions": {
        const cwd = a.projectId === undefined ? null : project();
        return savedView(await bridge.listSavedSessions(cwd));
      }
      case "models": {
        const recent = await bridge.recentModels();
        return {
          current: snap.model ?? null,
          recent: Array.isArray(recent) ? recent : [],
          models: (snap.models ?? []).map(m => ({ provider: m.provider, id: m.id, name: m.name ?? m.id })),
        };
      }
      case "thinkingLevels": return { current: snap.thinkingLevel ?? null, levels: await bridge.thinkingLevels() };
      case "commands": return (bridge.getState?.().commands ?? []).map(c => ({
        name: c.name, description: c.description ?? "", hint: c.argumentHint ?? c.hint ?? "",
      }));
      case "files": return ((await bridge.listFiles(a.query ?? "", MAX_FILES)) ?? []).slice(0, MAX_FILES);
      case "toolOutput": {
        const detail = toolDetail(snap, a.messageId);
        if (!detail) throw new Error("no such tool card");
        return detail;
      }
      case "gitStatus": return unwrap(await bridge.gitBrowserStatus());
      case "gitFile": return unwrap(await bridge.gitBrowserFile(a.path));
      case "gitLog": return unwrap(await bridge.gitBrowserLog());
      case "gitBranches": return unwrap(await bridge.gitBranches());
      case "readFile": return unwrap(await bridge.readProjectFile(a.path));
      case "prStatus": return unwrap(await bridge.prAutomationSnapshot(ctx.tabId)) ?? null;
      case "subagentTranscript": {
        await bridge.loadSubagentTranscript(a.agentId);
        const entry = ctx.snapshot()?.subagentTranscripts?.[a.agentId];
        if (!entry || entry.status === "error") throw new Error(entry?.error ?? "transcript unavailable");
        return { messages: entry.messages ?? [], status: entry.status ?? "" };
      }
      case "usage": return unwrap(await bridge.usageStats());
      case "approvalRules": return await bridge.listApprovalRules();
      case "approvalModes": return await bridge.approvalModes();
      case "conversationTree": {
        const entry = ctx.entry();
        if (!entry?.sessionFile) throw new Error("this tab has no saved conversation yet");
        return unwrap(await bridge.conversationTree(entry.sessionFile, entry.profile ?? "default"));
      }
      default: throw new Error("unknown remote action");
    }
  }

  window.OMP_REMOTE_OPS = { opaqueId, projectList, invalidArgs, relPath, toolDetail, savedView, run, TABLESS };
})();
