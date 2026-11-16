// Profile switch sheet (ProfileSwitch.dc.html). Choosing a profile shows what
// will happen (the agent restarts as a new, empty session; the old conversation
// stays in the old profile's history) and "Restart on <profile>" confirms it —
// states: confirm → restarting → error (the tab stays on its profile).
// Opened with OMP_REMOTE_UI.openSheetById("profile-switch", { tabId }).
// The tab's current profile is shown only when the desktop publishes it
// (`tab.profile`); the list comes from the tab-less query `profiles`.
(function (root) {
  function open(ctx, params) {
    const { P, ui, conn } = ctx;
    const { h, icon, button } = P;
    const tabId = params?.tabId;
    const tab = ctx.state().tabs.find(item => item.id === tabId);
    if (!tab) return null;
    const gated = ctx.gate("switchProfile");
    if (!gated.ok) { ctx.lockToast(gated, "Switching profile"); return null; }
    const form = { profiles: null, error: "", choice: null, phase: "confirm", detail: "" };
    let handle = null;
    const listEl = h("div", { cls: "r-opt-list", attrs: { role: "radiogroup", "aria-label": "Profile" } });
    const noteEl = h("div", { cls: "r-slot" });
    const footEl = h("div", { cls: "r-slot r-grow-col" });
    const oldName = tab.profile ?? null;
    const choiceName = () => form.profiles?.find(p => p.id === form.choice)?.name ?? "";

    function render() {
      const busy = form.phase === "restarting";
      if (form.error) listEl.replaceChildren(P.callout({ tone: "error", icon: "st-error", title: "Couldn’t load profiles", body: form.error }));
      else if (!form.profiles) listEl.replaceChildren(P.skeleton(3));
      else listEl.replaceChildren(...form.profiles.map(profile => {
        const current = oldName !== null && (profile.id === oldName || profile.name === oldName);
        const on = profile.id === form.choice;
        const row = h("button", { cls: `r-opt${on ? " is-on" : ""}${current ? " is-current" : ""}`, attrs: { role: "radio", "aria-checked": String(on), "aria-disabled": current || busy ? "true" : undefined, "data-profile-id": profile.id },
          on: { click: () => { if (current || busy) return; form.choice = profile.id; form.phase = "confirm"; render(); } } },
          h("span", { cls: `r-radio${on ? " is-on" : ""}` }), h("span", { cls: "r-opt-name", text: profile.name }), current && h("span", { cls: "r-opt-current", text: "Current" }));
        return row;
      }));
      const name = choiceName();
      const was = oldName ? `${oldName}’s` : "the previous profile’s";
      noteEl.replaceChildren(...(form.phase === "confirm" && form.choice ? [P.callout({ tone: "warn", icon: "warning", title: `The agent restarts as a new, empty session on “${name}”.`,
        body: `This conversation stays in ${was} history. It is not carried over.${oldName ? ` You can resume it later from Sessions while on ${oldName}.` : ""}` })]
        : busy ? [P.callout({ tone: "info", icon: "st-running", role: "status", body: `Restarting the agent on ${name}…` })]
        : form.phase === "error" ? [P.callout({ tone: "error", icon: "st-error", title: `omp didn’t start on ${name}`, body: form.detail, mono: true }),
          h("p", { cls: "r-hint", text: `The tab is still on ${oldName ?? "its profile"}. Nothing was lost.` })] : []));
      footEl.replaceChildren(
        button({ label: busy ? "Restarting…" : form.phase === "error" ? "Try again" : form.choice ? `Restart on ${name}` : "Choose a profile",
          icon: busy ? "st-running" : undefined, spin: busy, variant: form.phase === "error" ? "primary" : "warn", size: "lg", cls: "r-btn-block", disabled: busy || !form.choice, onClick: restart }),
        button({ label: "Cancel", variant: "secondary", size: "lg", cls: "r-btn-block", onClick: () => handle.close("cancel") }));
    }

    async function restart() {
      if (!form.choice) return;
      form.phase = "restarting"; render();
      try {
        await conn.request("switchProfile", tabId, { args: { profileId: form.choice } });
        handle.close("done");
        ui.toast({ tone: "ok", text: `Restarted on ${choiceName()}`, duration: 3000 });
      } catch (error) {
        form.phase = "error"; form.detail = error?.message || "unknown error"; render();
      }
    }

    handle = ui.openSheet({
      title: "Switch profile", subtitle: `Tab ${tab.title || "Untitled"}${oldName ? ` · now on ${oldName}` : ""}`, full: true,
      body: () => [listEl, noteEl], footer: () => footEl,
    });
    render();
    ctx.query("profiles").then(list => { form.profiles = Array.isArray(list) ? list : []; render(); },
      error => { form.error = ctx.M.errorFeedback(error).text; render(); });
    return handle;
  }

  root.OMP_REMOTE_UI.registerSheet("profile-switch", open);
})(typeof window !== "undefined" ? window : globalThis);
