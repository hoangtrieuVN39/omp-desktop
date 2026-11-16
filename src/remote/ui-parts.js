// Small DOM builders shared by every phone screen: `h`, buttons, pills, lock
// chips, section titles, callouts, empty/skeleton states, fields, switches and
// screen headers (the System.dc.html component set). All text goes through
// textContent; nothing here touches innerHTML or `style` attributes. Class
// names are prefixed `r-` so they never collide with the desktop CSS the
// transcript still loads (ui.css).
// Exposes window.OMP_REMOTE_PARTS.
(function (root) {
  const doc = () => root.document;
  const I = () => root.OMP_REMOTE_ICONS;

  // h("div", { cls, text, attrs, on, hidden }, ...childNodes). Falsy children
  // are skipped, so a conditional child can be `cond && node`.
  function h(tag, props = {}, ...kids) {
    const el = doc().createElement(tag);
    if (tag === "button") el.type = "button";
    if (props.cls) el.className = props.cls;
    if (props.text !== undefined) el.textContent = props.text;
    for (const [name, value] of Object.entries(props.attrs ?? {})) {
      if (value !== undefined && value !== null && value !== false) el.setAttribute(name, value === true ? "" : String(value));
    }
    // Handlers return nothing: an async one must not hand its promise to the event system.
    for (const [name, fn] of Object.entries(props.on ?? {})) el.addEventListener(name, event => { fn(event); });
    if (props.hidden) el.hidden = true;
    for (const kid of kids.flat()) if (kid) el.append(kid);
    return el;
  }
  const icon = (name, opts) => I().svg(name, opts);

  // variant: primary | secondary | danger (outline) | danger-fill | warn | ghost.
  // size: lg (54 px, bottom CTAs) | md (48) | sm (36, toast actions).
  function button({ label, icon: iconName, variant = "secondary", size = "md", onClick, ariaLabel, disabled, cls, spin } = {}) {
    const el = h("button", {
      cls: `r-btn r-btn-${variant} r-btn-${size}${cls ? ` ${cls}` : ""}`,
      attrs: { "aria-label": ariaLabel },
      on: onClick ? { click: onClick } : undefined,
    }, iconName && icon(iconName, { className: spin ? "spin" : "" }), label && h("span", { text: label }));
    if (disabled) el.disabled = true;
    return el;
  }
  // 44 x 44 icon-only control; `label` is its accessible name.
  function iconButton({ icon: iconName, label, onClick, variant = "ghost", cls }) {
    return h("button", {
      cls: `r-icon-btn r-icon-btn-${variant}${cls ? ` ${cls}` : ""}`,
      attrs: { "aria-label": label },
      on: onClick ? { click: onClick } : undefined,
    }, icon(iconName));
  }

  // Status pill: always icon + word, never colour alone.
  function statusPill(status, extra) {
    return h("span", { cls: `r-pill r-st-${status.id}` }, icon(status.icon, { size: 14, className: status.id === "running" ? "spin" : "" }), h("span", { text: extra ?? status.label }));
  }
  // Dashed "Needs Manage" chip for a locked control.
  const lockChip = text => h("span", { cls: "r-lock-chip", text });
  // Small bordered tag ("On desktop").
  const chip = (text, iconName) => h("span", { cls: "r-chip" }, iconName && icon(iconName, { size: 12 }), h("span", { text }));

  function sectionTitle(text, { tone, icon: iconName } = {}) {
    return h("div", { cls: `r-section${tone ? ` r-tone-${tone}` : ""}` },
      iconName && icon(iconName, { size: 18 }), h("h2", { cls: "r-section-title", text }));
  }

  // Inline notice: tone warn | error | ok | info.
  function callout({ tone = "info", icon: iconName, title, body, mono, role }) {
    const text = h("div", { cls: "r-callout-text" }, title && h("b", { text: title }),
      body && h("span", { cls: mono ? "mono r-callout-mono" : "r-callout-body", text: body }));
    return h("div", { cls: `r-callout r-callout-${tone}`, attrs: { role: role ?? (tone === "error" ? "alert" : "note") } },
      iconName && icon(iconName), text);
  }

  function emptyState({ icon: iconName, title, body }) {
    return h("div", { cls: "r-empty" }, iconName && icon(iconName, { size: 32 }), h("b", { text: title }), body && h("span", { text: body }));
  }
  // Loading placeholder: a heading bar and `rows` list-row blocks.
  function skeleton(rows = 2) {
    const list = h("div", { cls: "r-skeleton", attrs: { "aria-hidden": "true" } }, h("div", { cls: "r-skeleton-bar" }));
    for (let i = 0; i < rows; i++) list.append(h("div", { cls: "r-skeleton-row" }));
    return list;
  }

  // Search / filter input in its bordered label. Returns { el, input }.
  function searchField({ placeholder, label, value = "", onInput }) {
    const input = h("input", { cls: "r-field-input", attrs: { placeholder, "aria-label": label, type: "search", enterkeyhint: "search", autocomplete: "off", autocapitalize: "off", spellcheck: "false" } });
    input.value = value;
    if (onInput) input.addEventListener("input", () => onInput(input.value));
    return { el: h("label", { cls: "r-field" }, icon("search", { size: 18 }), input), input };
  }

  // iOS-style switch (role=switch). Returns { el, set(checked), setBusy(bool) }.
  function switchControl({ label, checked = false, onToggle }) {
    const el = h("button", { cls: "r-switch", attrs: { role: "switch", "aria-checked": String(checked), "aria-label": label } }, h("span", { cls: "r-switch-knob" }));
    el.addEventListener("click", () => onToggle?.(el.getAttribute("aria-checked") !== "true"));
    return {
      el,
      set(value) { el.setAttribute("aria-checked", String(Boolean(value))); },
      disable(value) { el.disabled = Boolean(value); },
    };
  }

  // Screen header. Large: 30 px title with trailing actions (Sessions).
  // Compact: back button plus 20 px title (Connection and pushed screens).
  // Returns { el, title(text), actions: HTMLElement }.
  function header({ title, back, onBack, large = false, subtitle }) {
    const titleEl = h("h1", { cls: large ? "r-title r-title-lg" : "r-title", text: title });
    const actions = h("div", { cls: "r-header-actions" });
    const sub = h("div", { cls: "r-subtitle", text: subtitle ?? "", hidden: !subtitle });
    const text = h("div", { cls: "r-header-text" }, titleEl, sub);
    const el = h("header", { cls: `r-header${large ? " r-header-lg" : ""}` },
      back && iconButton({ icon: "back", label: typeof back === "string" ? back : "Back", onClick: onBack }), text, actions);
    return { el, actions, title(value) { titleEl.textContent = value; }, subtitle(value) { sub.textContent = value ?? ""; sub.hidden = !value; } };
  }

  // Permanent notice a view-only phone shows on screens full of locked controls.
  function scopeBanner(scope) {
    const text = root.OMP_REMOTE_MODEL.COPY.scopeView;
    return scope === "view" ? h("div", { cls: "r-scope-banner", attrs: { role: "note" } }, icon("lock", { size: 18 }), h("span", { text })) : null;
  }
  // One label/value row of a settings-style card (Connection).
  function kvRow(label, value, { last } = {}) {
    return h("div", { cls: `r-kv${last ? " r-kv-last" : ""}` }, h("span", { text: label }), typeof value === "string" ? h("span", { text: value }) : value);
  }

  root.OMP_REMOTE_PARTS = { h, icon, button, iconButton, statusPill, lockChip, chip, sectionTitle, callout, emptyState, skeleton, searchField, switchControl, header, scopeBanner, kvRow };
})(typeof window !== "undefined" ? window : globalThis);
