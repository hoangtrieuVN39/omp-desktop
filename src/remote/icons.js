// Phone icon set: the designer's 24 px outline icons (Icons.dc.html), drawn as
// inline SVG with createElementNS so the page needs no icon font, sprite file
// or CDN and the strict CSP stays intact. Colour comes from currentColor and
// the `.ic` class (remote tokens.css).
// Exposes window.OMP_REMOTE_ICONS = { PATHS, svg(name, { size, label }) }.
(function (root) {
  const C = "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0";
  const PATHS = {
    "nav-sessions": "M5.5 4h13a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 8.5v-3A1.5 1.5 0 0 1 5.5 4zM5.5 14h13a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-3A1.5 1.5 0 0 1 5.5 14z",
    "nav-chat": "M4 5h16v11H9l-5 4z",
    "nav-review": "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM12 10v6M9 13h6",
    "nav-agents": "M9.5 5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M2.5 19a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M16.5 19a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M12 7.5v4M12 11.5 5.8 16.8M12 11.5l6.2 5.3",
    plus: "M12 5v14M5 12h14",
    search: "M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0M20 20l-3.5-3.5",
    more: "M3.8 12a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0M10.8 12a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0M17.8 12a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0",
    close: "M6 6l12 12M18 6 6 18",
    back: "m15 6-6 6 6 6",
    "chevron-right": "m9 6 6 6-6 6",
    "chevron-down": "m6 9 6 6 6-6",
    "chevron-up": "m6 15 6-6 6 6",
    send: "M12 19V5M5 12l7-7 7 7",
    steer: "M5 12h12M13 6l6 6-6 6",
    stop: "M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
    image: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM7 10a2 2 0 1 0 4 0a2 2 0 1 0-4 0M21 16l-5-5-9 9",
    slash: "M15 4 9 20",
    mention: "M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1",
    "st-running": "M12 3a9 9 0 1 1-9 9",
    "st-waiting": `${C}M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14M12 17v.5`,
    "st-error": `${C}M12 7v6M12 16.5v.5`,
    "st-done": `${C}M8 12l3 3 5-6`,
    "st-idle": `${C}M8.5 12h7`,
    check: "m5 12 5 5 9-10",
    lock: "M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V8a4 4 0 0 1 8 0v3",
    "view-only": "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
    desktop: "M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 20h8M12 16v4",
    offline: "M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4-2.5M19 13a10 10 0 0 0-2-1.6M12 20h.01",
    branch: "M4 5a2 2 0 1 0 4 0a2 2 0 1 0-4 0M4 19a2 2 0 1 0 4 0a2 2 0 1 0-4 0M16 8a2 2 0 1 0 4 0a2 2 0 1 0-4 0M6 7v10M18 10c0 4-6 3-12 7",
    fork: "M10 19a2 2 0 1 0 4 0a2 2 0 1 0-4 0M4 5a2 2 0 1 0 4 0a2 2 0 1 0-4 0M16 5a2 2 0 1 0 4 0a2 2 0 1 0-4 0M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5",
    "tool-bash": "m5 8 4 4-4 4M12 17h7",
    "tool-file": "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6",
    folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    plan: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12h2M4 18h2",
    copy: "M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2",
    discard: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
    wrap: "M4 6h16M4 12h13a3 3 0 0 1 0 6h-4M4 18h5M15 16l-2 2 2 2",
    refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
    export: "M12 4v11M7 10l5 5 5-5M5 20h14",
    compact: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
    rename: "M4 20h4L19 9l-4-4L4 16z",
    profile: "M5.5 8a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M3 20a6 6 0 0 1 12 0M17 7l3 3-3 3M20 10h-5",
    qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2",
    bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
    warning: "M12 3 2 20h20zM12 10v4M12 17v.5",
    share: "M12 15V3M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6",
    usage: "M5 20V10M12 20V4M19 20v-7",
    shield: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z",
  };
  const SVG_NS = "http://www.w3.org/2000/svg";

  // A new <svg class="ic"> for `name`; unknown names draw nothing (so a typo
  // never throws inside a render). `size` is px, `label` makes it an image.
  function svg(name, { size, label, className } = {}) {
    const el = root.document.createElementNS(SVG_NS, "svg");
    el.setAttribute("viewBox", "0 0 24 24");
    el.setAttribute("class", className ? `ic ${className}` : "ic");
    if (label) { el.setAttribute("role", "img"); el.setAttribute("aria-label", label); }
    else el.setAttribute("aria-hidden", "true");
    if (size) { el.style.width = `${size}px`; el.style.height = `${size}px`; }
    const d = PATHS[name];
    if (d) {
      const path = root.document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      el.append(path);
    }
    return el;
  }

  // Other modules add their own icons (24 px grid, stroke only): register("name", "M…d").
  // Returns false (and keeps the old path) when the name already exists.
  function register(name, d) {
    if (typeof name !== "string" || typeof d !== "string" || Object.hasOwn(PATHS, name)) return false;
    PATHS[name] = d;
    return true;
  }

  const icons = { PATHS, svg, register };
  if (typeof window !== "undefined") window.OMP_REMOTE_ICONS = icons;
  if (typeof module !== "undefined" && module.exports) module.exports = icons;
})(typeof window !== "undefined" ? window : globalThis);
