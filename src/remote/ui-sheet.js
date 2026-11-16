// Bottom-sheet primitive: backdrop, grip + swipe-down (> 25% of its height or
// a fast flick) to close, close button, Esc, focus moved in and trapped, focus
// returned to the opener, background marked aria-hidden. One sheet at a time:
// opening another replaces the current one. `confirm` is the destructive-action
// sheet every module shares (Cancel + one labelled confirm button).
// Exposes window.OMP_REMOTE_SHEET = { create({ host, background }) } returning
// { open(spec) -> handle, confirm(spec) -> Promise<boolean>, close(handle?), current() }.
//   spec   { label, title, subtitle, body: Node | (handle) => Node,
//            footer: Node | (handle) => Node, full, flush, bare (no title row: the
//            body brings its own), showClose = true,
//            onClose(reason) }
//   handle { el, body, footer, close(reason = "api") }; body/footer are the
//            containers, so a screen can re-render into them while the sheet is open.
(function (root) {
  const P = () => root.OMP_REMOTE_PARTS;
  const FOCUSABLE = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
  const CLOSE_MS = 200;
  const SWIPE_FRACTION = 0.25, SWIPE_VELOCITY = 0.5;

  const asNode = (value, handle) => (typeof value === "function" ? value(handle) : value);

  function create({ host, background = [] }) {
    const { h, icon, iconButton, button } = P();
    let active = null;

    function setBackground(hidden) {
      for (const el of background) {
        if (hidden) el.setAttribute("aria-hidden", "true"); else el.removeAttribute?.("aria-hidden");
      }
    }

    function focusables(sheet) {
      return [...(sheet.querySelectorAll?.(FOCUSABLE) ?? [])].filter(el => !el.hidden && !el.disabled);
    }

    function open(spec) {
      if (active) finish(active, "replaced", true);
      const opener = root.document.activeElement;
      const scrim = h("div", { cls: "r-scrim", attrs: { "aria-hidden": "true" } });
      const body = h("div", { cls: `r-sheet-body${spec.flush ? " r-sheet-flush" : ""}` });
      const footer = h("div", { cls: "r-sheet-foot", hidden: true });
      const close = iconButton({ icon: "close", label: "Close", onClick: () => handle.close("close"), cls: "r-sheet-close" });
      close.hidden = spec.showClose === false;
      const headText = h("div", { cls: "r-sheet-head-text" },
        h("h2", { cls: "r-sheet-title", text: spec.title ?? "" }),
        spec.subtitle && h("div", { cls: "r-sheet-sub", text: spec.subtitle }));
      const grip = h("div", { cls: "r-sheet-handle" }, h("span", { cls: "r-sheet-grip" }));
      const head = spec.bare ? null : h("div", { cls: "r-sheet-head" }, headText, close);
      const el = h("section", { cls: `r-sheet${spec.full ? " r-sheet-full" : ""}`, attrs: { role: "dialog", "aria-modal": "true", "aria-label": spec.label ?? spec.title, tabindex: "-1" } }, grip, head, body, footer);
      const handle = { el, body, footer, spec, opener, scrim, closing: false, close: reason => finish(handle, reason ?? "api", false) };
      if (spec.body) body.append(...[].concat(asNode(spec.body, handle)));
      if (spec.footer) { footer.hidden = false; footer.append(...[].concat(asNode(spec.footer, handle))); }
      scrim.addEventListener("click", () => handle.close("backdrop"));
      bindDrag(handle, spec.bare ? [grip] : [grip, headText]);
      host.append(scrim, el);
      setBackground(true);
      active = handle;
      el.focus();
      return handle;
    }

    // Swipe the grip down: past a quarter of the sheet or a fast flick closes,
    // anything shorter springs back (System.dc.html interaction spec).
    function bindDrag(handle, zones) {
      const { el } = handle;
      let from = null, startTime = 0, dy = 0;
      for (const zone of zones) {
        zone.addEventListener("pointerdown", event => {
          from = event.clientY; startTime = Date.now(); dy = 0;
          zone.setPointerCapture?.(event.pointerId);
          el.style.animation = "none"; el.style.transition = "none";
        });
        zone.addEventListener("pointermove", event => {
          if (from === null) return;
          dy = Math.max(0, event.clientY - from);
          el.style.transform = `translateY(${dy}px)`;
        });
        const end = () => {
          if (from === null) return;
          const speed = dy / Math.max(1, Date.now() - startTime);
          const height = el.offsetHeight || 1;
          from = null;
          el.style.transition = `transform ${CLOSE_MS}ms var(--ease-sheet)`;
          if (dy > height * SWIPE_FRACTION || (dy > 24 && speed > SWIPE_VELOCITY)) handle.close("swipe");
          else el.style.transform = "";
        };
        zone.addEventListener("pointerup", end);
        zone.addEventListener("pointercancel", end);
      }
    }

    function finish(handle, reason, immediate) {
      if (handle.closing) return;
      handle.closing = true;
      if (active === handle) { active = null; setBackground(false); }
      const remove = () => { handle.el.remove?.(); handle.scrim.remove?.(); };
      if (immediate || typeof root.setTimeout !== "function") remove();
      else {
        handle.el.classList.add("is-closing"); handle.scrim.classList.add("is-closing");
        root.setTimeout(remove, CLOSE_MS);
      }
      try { handle.spec.onClose?.(reason); } finally {
        if (!immediate && handle.opener?.focus && !active) handle.opener.focus();
      }
    }

    root.document.addEventListener("keydown", event => {
      if (!active) return;
      if (event.key === "Escape") { event.preventDefault?.(); active.close("escape"); return; }
      if (event.key !== "Tab") return;
      const items = focusables(active.el);
      if (!items.length) { event.preventDefault?.(); active.el.focus(); return; }
      const first = items[0], last = items[items.length - 1], at = root.document.activeElement;
      if (event.shiftKey && (at === first || at === active.el)) { event.preventDefault?.(); last.focus(); }
      else if (!event.shiftKey && at === last) { event.preventDefault?.(); first.focus(); }
    });

    // tone: primary | danger | warn → the confirm button's variant.
    function confirm({ title, body, confirmLabel, cancelLabel = "Cancel", tone = "primary" }) {
      const variant = { primary: "primary", danger: "danger-fill", warn: "warn" }[tone] ?? "primary";
      return new Promise(resolve => {
        let answered = false;
        const answer = (value, handle) => { answered = true; resolve(value); handle.close("confirm"); };
        open({
          label: title, bare: true,
          body: () => h("div", { cls: "r-confirm" }, h("h2", { cls: "r-confirm-title", text: title }), body && h("p", { cls: "r-confirm-body", text: body })),
          footer: handle => [
            button({ label: confirmLabel, variant, size: "lg", cls: "r-btn-block", onClick: () => answer(true, handle) }),
            button({ label: cancelLabel, variant: "secondary", size: "lg", cls: "r-btn-block", onClick: () => answer(false, handle) }),
          ],
          onClose: () => { if (!answered) resolve(false); },
        });
      });
    }

    return { open, confirm, close: handle => (handle ?? active)?.close("api"), current: () => active };
  }

  root.OMP_REMOTE_SHEET = { create };
})(typeof window !== "undefined" ? window : globalThis);
