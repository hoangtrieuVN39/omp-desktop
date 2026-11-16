// Operation feedback: toasts (pending / done / failed with a retry), banners
// under the status bar (offline, reconnecting, revoked, "desktop switched")
// and `run`, which wraps a request so it always shows "Waiting for desktop…"
// while pending and a mapped failure toast with Retry. Copy and error mapping
// come from OMP_REMOTE_MODEL (CopyDeck "op.*").
// Exposes window.OMP_REMOTE_FEEDBACK = { create({ toastHost, bannerHost }) }
// returning { toast(spec) -> { update, dismiss }, setBanner(id, spec | null), run(label, work, opts) }.
//   toast spec  { text, tone: info|pending|ok|warn|error|lock, icon, mono, note,
//                 action: { label, onClick }, duration (ms, 0 = stays; default 4000) }
//   banner spec { tone: warn|error|info, icon, spin, text, action: { label, onClick } }
//   run(label, work, { success, retry = true, pendingAfter = 300 }) -> Promise<{ ok, value?, error? }>
//     `work` is a function returning a promise (so Retry can call it again).
(function (root) {
  const TONE_ICON = { pending: "st-running", ok: "check", warn: "st-waiting", error: "st-error", lock: "lock", info: "desktop" };
  const MAX_TOASTS = 3;

  function create({ toastHost, bannerHost }) {
    const { h, icon, button } = root.OMP_REMOTE_PARTS;
    const M = root.OMP_REMOTE_MODEL;
    const toasts = new Set();
    const banners = new Map();

    function toast(spec) {
      const el = h("div", { cls: "r-toast", attrs: { role: spec.tone === "error" ? "alert" : "status" } });
      const entry = { dismiss() {}, timer: null };
      entry.dismiss = () => {
        if (!toasts.delete(entry)) return;
        root.clearTimeout(entry.timer);
        el.remove?.();
      };
      const render = () => {
        const tone = spec.tone ?? "info";
        el.className = `r-toast r-toast-${tone}`;
        el.replaceChildren(...[
          icon(spec.icon ?? TONE_ICON[tone], { className: tone === "pending" ? "spin" : "" }),
          h("span", { cls: spec.mono ? "mono" : "", text: spec.text }),
          spec.note && h("span", { cls: "r-toast-note", text: spec.note }),
          spec.action && button({ label: spec.action.label, variant: "secondary", size: "sm", onClick: () => { entry.dismiss(); spec.action.onClick(); } }),
        ].filter(Boolean));
        const duration = spec.duration ?? 4000;
        root.clearTimeout(entry.timer);
        entry.timer = duration > 0 ? root.setTimeout(entry.dismiss, duration) : null;
      };
      render();
      toasts.add(entry);
      toastHost.append(el);
      if (toasts.size > MAX_TOASTS) toasts.values().next().value.dismiss();
      return { update(next) { Object.assign(spec, next); render(); }, dismiss: entry.dismiss };
    }

    function setBanner(id, spec) {
      banners.get(id)?.remove?.();
      banners.delete(id);
      if (!spec) return;
      const el = h("div", { cls: `r-banner r-banner-${spec.tone ?? "info"}`, attrs: { role: spec.tone === "error" ? "alert" : "status" } },
        icon(spec.icon ?? "desktop", { className: spec.spin ? "spin" : "" }),
        h("span", { text: spec.text }),
        spec.action && button({ label: spec.action.label, variant: "secondary", size: "sm", onClick: spec.action.onClick }));
      banners.set(id, el);
      bannerHost.append(el);
    }

    // Runs `work()`; the pending toast shows only if it takes longer than pendingAfter.
    async function run(label, work, opts = {}) {
      const { success, retry = true, pendingAfter = 300 } = opts;
      let pending = null;
      const timer = root.setTimeout(() => { pending = toast({ tone: "pending", text: M.COPY.opPending, note: "≤ 15 s", duration: 0 }); }, pendingAfter);
      try {
        const value = await work();
        root.clearTimeout(timer); pending?.dismiss();
        if (success) toast({ tone: "ok", text: success, duration: 3000 });
        return { ok: true, value };
      } catch (error) {
        root.clearTimeout(timer); pending?.dismiss();
        const fb = M.errorFeedback(error);
        toast({
          tone: fb.tone, text: fb.text, mono: fb.mono, duration: 6000,
          action: retry && fb.retry ? { label: fb.retry, onClick: () => run(label, work, opts) } : null,
        });
        return { ok: false, error };
      }
    }

    return { toast, setBanner, run };
  }

  root.OMP_REMOTE_FEEDBACK = { create };
})(typeof window !== "undefined" ? window : globalThis);
