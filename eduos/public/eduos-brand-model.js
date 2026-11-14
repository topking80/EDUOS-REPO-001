// EduOS 32.3.0: school branding model shared by the browser (designer, live
// preview, applying a published theme) and the API (validation, publish gate).
// Classic script: sets globalThis.EduOSBrandModel (needs EduOSContrast first).
(function (root) {
  "use strict";
  const C = root.EduOSContrast;
  const HEX = /^#[0-9a-f]{6}$/;
  const FONTS = Object.freeze({
    system: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    rounded: 'ui-rounded,"Arial Rounded MT Bold","Nunito",system-ui,sans-serif',
    serif: 'Georgia,"Times New Roman",serif',
    slab: 'Rockwell,"Roboto Slab","Courier New",serif',
    readable: 'Verdana,Tahoma,"Atkinson Hyperlegible",sans-serif'
  });
  const FONT_NAMES = Object.freeze({ system: "System (default)", rounded: "Rounded", serif: "Serif", slab: "Slab", readable: "Extra readable (Verdana)" });
  const SHAPES = ["rounded", "circle", "square"];
  const GLYPH_MODES = ["mono", "color"];
  const SURFACE = "#ffffff";
  const GLYPHS = Object.freeze({
    pencil: "M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
    book: "M6.5 2H19v18H6.5A2.5 2.5 0 0 1 4 17.5v-13A2.5 2.5 0 0 1 6.5 2zm0 14a1.5 1.5 0 0 0 0 3H17v-3z",
    calculator: "M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm1 3v4h10V5zm0 7v2h2v-2zm4 0v2h2v-2zm4 0v6h2v-6zm-8 4v2h2v-2zm4 0v2h2v-2z",
    flask: "M9 2h6v2h-1v5.2l5.6 9.6A2 2 0 0 1 17.9 22H6.1a2 2 0 0 1-1.7-3.2L10 9.2V4H9z",
    globe: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 9h-3a15 15 0 0 0-1.4-6 8 8 0 0 1 4.4 6zM12 4.1a13 13 0 0 1 1.9 6.9h-3.8A13 13 0 0 1 12 4.1zM9.5 5a15 15 0 0 0-1.4 6h-3a8 8 0 0 1 4.4-6zm-4.4 8h3a15 15 0 0 0 1.4 6 8 8 0 0 1-4.4-6zm6.9 6.9a13 13 0 0 1-1.9-6.9h3.8a13 13 0 0 1-1.9 6.9zm2.5-.9a15 15 0 0 0 1.4-6h3a8 8 0 0 1-4.4 6z",
    calendar: "M7 2h2v2h6V2h2v2h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2zM5 9v11h14V9zm2 2h4v4H7z",
    music: "M9 3l12-2v14.5a3.5 3.5 0 1 1-2-3.2V5.4l-8 1.3v10.8a3.5 3.5 0 1 1-2-3.2z",
    star: "M12 2l3 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2l-6.2 3.4 1.4-6.8L2.1 9.1 9 8.3z",
    chat: "M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"
  });
  const GLYPH_NAMES = Object.keys(GLYPHS);
  // Built-in tiles (not apps). App tiles use the key "app:<uuid>".
  const BUILTIN_TILES = Object.freeze({
    work: { label: "My work", glyph: "pencil" },
    attendance: { label: "Attendance", glyph: "calendar" },
    apps: { label: "All apps", glyph: "globe" }
  });
  const CATEGORY_GLYPH = { reading: "book", math: "calculator", science: "flask", "social studies": "globe", music: "music", art: "star" };
  const SYSTEM_DEFAULT = Object.freeze({
    mascotName: null, motto: null, primary: "#1f4e79", secondary: "#2f6f73", accent: "#f2b134", font: "system", mascotUploadId: null,
    tiles: Object.freeze({ preset: "minimal", base: Object.freeze({ shape: "rounded", bg: "surface", glyphMode: "mono", glyphColor: "primary", labelColor: "auto", badge: false }), overrides: Object.freeze({}) })
  });
  const PRESETS = Object.freeze({
    mascot_classic: { name: "Mascot classic", base: { shape: "rounded", bg: "primary", glyphMode: "mono", glyphColor: "auto", labelColor: "auto", badge: true } },
    bold: { name: "Bold colors", base: { shape: "square", bg: "cycle", glyphMode: "color", glyphColor: "auto", labelColor: "auto", badge: false } },
    minimal: { name: "Minimal", base: { shape: "rounded", bg: "surface", glyphMode: "mono", glyphColor: "primary", labelColor: "auto", badge: false } }
  });
  const COLOR_REFS = ["primary", "secondary", "accent", "surface", "ink", "auto"];
  const isColorRef = (v, { allowAuto = false, allowCycle = false } = {}) =>
    (typeof v === "string" && (HEX.test(v) || (COLOR_REFS.includes(v) && (v !== "auto" || allowAuto)) || (allowCycle && v === "cycle")));

  /** Validate a stored tile design; returns an error string or null. */
  function validateTiles(t) {
    if (!t || typeof t !== "object" || Array.isArray(t)) return "tiles_must_be_object";
    if (!["mascot_classic", "bold", "minimal", "custom"].includes(t.preset)) return "invalid_preset";
    const checkStyle = (s, isOverride) => {
      if (!s || typeof s !== "object" || Array.isArray(s)) return "invalid_tile_style";
      for (const k of Object.keys(s)) if (!["shape", "bg", "glyphMode", "glyphColor", "labelColor", "badge", "glyph", "label", "hidden"].includes(k)) return `unknown_tile_field_${k}`;
      if (s.shape !== undefined && !SHAPES.includes(s.shape)) return "invalid_shape";
      if (s.bg !== undefined && !isColorRef(s.bg, { allowCycle: true })) return "invalid_tile_bg";
      if (s.glyphMode !== undefined && !GLYPH_MODES.includes(s.glyphMode)) return "invalid_glyph_mode";
      if (s.glyphColor !== undefined && !isColorRef(s.glyphColor, { allowAuto: true })) return "invalid_glyph_color";
      if (s.labelColor !== undefined && !isColorRef(s.labelColor, { allowAuto: true })) return "invalid_label_color";
      if (s.badge !== undefined && typeof s.badge !== "boolean") return "invalid_badge";
      if (s.hidden !== undefined && typeof s.hidden !== "boolean") return "invalid_hidden";
      if (s.glyph !== undefined && !GLYPH_NAMES.includes(s.glyph)) return "invalid_glyph";
      if (s.label !== undefined && (typeof s.label !== "string" || s.label.trim().length < 1 || s.label.length > 40 || /[<>]/.test(s.label))) return "invalid_label";
      if (!isOverride && (s.label !== undefined || s.glyph !== undefined)) return "label_only_on_tiles";
      return null;
    };
    const e = checkStyle(t.base || {}, false); if (e) return e;
    const o = t.overrides || {};
    if (typeof o !== "object" || Array.isArray(o)) return "invalid_overrides";
    const keys = Object.keys(o);
    if (keys.length > 200) return "too_many_tiles";
    for (const k of keys) {
      if (!(k in BUILTIN_TILES) && !/^app:[0-9a-f-]{36}$/.test(k)) return "invalid_tile_key";
      const e2 = checkStyle(o[k], true); if (e2) return e2;
    }
    return null;
  }
  const pick = (v, d) => (v === undefined || v === null ? d : v);
  /** Effective branding: school published -> district published -> system default. Profiles use API field names. */
  function effective(...layers) {
    const out = { ...SYSTEM_DEFAULT, tiles: SYSTEM_DEFAULT.tiles };
    for (const p of layers.reverse()) { // last argument = lowest priority
      if (!p) continue;
      for (const k of ["mascotName", "motto", "primary", "secondary", "accent", "font", "mascotUploadId"]) out[k] = pick(p[k], out[k]);
      if (p.tiles && p.tiles.preset) out.tiles = p.tiles;
    }
    return out;
  }
  function resolveColor(ref, b, fallback) {
    if (!ref || ref === "auto") return fallback;
    if (HEX.test(ref)) return ref;
    return { primary: b.primary, secondary: b.secondary, accent: b.accent, surface: SURFACE, ink: C.INK }[ref] || fallback;
  }
  /** Resolve a tile's concrete colours/shape. index drives the "cycle" background. */
  function tileStyle(b, key, index = 0, meta = {}) {
    const base = (b.tiles && b.tiles.base) || SYSTEM_DEFAULT.tiles.base;
    const ov = (b.tiles && b.tiles.overrides && b.tiles.overrides[key]) || {};
    const s = { ...SYSTEM_DEFAULT.tiles.base, ...base, ...ov };
    const cycle = [b.primary, b.secondary, b.accent];
    const bg = s.bg === "cycle" ? cycle[index % 3] : resolveColor(s.bg, b, b.primary);
    const label = C.HEX.test(bg) ? resolveColor(s.labelColor, b, C.autoText(bg)) : C.INK;
    const disc = s.glyphMode === "color" ? (bg === b.accent ? b.secondary : b.accent) : null;
    const glyphFg = s.glyphMode === "color" ? C.autoText(disc) : resolveColor(s.glyphColor, b, C.autoText(bg));
    const builtin = BUILTIN_TILES[key];
    const glyph = ov.glyph || (builtin && builtin.glyph) || CATEGORY_GLYPH[String(meta.category || "").toLowerCase()] || "star";
    return { key, bg, label, labelText: ov.label || meta.name || (builtin && builtin.label) || key, shape: s.shape, glyph, glyphMode: s.glyphMode,
      glyphFg, disc, badge: Boolean(s.badge) && Boolean(b.mascotUploadId), hidden: Boolean(ov.hidden), border: bg.toLowerCase() === SURFACE };
  }
  /**
   * Every text/icon-on-background pair that the published theme can show, for
   * the given tiles (built-ins plus sample/real apps). Text pairs must reach
   * 4.5:1 (errors block publishing); icon pairs should reach 3:1 (warnings).
   */
  function contrastPairs(b, tiles) {
    const pairs = [
      { id: "header:text", label: "Header text on the primary colour", fg: C.autoText(b.primary), bg: b.primary, kind: "text" },
      { id: "banner:text", label: "Home banner text on the secondary colour", fg: C.autoText(b.secondary), bg: b.secondary, kind: "text" },
      { id: "accent:text", label: "Text on accent highlights", fg: C.autoText(b.accent), bg: b.accent, kind: "text" }
    ];
    tiles.forEach((t, i) => {
      const s = tileStyle(b, t.key, i, t);
      if (s.hidden) return;
      const name = s.labelText;
      pairs.push({ id: `tile:${t.key}:label`, tile: t.key, field: "labelColor", label: `"${name}" tile label`, fg: s.label, bg: s.bg, kind: "text" });
      if (s.glyphMode === "color") pairs.push({ id: `tile:${t.key}:glyph`, tile: t.key, field: "bg", label: `"${name}" icon circle against the tile`, fg: s.disc, bg: s.bg, kind: "non-text" });
      else pairs.push({ id: `tile:${t.key}:glyph`, tile: t.key, field: "glyphColor", label: `"${name}" icon`, fg: s.glyphFg, bg: s.bg, kind: "non-text" });
      if (s.border) pairs.push({ id: `tile:${t.key}:edge`, tile: t.key, field: "bg", label: `"${name}" tile edge`, fg: "#5a6f86", bg: s.bg, kind: "non-text" });
    });
    return C.check(pairs);
  }
  function summarize(report) {
    const errors = report.filter(r => r.level === "error"), warnings = report.filter(r => r.level === "warning");
    return { ok: errors.length === 0, errors: errors.length, warnings: warnings.length };
  }
  /** Tile sample used for checks/previews when no real apps are known. */
  const SAMPLE_TILES = Object.freeze([
    { key: "work", name: "My work" }, { key: "attendance", name: "Attendance" }, { key: "apps", name: "All apps" },
    { key: "app:00000000-0000-4000-8000-00000000a001", name: "Reading", category: "Reading" },
    { key: "app:00000000-0000-4000-8000-00000000a002", name: "Math", category: "Math" },
    { key: "app:00000000-0000-4000-8000-00000000a003", name: "Science", category: "Science" }
  ]);
  function presetTiles(name, current) {
    const p = PRESETS[name];
    return { preset: name, base: { ...p.base }, overrides: (current && current.overrides) ? JSON.parse(JSON.stringify(current.overrides)) : {} };
  }
  function glyphSvg(name, fg, size = 24) {
    return `<svg aria-hidden="true" focusable="false" width="${size}" height="${size}" viewBox="0 0 24 24"><path fill="${fg}" fill-rule="evenodd" d="${GLYPHS[name] || GLYPHS.star}"/></svg>`;
  }
  root.EduOSBrandModel = Object.freeze({ HEX, FONTS, FONT_NAMES, SHAPES, GLYPH_MODES, GLYPHS, GLYPH_NAMES, BUILTIN_TILES, SYSTEM_DEFAULT, PRESETS, SURFACE,
    SAMPLE_TILES, validateTiles, effective, resolveColor, tileStyle, contrastPairs, summarize, presetTiles, glyphSvg, isColorRef });
})(typeof window !== "undefined" ? window : globalThis);
