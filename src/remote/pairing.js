// Pairing screen (Pairing.dc.html): first-run QR scan, every failure state and
// the "paired" confirmation with the notifications opt-in. remote.js shows it
// as the gate while the phone has no (or a revoked) token and until the paired
// confirmation is dismissed. The camera comes from scanner.js; the pairing
// request itself is conn.pair(code).
(function (root) {
  const STEPS = [
    ["On the desktop, open ", "Settings › Remote access › Pair phone", "."],
    ["Scan the QR code. It works once and expires in 5 minutes.", "", ""],
    ["New phones start as ", "View only", ". Change scope on the desktop."],
  ];

  function factory(ctx) {
    const { M, P, conn } = ctx;
    const { h, icon, button } = P;
    let scanState = "idle";
    let signature = "";

    const scanner = root.OMP_REMOTE_SCANNER.createScanner({ onPair: code => conn.pair(code), installed: conn.installed });
    scanner.onChange(next => { scanState = next; render(ctx.state(), true); });
    const frame = h("div", { cls: "r-scan-frame", attrs: { "aria-hidden": "true" } });
    const caption = h("span", { cls: "r-scan-caption", text: "Point at the QR on your desktop" });
    const viewfinder = h("div", { cls: "r-viewfinder", hidden: true }, scanner.video, frame, caption);
    const body = h("div", { cls: "r-pair-body" });
    const foot = h("div", { cls: "r-pair-foot" });
    const el = h("section", { cls: "r-screen r-pair", attrs: { "aria-label": "Pair with your desktop" } },
      h("div", { cls: "r-scroll r-pair-scroll" }, body, viewfinder), foot);

    function step(index, parts) {
      const [before, bold, after] = parts;
      return h("div", { cls: "r-step" }, h("span", { cls: "r-step-n", text: String(index + 1) }),
        h("span", {}, h("span", { text: before }), bold && h("b", { text: bold }), after && h("span", { text: after })));
    }

    function problem(state) {
      if (scanState === "denied") return M.pairError("camera", conn.installed());
      if (scanState === "unavailable") return M.pairError("unavailable", conn.installed());
      if (scanState === "wrong") return M.pairError("wrong", conn.installed());
      return state.pair.error ? M.pairError(state.pair.error, conn.installed()) : null;
    }

    function startScan() { conn.setPairError(null); scanner.start(); }
    function finishPaired() { conn.dismissPaired(); }
    async function notifications() { await conn.setPush(true); finishPaired(); }

    function render(state, force) {
      const done = state.pair.justPaired;
      const err = done ? null : problem(state);
      const scanning = scanState === "scanning" || scanState === "starting";
      const busy = state.pair.busy;
      const canPush = state.push.state === "off";
      const sig = JSON.stringify([done, err?.kind, scanning, busy, canPush, state.connected, state.scope, state.host, conn.installed()]);
      if (sig === signature && !force) return;
      signature = sig;

      const kids = [
        !conn.installed() && P.callout({ tone: "warn", icon: "share", title: "You’re in a browser tab", body: M.COPY.pairSafari }),
        h("div", { cls: "r-pair-hero" },
          h("span", { cls: "r-pair-tile" }, icon("desktop", { size: 28 })),
          h("h1", { cls: "r-pair-title", text: "Pair with your desktop" }),
          h("p", { cls: "r-pair-lead", text: "Control OMP Desktop tabs from this phone over Tailscale." })),
        !done && !scanning && !err && h("div", { cls: "r-steps" }, ...STEPS.map((parts, index) => step(index, parts))),
        err && P.callout({ tone: "error", icon: "st-error", title: err.title, body: err.body }),
        done && P.callout({ tone: "ok", icon: "check", role: "status", title: `Paired with ${state.host}`,
          body: state.connected ? `Scope: ${M.SCOPES[state.scope].label}. ${M.scopeSummary(state.scope)}` : "Connecting…" }),
      ].filter(Boolean);
      body.replaceChildren(...kids);
      body.hidden = false;
      viewfinder.hidden = !scanning;

      let primary, secondary = null;
      if (done) {
        primary = button({ label: canPush ? "Turn on notifications" : "Continue", icon: canPush ? "bell" : undefined, variant: "primary", size: "lg", cls: "r-btn-block", onClick: canPush ? notifications : finishPaired });
        if (canPush) secondary = button({ label: "Not now", variant: "ghost", size: "lg", cls: "r-btn-block", onClick: finishPaired });
      } else if (scanning) {
        primary = button({ label: "Cancel scan", variant: "primary", size: "lg", cls: "r-btn-block", onClick: () => scanner.stop() });
      } else if (busy) {
        primary = button({ label: "Pairing…", icon: "st-running", spin: true, variant: "primary", size: "lg", cls: "r-btn-block", disabled: true });
      } else {
        primary = button({ label: err ? "Scan again" : "Scan QR code", icon: "qr", variant: "primary", size: "lg", cls: "r-btn-block", onClick: startScan });
      }
      foot.replaceChildren(...[primary, secondary].filter(Boolean));
    }

    return { el, update: state => render(state), show() { signature = ""; render(ctx.state(), true); }, hide() { scanner.stop(); } };
  }

  root.OMP_REMOTE_UI.registerScreen("pairing", factory);
})(typeof window !== "undefined" ? window : globalThis);
