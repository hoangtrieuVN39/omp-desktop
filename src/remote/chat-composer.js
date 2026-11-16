// Phone Chat composer (ChatRunning / ChatSE .dc.html): send, steer, queue,
// stop, /command and @file palettes, image uploads and the phone's queued
// items. Every action goes through ctx.act (scope-gated). Only the upload API
// sends binary; upload IDs are consumed in `args.images` on successful send.
(function (root) {
  const L = root.OMP_REMOTE_CHAT;
  const MAX_SIDE = 2048;
  const FILE_LIMIT = root.OMP_REMOTE_PROTO.LIMITS.maxUploadBytes;
  const MIMES = root.OMP_REMOTE_PROTO.LIMITS.uploadMimes;
  const MAX_UPLOADS = root.OMP_REMOTE_PROTO.LIMITS.maxUploads;

  function create(ctx, { onModel }) {
    const { h, icon, iconButton, button } = ctx.P;
    const wrap = h("div", { cls: "r-chat-compose-wrap" });
    const palette = h("div", { cls: "r-composer-palette", attrs: { role: "listbox", "aria-label": "Commands and files" }, hidden: true });
    const queue = h("div", { cls: "r-composer-queue", hidden: true });
    const lock = h("div", { cls: "r-composer-lock", attrs: { role: "note" }, hidden: true }, icon("lock"), h("span", { text: L.COPY.viewOnlySend }));
    const composer = h("div", { cls: "r-chat-composer" });
    const field = h("textarea", { cls: "r-chat-field", attrs: { "aria-label": "Message", rows: "1", enterkeyhint: "send", autocapitalize: "sentences" } });
    const attachInput = h("input", { cls: "r-sr", attrs: { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif", multiple: "" } });
    const attachments = h("div", { cls: "r-composer-attachments", hidden: true });
    const attachBtn = iconButton({ icon: "image", label: "Attach image", onClick: () => attachInput.click(), cls: "r-compose-attach" });
    const slashBtn = iconButton({ icon: "slash", label: "Commands", onClick: () => { field.value = "/"; field.focus(); onInput(); }, cls: "r-compose-slash" });
    const modelLabel = h("span", { text: "Model & modes" });
    const modelBtn = h("button", { cls: "r-compose-model", on: { click: () => onModel() }, attrs: { "aria-label": "Model and modes" } }, modelLabel, icon("chevron-down", { size: 14 }));
    const controls = h("div", { cls: "r-compose-controls" });
    const steer = h("button", { cls: "r-mode-btn", attrs: { role: "radio", "aria-checked": "true" }, text: "Steer", on: { click: () => { mode = "steer"; sync(); } } });
    const later = h("button", { cls: "r-mode-btn", attrs: { role: "radio", "aria-checked": "false" }, text: "Queue", on: { click: () => { mode = "queue"; sync(); } } });
    const modes = h("div", { cls: "r-mode-group", attrs: { role: "radiogroup", "aria-label": "When to deliver" } }, steer, later);
    const act = h("button", { cls: "r-compose-action", attrs: { "aria-label": "Send" }, on: { click: () => submit() } });
    controls.append(modes, act);
    const tools = h("div", { cls: "r-compose-toolbar" }, attachBtn, slashBtn, modelBtn, h("span", { cls: "r-compose-spacer" }), controls);
    const box = h("div", { cls: "r-compose-box" }, attachments, field, tools);
    composer.append(box, attachInput);
    wrap.append(palette, queue, composer, lock);

    let mode = "steer", view = null, state = null, currentTab = null, localQueue = [];
    let commands = [], loadingCommands = false, commandTab = null;
    let options = [], selected = 0, paletteKind = "", paletteKey = "";
    let fileTimer = null, fileSeq = 0, dismissed = "";
    const uploads = []; // [{ id, name, progress, el, cancel }]
    let sending = false;

    const gate = kind => ctx.gate(kind).ok;
    const can = () => ({ prompt: gate("prompt"), steer: gate("steer"), followUp: gate("followUp"), abort: gate("abort") });
    const allowed = () => state?.connected && can().prompt && Boolean(view);
    const draftMode = () => L.composerState({ busy: view?.busy, draft: field.value, mode, uploading: uploads.some(u => u.progress < 1), can: can() });
    function fit() { field.style.height = "auto"; field.style.height = `${Math.min(field.scrollHeight, 120)}px`; }

    function sync() {
      const c = can(), s = draftMode();
      lock.hidden = c.prompt;
      composer.hidden = !c.prompt;
      if (!c.prompt) { act.disabled = true; return; }
      field.disabled = !state?.connected || !view || sending;
      field.placeholder = L.composerPlaceholder({ busy: view?.busy, asking: view?.asks?.length, locked: false });
      attachBtn.hidden = !ctx.proto?.canUpload?.() || !allowed();
      slashBtn.hidden = !ctx.proto?.canQuery?.("commands") || !allowed();
      modelBtn.hidden = !ctx.proto?.canQuery?.("models") || !allowed();
      modes.hidden = !s.modes;
      steer.setAttribute("aria-checked", String(mode === "steer"));
      later.setAttribute("aria-checked", String(mode === "queue"));
      act.disabled = s.disabled || !state?.connected || !view || sending;
      act.setAttribute("aria-label", s.aria);
      act.className = `r-compose-action is-${s.kind}`;
      act.replaceChildren(...[icon(s.kind === "stop" ? "stop" : s.kind === "send" ? "send" : "steer", { size: s.kind === "stop" ? 16 : 18 }),
        s.kind !== "send" && h("span", { text: s.label })].filter(Boolean));
      queue.hidden = !renderQueue();
      if (!allowed()) hidePalette();
    }

    function renderQueue() {
      const items = L.queueOf(view, localQueue);
      queue.replaceChildren();
      if (!items.length) return false;
      const item = items[0];
      const text = h("span", { cls: "r-queue-text", text: item.text });
      const label = h("span", { cls: "r-queue-label", text: L.COPY.queued });
      const now = iconButton({ icon: "send", label: "Send queued message now", onClick: () => queueAction("queueSendNow", item), cls: "r-queue-action" });
      const promote = iconButton({ icon: "chevron-up", label: "Move queued message up", onClick: () => queueAction("queuePromote", item), cls: "r-queue-action" });
      const remove = iconButton({ icon: "close", label: "Remove queued message", onClick: () => queueAction("queueRemove", item), cls: "r-queue-action" });
      promote.hidden = items.length <= 1;
      for (const b of [now, promote, remove]) b.disabled = !gate(b === promote ? "queuePromote" : b === remove ? "queueRemove" : "queueSendNow");
      queue.append(h("div", { cls: "r-queue-row" }, label, text, promote, now, remove));
      if (items.length > 1) queue.append(h("span", { cls: "r-queue-count", text: `+${items.length - 1} more queued` }));
      return true;
    }
    async function queueAction(kind, item) {
      const result = await ctx.act(kind, { tabId: currentTab, args: { text: item.text, ...(kind !== "queuePromote" ? { queue: item.queue } : {}) } }, { label: kind === "queueRemove" ? "Remove queued message" : kind === "queuePromote" ? "Move queued message up" : "Send queued message now", retry: false });
      if (result.ok) {
        if (kind === "queueRemove" || kind === "queueSendNow") localQueue = L.queueRemoveItem(localQueue, item);
        else localQueue = L.queuePromoteItem(localQueue, item);
        sync();
      }
    }

    function removeUpload(upload, cancel = true) {
      const at = uploads.indexOf(upload);
      if (at < 0) return;
      if (cancel) upload.cancel?.();
      uploads.splice(at, 1);
      upload.el.remove();
      attachments.hidden = uploads.length === 0;
      sync();
    }
    // Decode and re-encode unsupported/oversized camera formats to JPEG,
    // scaling to 2048 px and lowering quality to stay inside the protocol cap.
    async function imageBytes(file) {
      if (MIMES.includes(file.type) && file.size <= FILE_LIMIT) return { mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
      const bitmap = await root.createImageBitmap(file);
      try {
        let scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
        for (let attempt = 0; attempt < 4; attempt++) {
          const canvas = root.document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(bitmap.width * scale));
          canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", Math.max(.54, .88 - attempt * .12)));
          if (!blob) throw new Error("Couldn’t prepare this image");
          if (blob.size <= FILE_LIMIT) return { mime: "image/jpeg", bytes: new Uint8Array(await blob.arrayBuffer()) };
          scale *= .65;
        }
      } finally { bitmap.close?.(); }
      throw new Error("Image is too large after resizing (max 1.5 MB).");
    }
    async function addFile(file) {
      if (!ctx.proto?.canUpload?.()) { ctx.ui.toast({ tone: "lock", text: "Image attach is not available for this phone." }); return; }
      if (uploads.length >= MAX_UPLOADS) { ctx.ui.toast({ tone: "warn", text: "Up to 8 images per message." }); return; }
      const name = (file.name || "Image").slice(0, 50);
      const progress = h("span", { cls: "r-attachment-progress", text: "Preparing…" });
      const image = h("span", { cls: "r-attachment-thumb" }, icon("image", { size: 18 }));
      const preview = h("span", { cls: "r-attachment-name", text: name });
      const close = iconButton({ icon: "close", label: `Remove ${name}`, onClick: () => removeUpload(upload), cls: "r-attachment-remove" });
      const el = h("div", { cls: "r-attachment" }, image, preview, progress, close);
      const upload = { id: null, name, progress: 0, el, cancel: null };
      uploads.push(upload);
      attachments.append(el); attachments.hidden = false; sync();
      try {
        const prepared = await imageBytes(file);
        if (!uploads.includes(upload)) return;
        const promise = ctx.proto.uploadImage(prepared, ({ sent, total }) => { progress.textContent = `${Math.round(sent / total * 100)}%`; });
        upload.cancel = promise.cancel;
        upload.id = await promise;
        if (!uploads.includes(upload)) { ctx.proto.cancelUpload(upload.id); return; }
        upload.progress = 1;
        progress.textContent = "Ready";
        sync();
      } catch (error) {
        if (uploads.includes(upload)) { removeUpload(upload, false); ctx.ui.toast({ tone: "error", text: error.message ?? "Couldn’t attach image" }); }
      }
    }
    attachInput.addEventListener("change", () => {
      for (const file of attachInput.files ?? []) addFile(file);
      attachInput.value = "";
    });

    async function submit() {
      if (sending) return;
      const s = draftMode();
      if (s.kind !== "stop" && L.tooLong(field.value)) { ctx.ui.toast({ tone: "error", text: L.COPY.tooLong }); return; }
      const ids = uploads.map(u => u.id).filter(Boolean);
      const plan = L.submitPlan(s, field.value, ids);
      if (!plan) return;
      sending = true; sync();
      const result = await ctx.act(plan.kind, { tabId: currentTab, ...plan.fields }, { label: s.label, retry: false });
      sending = false;
      if (result.ok) {
        if (plan.kind !== "abort") {
          if (plan.kind === "followUp") localQueue = L.queueAdd(localQueue, { text: plan.fields.text }, view?.messages);
          field.value = ""; fit(); hidePalette();
          ctx.proto?.consumeUploads?.(ids);
          for (const u of [...uploads]) removeUpload(u, false);
        } else root.OMP_REMOTE_CHAT_SCREEN?.markStopped(currentTab);
      }
      sync();
    }

    // ── palette ───────────────────────────────────────────────────────────
    function hidePalette() { palette.hidden = true; palette.replaceChildren(); options = []; paletteKind = ""; }
    function renderPalette(kind, query, items) {
      if (!items.length) { hidePalette(); return; }
      options = items; paletteKind = kind; selected = Math.min(selected, items.length - 1);
      palette.replaceChildren(h("div", { cls: "r-palette-title", text: kind === "slash" ? `Commands & skills · matching “${query}”` : `Files · matching “${query}”` }));
      items.forEach((item, index) => {
        const primary = kind === "slash" ? `/${item.name}` : item.path;
        const note = kind === "slash" ? item.description ?? "" : item.isDir ? "Folder" : "File";
        const hint = kind === "slash" ? item.hint : "";
        const row = h("button", { cls: `r-palette-item${index === selected ? " is-selected" : ""}`, attrs: { role: "option", "aria-selected": String(index === selected) }, on: { click: () => pick(index) } },
          h("span", { cls: "mono r-palette-name", text: primary }), hint && h("span", { cls: "r-palette-hint", text: hint }),
          h("span", { cls: "r-palette-note", text: note }));
        palette.append(row);
      });
      palette.hidden = false;
    }
    function pick(index) {
      const item = options[index];
      if (!item) return;
      let change;
      if (paletteKind === "slash") change = { text: L.commandText(item), caret: L.commandText(item).length };
      else {
        const range = L.mentionToken(field.value, field.selectionStart);
        if (!range) return;
        change = L.applyToken(field.value, range, L.mentionInsert(item));
      }
      field.value = change.text;
      field.focus(); field.setSelectionRange(change.caret, change.caret);
      hidePalette(); onInput();
    }
    async function fetchCommands(tab) {
      if (loadingCommands || !ctx.proto?.canQuery?.("commands")) return;
      loadingCommands = true;
      try {
        const list = await ctx.query("commands", { tabId: tab });
        if (tab === currentTab) { commands = Array.isArray(list) ? list : []; commandTab = tab; refreshPalette(); }
      } catch { /* a disconnected or old desktop simply has no palette */ }
      finally { loadingCommands = false; }
    }
    function refreshPalette() {
      if (!allowed()) { hidePalette(); return; }
      const mention = L.mentionToken(field.value, field.selectionStart);
      const slash = mention ? null : L.slashQuery(field.value);
      const key = mention ? `file:${mention.start}:${mention.query}` : slash !== null ? `slash:${slash}` : "";
      if (!key || key === dismissed) { hidePalette(); return; }
      if (slash !== null) {
        selected = key === paletteKey ? selected : 0; paletteKey = key;
        renderPalette("slash", slash, L.filterCommands(commands, slash));
        if (commandTab !== currentTab) fetchCommands(currentTab);
        return;
      }
      if (!ctx.proto?.canQuery?.("files")) { hidePalette(); return; }
      if (key === paletteKey && paletteKind === "file") return;
      paletteKey = key; selected = 0;
      root.clearTimeout(fileTimer);
      const seq = ++fileSeq;
      fileTimer = root.setTimeout(async () => {
        try {
          const list = await ctx.query("files", { tabId: currentTab, args: { query: mention.query } });
          if (seq === fileSeq && paletteKey === key) renderPalette("file", mention.query, (Array.isArray(list) ? list : []).map(L.fileItem).filter(Boolean));
        } catch { if (seq === fileSeq) hidePalette(); }
      }, 120);
    }
    function onInput() { fit(); dismissed = ""; refreshPalette(); sync(); }
    field.addEventListener("input", onInput);
    field.addEventListener("click", refreshPalette);
    field.addEventListener("keyup", event => { if (event.key.startsWith("Arrow")) refreshPalette(); });
    field.addEventListener("keydown", event => {
      if (!palette.hidden && options.length) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
          renderPalette(paletteKind, paletteKind === "slash" ? L.slashQuery(field.value) : L.mentionToken(field.value, field.selectionStart)?.query, options); return;
        }
        if (event.key === "Escape") { event.preventDefault(); dismissed = paletteKey; hidePalette(); return; }
        if (event.key === "Tab" || event.key === "Enter" && !event.shiftKey) { event.preventDefault(); pick(selected); return; }
      }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
    });
    function update(next, activeView) {
      const tab = next.activeTabId ?? activeView?.tabId;
      if (currentTab !== tab) {
        // Uploads are tab-bound: never send one tab's upload with another tab's text.
        for (const u of [...uploads]) removeUpload(u);
        field.value = ""; fit(); hidePalette(); localQueue = []; commands = []; commandTab = null;
        fileSeq++; currentTab = tab;
      }
      state = next; view = activeView;
      modelLabel.textContent = L.modelChip(view);
      localQueue = L.queuePrune(localQueue, view?.messages);
      sync();
    }
    return { el: wrap, update, setDraft(text) { field.value = String(text ?? ""); fit(); onInput(); field.focus(); }, focus: () => field.focus() };
  }
  root.OMP_REMOTE_CHAT_COMPOSER = { create };
})(typeof window !== "undefined" ? window : globalThis);
