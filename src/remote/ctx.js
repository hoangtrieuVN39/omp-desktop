// App context handed to every screen factory (see ui-shell.js): the store, the
// shell and the helpers that make "send a request" one call with scope gating
// and pending/failed feedback. Built once by remote.js.
// Exposes window.OMP_REMOTE_CTX = { create({ conn, ui }) }.
//   ctx.state() / ctx.subscribe(fn)    the connection store's snapshot and changes
//   ctx.gate(kind) -> { ok, reason, needs, label }   scope gating for an action kind
//   ctx.lockToast(gated, label)        the toast a tap on a locked control shows
//   ctx.anchorTab() -> tabId | null    the tab an action rides on (the active one)
//   ctx.act(kind, fields?, opts?) -> Promise<{ ok, value?, error? }>
//        protocol-2 action; fields = { tabId?, text?, askId?, value?, args? }; refuses
//        (toast) what the scope forbids and never sends it; opts = { label, success, retry }
//   ctx.query(q, fields?) -> Promise<data>   rejects like proto.query (no feedback)
//   ctx.openTab(tabId)                 select the tab (the desktop follows) and open Chat
//   ctx.M / ctx.P / ctx.icons / ctx.proto / ctx.ui / ctx.conn
(function (root) {
  // Queries the desktop answers without activating a tab (remote-ops.js TABLESS).
  const TABLESS = new Set(["projects", "profiles", "approvalModes"]);

  function create({ conn, ui }) {
    const M = root.OMP_REMOTE_MODEL;
    let hinted = false;

    const ctx = {
      ui, conn, M, P: root.OMP_REMOTE_PARTS, icons: root.OMP_REMOTE_ICONS, proto: conn.proto,
      state: conn.state, subscribe: conn.subscribe,
      gate: kind => M.gate(conn.state(), kind),
      lockToast(gated, label) {
        ui.toast({ tone: "lock", text: M.lockMessage(conn.state(), gated, label), duration: 5000 });
      },
      anchorTab() {
        const state = conn.state();
        return state.activeTabId ?? state.tabs[0]?.id ?? null;
      },
      async act(kind, fields = {}, opts = {}) {
        const label = opts.label ?? kind;
        const gated = ctx.gate(kind);
        if (!gated.ok) {
          ctx.lockToast(gated, label);
          return { ok: false, error: Object.assign(new Error("not allowed"), { code: "not-allowed" }) };
        }
        const { tabId = ctx.anchorTab(), ...rest } = fields;
        if (!tabId) {
          ui.toast({ tone: "warn", text: "Open a session on the desktop first — the phone acts through an open tab.", duration: 6000 });
          return { ok: false, error: new Error("no open tab") };
        }
        return ui.run(label, () => conn.request(kind, tabId, rest), opts);
      },
      query(q, fields = {}) {
        const { tabId = TABLESS.has(q) ? undefined : ctx.anchorTab(), args } = fields;
        if (tabId === null) return Promise.reject(Object.assign(new Error("no open tab"), { code: "no-tab" }));
        return conn.query(q, { ...(tabId ? { tabId } : {}), ...(args ? { args } : {}) });
      },
      openTab(tabId) {
        const state = conn.state();
        if (tabId !== state.activeTabId && !hinted) {
          hinted = true;
          ui.toast({ tone: "info", icon: "desktop", text: M.COPY.tabSwitchHint, duration: 4000 });
        }
        conn.selectTab(tabId);
        ui.navigate("chat", { tabId });
      },
    };
    return ctx;
  }

  root.OMP_REMOTE_CTX = { create, TABLESS };
})(typeof window !== "undefined" ? window : globalThis);
