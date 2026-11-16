// Steer and cancel for one subagent, shared by the Agents tab and the subagent
// detail screen (Agents.dc.html "Steer…" and the red stop button). Both need
// Control scope; Cancel goes through the shared confirmation sheet. Each
// returns a promise of { ok } and never sends what the scope forbids.
// Exposes window.OMP_REMOTE_AGENT_ACTIONS = { steer(ctx, { tabId, agent }), cancel(ctx, { tabId, agent }) }.
(function (root) {
  const MAX_TEXT = 32 * 1024;

  // The "Steer needs Control" text of a locked Steer control.
  function lockText(gated) {
    if (gated.reason === "scope") return `Steer ${gated.label.replace(/^Needs/, "needs")}`;
    return "Steer unavailable";
  }

  function steer(ctx, { tabId, agent }) {
    const { P, ui } = ctx;
    const gated = ctx.gate("subagentSteer");
    if (!gated.ok) { ctx.lockToast(gated, "Steering"); return Promise.resolve({ ok: false }); }
    return new Promise(resolve => {
      const input = P.h("textarea", { cls: "r-ag-steer-input", attrs: { rows: "4", "aria-label": "Message to the subagent", placeholder: "Tell it what to do differently…", enterkeyhint: "send", maxlength: String(MAX_TEXT) } });
      let sheet = null, sent = false;
      const send = P.button({ label: "Send to subagent", icon: "steer", variant: "primary", size: "lg", cls: "r-btn-block", disabled: true, onClick: async () => {
        const text = input.value.trim();
        if (!text) return;
        sent = true;
        sheet.close("send");
        const result = await ctx.act("subagentSteer", { tabId, args: { agentId: agent.id, text } }, { label: "Steer", success: "Sent to the subagent" });
        resolve({ ok: result.ok });
      } });
      input.addEventListener("input", () => { send.disabled = !input.value.trim(); });
      sheet = ui.openSheet({
        title: "Steer", subtitle: agent.title, label: `Steer ${agent.title}`,
        body: () => [
          P.h("label", { cls: "r-ag-steer-field" }, input),
          P.h("p", { cls: "r-hint", text: "Delivered to the agent as if you had typed it in its own chat." }),
        ],
        footer: () => [send, P.button({ label: "Cancel", variant: "secondary", size: "lg", cls: "r-btn-block", onClick: () => sheet.close("cancel") })],
        onClose: () => { if (!sent) resolve({ ok: false }); },
      });
      input.focus();
    });
  }

  async function cancel(ctx, { tabId, agent }) {
    const gated = ctx.gate("subagentCancel");
    if (!gated.ok) { ctx.lockToast(gated, "Cancelling a subagent"); return { ok: false }; }
    const yes = await ctx.ui.confirm({
      title: `Cancel ${agent.title}?`, body: "It stops now. Work it already returned is kept.",
      confirmLabel: "Cancel subagent", tone: "danger",
    });
    if (!yes) return { ok: false };
    const result = await ctx.act("subagentCancel", { tabId, args: { agentId: agent.id } }, { label: "Cancel subagent", success: "Subagent stopped" });
    return { ok: result.ok };
  }

  root.OMP_REMOTE_AGENT_ACTIONS = { steer, cancel, lockText };
})(typeof window !== "undefined" ? window : globalThis);
