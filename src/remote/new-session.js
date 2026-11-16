// New session sheet (NewSession.dc.html): pick one of the projects the desktop
// lists (never a free-typed path), optionally a profile, then `newTab`. Opened
// with OMP_REMOTE_UI.openSheetById("new-session"). The project and profile
// lists are the tab-less queries `projects` and `profiles`; creation is
// inline (starting → error with the desktop's message → Try again), not a toast.
(function (root) {
  function open(ctx) {
    const { M, P, ui, conn } = ctx;
    const { h, icon, button } = P;
    const data = { projects: null, profiles: [], loadError: "" };
    const form = { filter: "", projectId: null, profile: null, phase: "ready", error: "", profilesOpen: false };
    let handle = null;

    const search = P.searchField({ placeholder: "Filter projects", label: "Filter projects", onInput: value => { form.filter = value; renderList(); } });
    const listEl = h("div", { cls: "r-pick-list-slot" });
    const optionsEl = h("section", { cls: "r-block" });
    const alertEl = h("div", { cls: "r-slot" });
    const cta = h("div", { cls: "r-slot r-grow-col" });

    const selectedProject = () => data.projects?.find(p => p.id === form.projectId) ?? null;

    function projectRow(project) {
      const on = project.id === form.projectId;
      const row = h("button", { cls: `r-pick-row${on ? " is-on" : ""}`, attrs: { role: "radio", "aria-checked": String(on), "data-project-id": project.id }, on: { click: () => { form.projectId = project.id; renderList(); renderCta(); } } },
        on ? icon("check", { className: "r-pick-check" }) : h("span", { cls: "r-pick-pad" }),
        h("span", { cls: "r-pick-text" }, h("span", { cls: "r-pick-name", text: project.name }), h("span", { cls: "r-pick-detail", text: M.projectDetail(project, ctx.state().tabs) })));
      return row;
    }
    function renderList() {
      if (data.loadError) {
        listEl.replaceChildren(P.callout({ tone: "error", icon: "st-error", title: "Couldn’t load projects", body: data.loadError }), button({ label: "Retry", variant: "secondary", onClick: load }));
        return;
      }
      if (!data.projects) { listEl.replaceChildren(P.skeleton(3)); return; }
      const shown = M.filterProjects(data.projects, form.filter);
      if (!shown.length) {
        listEl.replaceChildren(P.emptyState({ icon: "folder", title: data.projects.length ? "No matching project" : "No projects yet", body: "Only projects the desktop lists. Add new ones on the desktop." }));
        return;
      }
      listEl.replaceChildren(h("div", { cls: "r-card r-pick-list", attrs: { role: "radiogroup", "aria-label": "Project" } }, ...shown.map(projectRow)));
    }

    function renderOptions() {
      const current = data.profiles.find(p => p.id === form.profile);
      const row = h("button", { cls: "r-select-row", attrs: { "aria-expanded": String(form.profilesOpen) }, on: { click: () => { form.profilesOpen = !form.profilesOpen; renderOptions(); } } },
        h("span", { cls: "r-select-text" }, h("span", { cls: "r-select-label", text: "Profile" }), h("span", { text: current ? current.name : "Default" })),
        icon(form.profilesOpen ? "chevron-up" : "chevron-right", { size: 16 }));
      const choices = form.profilesOpen ? h("div", { cls: "r-card r-pick-list", attrs: { role: "radiogroup", "aria-label": "Profile" } },
        ...[{ id: null, name: "Default" }, ...data.profiles].map(profile => {
          const on = profile.id === form.profile;
          return h("button", { cls: `r-pick-row${on ? " is-on" : ""}`, attrs: { role: "radio", "aria-checked": String(on) }, on: { click: () => { form.profile = profile.id; form.profilesOpen = false; renderOptions(); } } },
            on ? icon("check", { className: "r-pick-check" }) : h("span", { cls: "r-pick-pad" }), h("span", { cls: "r-pick-text" }, h("span", { cls: "r-pick-name", text: profile.name })));
        })) : null;
      const model = h("div", { cls: "r-select-row" },
        h("span", { cls: "r-select-text" }, h("span", { cls: "r-select-label", text: "Model" }), h("span", { text: "Desktop default" })));
      optionsEl.replaceChildren(...[P.sectionTitle("Options"), model, data.profiles.length && row, choices].filter(Boolean));
      optionsEl.hidden = false;
    }

    function renderCta() {
      const project = selectedProject();
      const creating = form.phase === "creating";
      alertEl.replaceChildren(...(form.phase === "error" ? [P.callout({ tone: "error", icon: "st-error", title: "omp didn’t start", body: form.error, mono: true })] : []));
      const label = creating ? "Starting omp…" : form.phase === "error" ? "Try again" : project ? `Start in ${project.name}` : "Choose a project";
      cta.replaceChildren(
        button({ label, icon: creating ? "st-running" : undefined, spin: creating, variant: "primary", size: "lg", cls: "r-btn-block", disabled: creating || !project, onClick: create }),
        h("div", { cls: "r-foot-note", text: "Opens as a new tab on the desktop too" }));
    }

    async function create() {
      const project = selectedProject();
      const anchor = ctx.anchorTab();
      if (!project || !anchor) return;
      const gated = ctx.gate("newTab");
      if (!gated.ok) { ctx.lockToast(gated, "Starting a session"); return; }
      form.phase = "creating"; form.error = ""; renderCta();
      try {
        const args = { projectId: project.id, ...(form.profile ? { profile: form.profile } : {}) };
        const result = await conn.request("newTab", anchor, { args });
        handle.close("created");
        if (result?.tabId) ctx.openTab(result.tabId);
      } catch (error) {
        form.phase = "error"; form.error = error?.message || "unknown error"; renderCta();
      }
    }

    async function load() {
      data.loadError = ""; data.projects = null; renderList();
      try {
        const [projects, profiles] = await Promise.all([ctx.query("projects"), ctx.query("profiles")]);
        data.projects = Array.isArray(projects) ? projects : [];
        data.profiles = Array.isArray(profiles) ? profiles : [];
        if (data.projects.length) form.projectId = data.projects[0].id;
      } catch (error) { data.loadError = M.errorFeedback(error).text; }
      renderList(); renderOptions(); renderCta();
    }

    handle = ui.openSheet({
      title: "New session", full: true,
      body: () => [
        h("section", { cls: "r-block" }, P.sectionTitle("Project"), search.el, listEl, h("p", { cls: "r-hint", text: "Only projects the desktop lists. Add new ones on the desktop." })),
        optionsEl, alertEl,
      ],
      footer: () => cta,
    });
    renderList(); renderOptions(); renderCta();
    load();
    return handle;
  }

  root.OMP_REMOTE_UI.registerSheet("new-session", open);
})(typeof window !== "undefined" ? window : globalThis);
