// EduOS 32.3.0: WCAG 2.1 contrast math shared by the browser (branding
// designer, live checks) and the API (publish gate). Classic script: it sets
// globalThis.EduOSContrast; src/contrast.js re-exports it for Node.
(function (root) {
  "use strict";
  const HEX = /^#[0-9a-f]{6}$/i;
  const AA_TEXT = 4.5, AA_LARGE_TEXT = 3, AA_NON_TEXT = 3;
  const INK = "#0f1d2e", WHITE = "#ffffff";
  function parseHex(hex) {
    if (typeof hex !== "string" || !HEX.test(hex)) throw new TypeError(`not a #rrggbb colour: ${hex}`);
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  }
  const toHex = rgb => "#" + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  // WCAG 2.x relative luminance (sRGB). 0.03928 is the threshold the spec text uses.
  function luminance(hex) {
    const [r, g, b] = parseHex(hex).map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function ratio(a, b) {
    const la = luminance(a), lb = luminance(b);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  }
  /** Readable text colour on a background: white or dark ink, whichever contrasts more. */
  const autoText = bg => (ratio(WHITE, bg) >= ratio(INK, bg) ? WHITE : INK);
  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function hslToRgb([h, s, l]) {
    if (s === 0) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = t => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }
  /**
   * Nearest passing shade of `fg` against `bg`: keeps hue and saturation and
   * moves lightness the shortest distance (darker or lighter) until the ratio
   * reaches `target`. Returns null if no lightness works (cannot happen for
   * 4.5:1 because black or white always reaches it, but kept for safety).
   */
  function suggest(fg, bg, target = AA_TEXT) {
    if (ratio(fg, bg) >= target) return fg;
    const [h, s, l] = rgbToHsl(parseHex(fg));
    let best = null;
    for (const dir of [-1, 1]) {
      for (let step = 1; step <= 100; step++) {
        const nl = l + dir * step / 100;
        if (nl < 0 || nl > 1) break;
        const cand = toHex(hslToRgb([h, s, nl]));
        if (ratio(cand, bg) >= target) { if (!best || step < best.step) best = { step, hex: cand }; break; }
      }
    }
    return best ? best.hex : null;
  }
  /**
   * Check a list of pairs: [{ id, label, fg, bg, kind: "text" | "large-text" | "non-text" }].
   * Text below 4.5:1 is an error (blocks publishing); large text below 3:1 is an
   * error; non-text (icons, glyphs, badges) below 3:1 is a warning.
   */
  function check(pairs) {
    return pairs.map(p => {
      const need = p.kind === "text" ? AA_TEXT : p.kind === "large-text" ? AA_LARGE_TEXT : AA_NON_TEXT;
      const r = ratio(p.fg, p.bg), pass = r >= need;
      return { ...p, ratio: r, required: need, pass, level: pass ? "ok" : (p.kind === "non-text" ? "warning" : "error"),
        suggestion: pass ? null : suggest(p.fg, p.bg, need) };
    });
  }
  root.EduOSContrast = Object.freeze({ HEX, AA_TEXT, AA_LARGE_TEXT, AA_NON_TEXT, INK, WHITE, parseHex, toHex, luminance, ratio, autoText, suggest, check });
})(typeof window !== "undefined" ? window : globalThis);
