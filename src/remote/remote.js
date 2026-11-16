// Phone page entry: wires the connection store, the shell and the screen
// registry together. Every screen lives in its own module (they register with
// OMP_REMOTE_UI before this file runs); the transport is connection.js. This
// file only owns what is global to the page: the desktop theme, the visible
// viewport, banners, the nav badge and the pairing gate.
(function () {
  const M = window.OMP_REMOTE_MODEL, ui = window.OMP_REMOTE_UI;
  const THEMES = ["aurora", "daylight", "phosphor"];

  // The desktop's theme: `.t-<id>` (tokens.css) next to the desktop's own
  // `.theme-<id>`, then its accent (accent.js sets the accent tokens inline).
  function applyTheme(theme) {
    const root = document.documentElement;
    const id = THEMES.includes(theme?.id) ? theme.id : "aurora";
    for (const name of THEMES) root.classList.remove(`t-${name}`);
    root.classList.add(`t-${id}`);
    window.OMP_ACCENT?.applyThemeTokens(root, id, theme?.accent);
    const onAccent = M.onAccent(theme?.accent);
    if (onAccent) root.style.setProperty("--on-accent", onAccent); else root.style.removeProperty("--on-accent");
    document.querySelector?.('meta[name="theme-color"]')?.setAttribute("content", M.THEME_COLORS[id]);
  }
  applyTheme(null);

  // iOS keeps the layout viewport tall under the keyboard; follow the visible one.
  if (window.visualViewport) {
    const fit = () => document.documentElement.style.setProperty("--app-h", `${window.visualViewport.height}px`);
    window.visualViewport.addEventListener("resize", fit);
    window.visualViewport.addEventListener("scroll", () => window.scrollTo(0, 0));
    fit();
  }

  const conn = window.OMP_REMOTE_CONNECTION.create({ onTheme: applyTheme });
  const ctx = window.OMP_REMOTE_CTX.create({ conn, ui });
  ui.mount({ app: document.getElementById("app"), ctx });

  let gated = false, launched = false, bannerSig = "";
  function onState(state) {
    // Pairing replaces the whole shell: no token, a revoked token, and the
    // "paired" confirmation until the person continues.
    const needGate = state.phase === "unpaired" || state.phase === "revoked" || state.pair.justPaired;
    if (needGate !== gated) { gated = needGate; ui.setGate(needGate ? "pairing" : null); }
    const banner = needGate ? null : M.bannerFor(state);
    const sig = banner ? `${banner.id}:${banner.text}` : "";
    if (sig !== bannerSig) {
      bannerSig = sig;
      ui.setBanner("connection", banner && { ...banner, action: banner.action && { label: banner.action, onClick: () => conn.retryNow() } });
    }
    ui.setBadge("chat", state.tabs.filter(tab => tab.hasAsk).length);
    // A push tap (`/?tab=<id>`) opens Chat on its tab once; the store selects it.
    if (state.connected && !launched && conn.launchTab) { launched = true; ui.navigate("chat"); }
    ui.update(state);
  }
  conn.subscribe(onState);
  ui.navigate("sessions");
  onState(conn.state());
  conn.start();
})();
