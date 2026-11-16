// Phone shell and screen registry. Other screen modules plug in by loading
// BEFORE remote.js and calling window.OMP_REMOTE_UI.registerScreen(...); nothing
// in this file or remote.js needs to change for a new screen (one <script> tag
// in index.html + one line in src-tauri/src/remote/assets.rs per module).
//
// ── Registry API (window.OMP_REMOTE_UI) ───────────────────────────────────
//  registerScreen(id, factory, options?)
//      factory(ctx) -> screen, called once, on the first navigation to `id`.
//      screen = { el: HTMLElement,            // the screen's root (required)
//                 show?(params),              // every time it becomes visible
//                 hide?(),                    // when it stops being visible
//                 update?(state) }            // visible screens, on every app state change
//      options = { nav?: boolean }            // bottom nav on a pushed screen (default false;
//                                             //   the four tab ids always have it)
//      The last registration of an id wins; a built screen is rebuilt. Tab ids
//      are 'sessions' | 'chat' | 'review' | 'agents'. A tab without a registered
//      screen shows a placeholder, a pushed id nobody registered does not exist
//      (hasScreen(id) is false: hide your entry points).
//      Ids other modules are expected to register: 'tree' (Conversation tree),
//      'export' (Export HTML), 'usage', 'approval-rules', 'diff', 'tool-output',
//      'subagent'. Conventions for the ones the Sessions/Connection screens link to:
//      navigate('tree' | 'export', { tabId }), navigate('usage' | 'approval-rules').
//  registerSheet(id, open) / openSheetById(id, params)
//      open(ctx, params) -> handle; named sheets so a module can open another's
//      without importing it. Provided: 'new-session', 'session-menu' ({ tabId }),
//      'profile-switch' ({ tabId }).
//  navigate(id, params?)  tab id: switch tab (clears pushed screens); other id: push.
//  back()                 pop one pushed screen (no-op on a tab root).
//  current() -> { id, params, tab, depth } · hasScreen(id) · setGate(id | null, params)
//      A gate replaces everything (pairing); no nav while it is set.
//  setBadge(tabId, count)  the amber count on a nav item (0 hides it).
//  openSheet(spec) / closeSheet(handle?) / confirm(spec)  see ui-sheet.js.
//  toast(spec) / setBanner(id, spec) / run(label, work, opts)  see ui-feedback.js.
//  on(event, fn) -> off   events: 'navigate' ({ id, params, tab, depth }).
// ctx (the factory argument) is built by remote.js: { ui, conn, state(),
// subscribe(fn), proto, gate(kind), act(kind, fields), query(q, fields),
// selectTab(tabId), M (view-model), P (parts), icons }.
(function (root) {
  const TABS = [
    { id: "sessions", label: "Sessions", icon: "nav-sessions" },
    { id: "chat", label: "Chat", icon: "nav-chat" },
    { id: "review", label: "Review", icon: "nav-review" },
    { id: "agents", label: "Agents", icon: "nav-agents" },
  ];
  const isTab = id => TABS.some(tab => tab.id === id);
  const OFF = "OMP_REMOTE_UI is not mounted yet";

  const screens = new Map();   // id → { factory, options, built }
  const sheets = new Map();    // id → open(ctx, params)
  const listeners = new Map(); // event → Set<fn>
  let tab = "sessions", stack = [], gate = null;
  let mounted = null; // { ctx, els, sheet, feedback, navItems, badges }
  const badges = {};

  function emit(name, payload) {
    for (const fn of [...(listeners.get(name) ?? [])]) fn(payload);
  }

  function registerScreen(id, factory, options = {}) {
    const old = screens.get(id);
    if (old?.built) old.built.el.remove?.();
    screens.set(id, { factory, options, built: null });
    if (mounted && options.live) { build(id); screens.get(id).built.update?.(mounted.ctx.state()); }
    if (mounted && shown === id) { shown = null; render(); }
  }

  function build(id) {
    const entry = screens.get(id);
    if (!entry) return null;
    if (!entry.built) {
      entry.built = entry.factory(mounted.ctx);
      entry.built.el.hidden = true;
      mounted.els.screens.append(entry.built.el);
    }
    return entry.built;
  }

  function placeholder(tabInfo) {
    const { h, emptyState } = root.OMP_REMOTE_PARTS;
    const header = root.OMP_REMOTE_PARTS.header({ title: tabInfo.label, large: true });
    const el = h("section", { cls: "r-screen", attrs: { "aria-label": tabInfo.label } }, header.el,
      h("div", { cls: "r-scroll" }, emptyState({ icon: tabInfo.icon, title: tabInfo.label, body: "This screen is not available in this build yet." })));
    return { el };
  }

  // The screen id on top now, and whether the bottom nav shows.
  function top() {
    if (gate) return { id: gate.id, params: gate.params, nav: false };
    if (stack.length) {
      const entry = stack.at(-1);
      return { id: entry.id, params: entry.params, nav: Boolean(screens.get(entry.id)?.options.nav) };
    }
    return { id: tab, params: undefined, nav: true };
  }

  let shown = null; // id currently visible
  function render(showParams = true) {
    if (!mounted) return;
    const now = top();
    const tabInfo = TABS.find(item => item.id === now.id);
    let screen = build(now.id);
    if (!screen && tabInfo) {
      const entry = { factory: () => placeholder(tabInfo), options: { placeholder: true }, built: null };
      screens.set(now.id, entry);
      screen = build(now.id);
    }
    if (!screen) return;
    if (shown && shown !== now.id) {
      const prev = screens.get(shown)?.built;
      if (prev) { prev.hide?.(); prev.el.hidden = true; }
    }
    shown = now.id;
    screen.update?.(mounted.ctx.state());
    screen.el.hidden = false;
    if (showParams) screen.show?.(now.params);
    mounted.els.nav.hidden = !now.nav;
    for (const [id, item] of Object.entries(mounted.navItems)) {
      if (id === tab && !stack.length) item.setAttribute("aria-current", "page"); else item.removeAttribute?.("aria-current");
    }
    if (!gate) emit("navigate", { ...current() });
  }

  function current() {
    const now = top();
    return { id: now.id, params: now.params, tab, depth: stack.length };
  }

  function navigate(id, params) {
    if (isTab(id)) { tab = id; stack = []; }
    else if (stack.at(-1)?.id === id) stack[stack.length - 1] = { id, params };
    else stack.push({ id, params });
    render();
  }
  function back() {
    if (!stack.length) return;
    stack.pop();
    render();
  }
  function setGate(id, params) {
    gate = id ? { id, params } : null;
    render();
  }
  function setBadge(id, count) {
    badges[id] = count;
    const el = mounted?.badges[id];
    if (!el) return;
    el.textContent = String(count);
    el.hidden = !count;
    el.setAttribute("aria-label", `${count} waiting`);
  }

  function registerSheet(id, open) { sheets.set(id, open); }
  function openSheetById(id, params) {
    const open = sheets.get(id);
    return open && mounted ? open(mounted.ctx, params) : null;
  }

  // Build the shell into `app`: banners, screen host (+ toasts), bottom nav.
  function mount({ app, ctx }) {
    const { h, icon } = root.OMP_REMOTE_PARTS;
    const banners = h("div", { cls: "r-banners" });
    const toasts = h("div", { cls: "r-toasts", attrs: { "aria-live": "polite" } });
    const screensEl = h("div", { cls: "r-screens" }, toasts);
    const navItems = {}, badgeEls = {};
    const nav = h("nav", { cls: "r-nav", attrs: { "aria-label": "Main" } });
    for (const item of TABS) {
      const badge = h("span", { cls: "r-nav-badge", hidden: true });
      badgeEls[item.id] = badge;
      const el = h("button", { cls: "r-nav-item", on: { click: () => navigate(item.id) } },
        icon(item.icon), h("span", { text: item.label }), badge);
      navItems[item.id] = el;
      nav.append(el);
    }
    app.replaceChildren(banners, screensEl, nav);
    const sheet = root.OMP_REMOTE_SHEET.create({ host: app, background: [banners, screensEl, nav] });
    const feedback = root.OMP_REMOTE_FEEDBACK.create({ toastHost: toasts, bannerHost: banners });
    mounted = { ctx, els: { screens: screensEl, nav }, sheet, feedback, navItems, badges: badgeEls };
    for (const [id, count] of Object.entries(badges)) setBadge(id, count);
    for (const [id, entry] of screens) if (entry.options.live) build(id);
  }

  // Push the app state to the visible screen.
  function update(state) {
    if (!mounted) return;
    for (const [id, entry] of screens) {
      if (entry.built && (entry.options.live || id === shown)) entry.built.update?.(state);
    }
  }

  const needs = name => { if (!mounted) throw new Error(OFF); return mounted[name]; };
  root.OMP_REMOTE_UI = {
    TABS, registerScreen, registerSheet, openSheetById, navigate, back, current, setGate, setBadge, mount, update,
    hasScreen: id => screens.has(id) && !screens.get(id).options.placeholder,
    openSheet: spec => needs("sheet").open(spec),
    closeSheet: handle => needs("sheet").close(handle),
    confirm: spec => needs("sheet").confirm(spec),
    toast: spec => needs("feedback").toast(spec),
    setBanner: (id, spec) => needs("feedback").setBanner(id, spec),
    run: (label, work, opts) => needs("feedback").run(label, work, opts),
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
