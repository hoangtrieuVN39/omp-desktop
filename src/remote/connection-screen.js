// Connection screen (Connection.dc.html), opened from the Sessions header:
// desktop state, this phone's device and scope, the push switch and links to
// Usage / Approval rules (shown only when another module registered those
// screens). Registered as the pushed screen 'connection'.
(function (root) {
  const TONE_CLASS = { ok: "ok", warn: "warn", error: "error" };

  function factory(ctx) {
    const { M, P, ui, conn } = ctx;
    const { h, icon, button } = P;
    let signature = "";

    const header = P.header({ title: "Connection", back: true, onBack: () => ui.back() });
    const body = h("div", { cls: "r-scroll" });
    const el = h("section", { cls: "r-screen", attrs: { "aria-label": "Connection" } }, header.el, body);

    function statusCard(state) {
      const view = M.connectionView(state);
      const tone = TONE_CLASS[view.tone];
      const tailnet = /\.ts\.net$/.test(root.location.hostname) ? ` Tailscale: ${root.location.hostname}` : "";
      const action = state.phase === "offline" ? button({ label: "Retry now", variant: "secondary", onClick: () => conn.retryNow() })
        : state.phase === "revoked" || state.phase === "unpaired" ? button({ label: "Pair again", variant: "primary", onClick: () => ui.setGate("pairing") }) : null;
      return h("section", { cls: "r-card r-conn-card", attrs: { "aria-label": "Desktop status" } },
        h("div", { cls: "r-conn-top" },
          h("span", { cls: `r-conn-tile r-conn-${tone}` }, icon("desktop")),
          h("div", { cls: "r-conn-name" }, h("div", { cls: "r-conn-host", text: state.host }), h("div", { cls: `r-conn-label r-conn-${tone}`, text: view.label }))),
        h("div", { cls: "r-conn-body", text: `${view.body}${state.phase === "connected" ? tailnet : ""}` }), action);
    }

    function phoneCard(state) {
      const scope = M.SCOPES[state.scope] ?? M.SCOPES.view;
      const pill = h("span", { cls: "r-scope-pill" }, state.scope === "view" && icon("view-only", { size: 16 }), h("span", { text: scope.label }));
      const cells = ["view", "control", "manage"].map(id => {
        const on = id === state.scope;
        return h("div", { cls: `r-scope-cell${on ? " is-current" : ""}`, attrs: { "aria-current": on ? "true" : undefined } },
          h("b", { text: M.SCOPES[id].short }), h("span", { text: M.SCOPES[id].blurb }));
      });
      return h("section", { cls: "r-block" },
        P.sectionTitle("This phone"),
        h("div", { cls: "r-card" },
          P.kvRow("Device", M.deviceLabel(state.device?.name)),
          P.kvRow("Desktop", state.host),
          P.kvRow("Scope", pill, { last: true })),
        h("div", { cls: "r-scope-grid" }, ...cells),
        P.scopeBanner(state.scope),
        h("p", { cls: "r-hint", text: M.COPY.scopeSetOnDesktop }));
    }

    function notificationsBlock(state) {
      const push = state.push.state;
      const title = h("span", { cls: "r-switch-text" },
        h("span", { cls: "r-kv-title", text: "Push notifications" }),
        h("span", { cls: "r-kv-desc", text: "“Question waiting” and “Finished” only — no transcript text" }));
      let content;
      if (push === "needs-install") {
        content = P.callout({ tone: "warn", icon: "share", body: M.COPY.pairSafari });
      } else if (push === "unavailable") {
        content = P.callout({ tone: "info", icon: "bell", body: "This browser can’t show push notifications." });
      } else {
        const toggle = P.switchControl({ label: "Push notifications", checked: push === "on" || push === "pending", onToggle: on => conn.setPush(on) });
        toggle.disable(!state.connected || push === "pending" || (push === "no-key"));
        if (push === "pending") toggle.el.setAttribute("aria-busy", "true");
        content = h("div", { cls: "r-card" }, h("label", { cls: "r-kv r-kv-tall r-kv-last" }, title, toggle.el));
      }
      return h("section", { cls: "r-block" }, P.sectionTitle("Notifications"), content);
    }

    function linksBlock() {
      const rows = [
        ui.hasScreen("usage") && { id: "usage", icon: "usage", label: "Usage", note: "Last 24 hours" },
        ui.hasScreen("approval-rules") && { id: "approval-rules", icon: "shield", label: "Approval rules", note: "Always-allow rules and mode" },
      ].filter(Boolean);
      if (!rows.length) return null;
      return h("section", { cls: "r-block" }, P.sectionTitle("More"),
        h("div", { cls: "r-card" }, ...rows.map((row, index) => h("button", { cls: `r-link-row${index === rows.length - 1 ? " r-kv-last" : ""}`, on: { click: () => ui.navigate(row.id) } },
          icon(row.icon), h("span", { cls: "r-link-text" }, h("span", { text: row.label }), h("span", { cls: "r-kv-desc", text: row.note })), icon("chevron-right", { size: 16 })))));
    }

    function render(state) {
      const sig = JSON.stringify([state.phase, state.tabCount, state.lastSeenAt && M.hhmm(state.lastSeenAt), state.scope, state.push, state.device?.name, state.host, state.connected, ui.hasScreen("usage"), ui.hasScreen("approval-rules")]);
      if (sig === signature) return;
      signature = sig;
      body.replaceChildren(...[statusCard(state), phoneCard(state), notificationsBlock(state), linksBlock()].filter(Boolean));
    }

    return { el, update: render, show() { signature = ""; render(ctx.state()); } };
  }

  root.OMP_REMOTE_UI.registerScreen("connection", factory);
})(typeof window !== "undefined" ? window : globalThis);
