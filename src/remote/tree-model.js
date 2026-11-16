// Pure logic behind the Conversation tree screen (Tree.dc.html): turns the
// desktop's cache-aware tree model (app/conversation-tree.js buildModel, which
// phone page loads from /conversation-tree-graph.js + /conversation-tree.js) into
// what the phone draws — rows, branch tabs, lane geometry, the cache badge per
// prompt, the detail panel's lines and the Branch lock. No DOM or clock of its
// own (`now` is a parameter). `buildModel` is injected so tests can pass the
// real one or a stub.
// Exposes window.OMP_REMOTE_TREE.
(function (root) {
  const LANE_COLORS = ["accent", "lilac", "cyan", "amber", "lime", "rose"];
  const laneColor = lane => `var(--${LANE_COLORS[lane % LANE_COLORS.length]})`;
  // Node markers: the current lane a filled circle, the next a ring, then diamonds.
  const laneShape = lane => (lane === 0 ? "dot" : lane % 2 === 1 ? "ring" : "diamond");

  const ROW_W = 46, ROW_H = 62, MID = 31, X0 = 12;
  // x of a lane's line: lanes spread over the 46 px gutter (22 px apart, tighter past three).
  function laneX(lane, lanes) {
    const step = lanes > 1 ? Math.min(22, (ROW_W - 2 * X0) / (lanes - 1)) : 0;
    return X0 + step * lane;
  }

  // Line geometry of one row's graph cell: [{ d, color, state, width? }]. Segments are
  // the vertical lines through or to the node; a curve leaves the node and ends on the
  // child's lane at the bottom edge.
  function geometry(graph, lanes) {
    const paths = [];
    for (const seg of graph?.segments ?? []) {
      const x = laneX(seg.lane, lanes);
      const [y0, y1] = seg.part === "top" ? [0, MID] : seg.part === "bottom" ? [MID, ROW_H] : [0, ROW_H];
      paths.push({ d: `M${x} ${y0}V${y1}`, color: laneColor(seg.lane), state: seg.state });
    }
    for (const curve of graph?.curves ?? []) {
      const a = laneX(curve.fromLane, lanes), b = laneX(curve.toLane, lanes);
      paths.push({ d: `M${a} 40C${a} 52 ${b} 50 ${b} ${ROW_H}`, color: laneColor(curve.toLane), state: curve.state, curve: true });
    }
    return paths;
  }

  const minutes = (until, now) => Math.max(1, Math.ceil((until - now) / 60000));
  const CHIP = {
    warm: { glyph: "●", word: "warm" },
    expiring: { glyph: "⏱", word: "expiring" },
    partial: { glyph: "◐", word: "partial" },
    cold: { glyph: "❄", word: "cold" },
    unknown: { glyph: "?", word: "unknown" },
  };
  // The cache badge of a prompt row: { state, glyph, text } — "warm · 22 min", "expiring · 6 min".
  function cacheChip(state, until, now) {
    const entry = CHIP[state] ?? CHIP.unknown;
    const timed = (state === "warm" || state === "expiring") && until != null && until > now;
    return { state: CHIP[state] ? state : "unknown", glyph: entry.glyph, text: timed ? `${entry.word} · ${minutes(until, now)} min` : entry.word };
  }

  function money(value) {
    if (value == null || !Number.isFinite(value)) return null;
    return value < 0.005 ? "<$0.01" : `$${value.toFixed(2)}`;
  }
  const approx = value => { const text = money(value); return text === null ? null : text.startsWith("<") ? text : `~${text}`; };
  const oneLine = text => String(text ?? "").replace(/\s+/g, " ").trim();

  // The detail panel's facts for a prompt row.
  function detail(row, now) {
    if (row.kind !== "prompt") return null;
    const left = row.until != null && row.until > now ? minutes(row.until, now) : null;
    let cache;
    switch (row.state) {
      case "warm": cache = left ? `Cache warm for ${left} more min` : "Cache warm"; break;
      case "expiring": cache = left ? `Cache expiring in ${left} min` : "Cache expiring"; break;
      case "partial": cache = row.anchorOrdinal ? `Cache warm up to prompt #${row.anchorOrdinal}` : "Cache partly warm"; break;
      case "cold": cache = "Cache cold"; break;
      default: cache = "Cache state unknown";
    }
    const cold = row.state === "cold" || row.coldPrice == null || row.price == null || row.coldPrice <= row.price;
    return { cache, now: approx(row.price), cold: cold ? null : approx(row.coldPrice), coldOnly: row.state === "cold" };
  }

  // FNV-1a over UTF-16 units, 64 bits as two halves: the same opaque id the desktop
  // gives a saved session (app/remote-ops.js opaqueId), so a tree file's path names
  // its `resumeSession` id.
  function opaqueId(path) {
    let h1 = 0x811c9dc5, h2 = 0x050c5d1f;
    for (let i = 0; i < path.length; i++) {
      const c = path.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x01000193 ^ 0x5bd1e995) >>> 0;
    }
    return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }

  // The display model of a `conversationTree` result. Returns null for an unusable tree.
  function prepare(tree, { now, buildModel, hhmm = () => "" }) {
    if (!tree || !Array.isArray(tree.entries) || !Array.isArray(tree.files)) return null;
    const model = buildModel(tree, { now, since: null });
    const lanes = Math.max(1, model.lanes ?? 1);
    const rows = model.rows.map(r => {
      if (r.kind === "compaction") return { kind: "compaction", id: r.id, label: `Compacted${r.ts != null ? ` · ${hhmm(r.ts)}` : ""}` };
      const currentTip = r.tipIndexes.some(i => model.tips[i]?.isCurrent);
      const otherTip = !currentTip && r.tipIndexes.length > 0;
      return {
        kind: "prompt", id: r.id, ordinal: r.ordinal, text: oneLine(r.text) || "(no text)", fullText: String(r.text ?? ""),
        ts: r.ts, lane: r.graph?.lane ?? 0, geometry: geometry(r.graph, lanes), shape: laneShape(r.graph?.lane ?? 0),
        chip: cacheChip(r.state, r.until, now), price: approx(r.price),
        state: r.state, until: r.until, anchorOrdinal: r.anchorOrdinal, rawPrice: r.price, coldPrice: r.coldPrice,
        currentTip, branchHead: otherTip, onCurrentPath: Boolean(r.onCurrentPath),
        openFile: r.openFile ?? null, sessionId: r.openFile ? opaqueId(r.openFile) : null,
        isAnchor: Boolean(r.isAnchor), label: r.label ?? null,
      };
    });
    const laneOf = new Map(rows.map(r => [r.id, r.lane]));
    const counts = new Map();
    for (const r of rows) if (r.kind === "prompt") counts.set(r.lane, (counts.get(r.lane) ?? 0) + 1);
    const tips = model.tips.map((t, i) => ({ ...t, i }));
    const ordered = [...tips.filter(t => t.isCurrent), ...tips.filter(t => !t.isCurrent)];
    let n = 0;
    const branches = ordered.map(t => {
      const lane = laneOf.get(t.rowId) ?? 0;
      return {
        id: t.leafId, rowId: t.rowId, current: t.isCurrent, lane,
        label: t.isCurrent ? "Current" : oneLine(t.title) || `Branch ${++n}`,
        count: t.isCurrent ? 0 : counts.get(lane) ?? 0,
      };
    });
    return {
      rows, lanes, branches, counts: model.counts, prompts: model.counts.total,
      branchCount: tips.length, ttlMs: model.ttlMs,
    };
  }

  // `selected` row fields that the Branch button needs.
  // Returns null when branching is allowed, else { text } to show in the dashed box.
  function branchLock({ scope, legacy, busy, can }) {
    if (can) return busy ? { text: "Branching is available when the agent is idle." } : null;
    if (scope === "view" && !legacy) return { text: "View only. Branching needs Manage scope, set on the desktop." };
    if (legacy) return { text: "This desktop is too old for branching. Update OMP Desktop." };
    return { text: "This phone has Control. Branching needs Manage — change it on the desktop." };
  }

  const subtitle = (title, prompts, branches) =>
    [title, `${prompts} ${prompts === 1 ? "prompt" : "prompts"}`, `${branches} ${branches === 1 ? "branch" : "branches"}`].filter(Boolean).join(" · ");

  root.OMP_REMOTE_TREE = { LANE_COLORS, laneColor, laneShape, laneX, geometry, cacheChip, detail, opaqueId, prepare, branchLock, subtitle, money, ROW_W, ROW_H, MID };
  if (typeof module !== "undefined" && module.exports) module.exports = root.OMP_REMOTE_TREE;
})(typeof window !== "undefined" ? window : globalThis);
