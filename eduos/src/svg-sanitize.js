// EduOS 32.3.0: strict allowlist SVG sanitizer for school mascot uploads.
//
// The input is never passed through. It is tokenized, every element and
// attribute is checked against an allowlist, and a NEW document is serialized
// from what survives. Removed:
//   - any element not in ELEMENTS (script, foreignObject, style, use, image,
//     a, iframe, animate*, set, handler, feImage, ...) together with its subtree
//   - every attribute not in ATTRIBUTES: on* event handlers, style, href,
//     xlink:href, class, any other namespaced attribute
//   - attribute values with url(...) other than a same-document url(#id),
//     javascript:/data:/vbscript: schemes, expression(), @import, backslash
//     escapes, or characters outside a conservative set
// Refused outright: DOCTYPE / ENTITY declarations (XXE, billion laughs),
// CDATA, processing instructions other than a leading <?xml?>, malformed
// markup, more than MAX_ELEMENTS elements or MAX_DEPTH nesting, > MAX_BYTES.
export const MAX_BYTES = 256 * 1024;
const MAX_ELEMENTS = 5000, MAX_DEPTH = 32;

const ELEMENTS = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs",
  "lineargradient", "radialgradient", "stop", "clippath", "title", "desc", "text", "tspan"]);
const CANON = { lineargradient: "linearGradient", radialgradient: "radialGradient", clippath: "clipPath" };
const TEXT_ELEMENTS = new Set(["title", "desc", "text", "tspan"]);
const ATTRIBUTES = new Map(Object.entries({
  id: "id", viewbox: "viewBox", width: "len", height: "len", x: "len", y: "len", x1: "len", x2: "len", y1: "len", y2: "len",
  cx: "len", cy: "len", r: "len", rx: "len", ry: "len", fx: "len", fy: "len", dx: "len", dy: "len", d: "path", points: "points",
  fill: "paint", stroke: "paint", "stop-color": "paint", "fill-opacity": "num", "stroke-opacity": "num", "stop-opacity": "num", opacity: "num",
  "fill-rule": "keyword", "clip-rule": "keyword", "stroke-width": "len", "stroke-linecap": "keyword", "stroke-linejoin": "keyword",
  "stroke-miterlimit": "num", "stroke-dasharray": "points", "stroke-dashoffset": "len", transform: "transform", gradienttransform: "transform",
  gradientunits: "keyword", clippathunits: "keyword", offset: "len", "clip-path": "paint", "font-size": "len", "font-weight": "keyword",
  "text-anchor": "keyword", "dominant-baseline": "keyword", preserveaspectratio: "keyword", version: "num", "letter-spacing": "len"
}));
const CANON_ATTR = { viewbox: "viewBox", gradienttransform: "gradientTransform", gradientunits: "gradientUnits", clippathunits: "clipPathUnits", preserveaspectratio: "preserveAspectRatio" };
const VALUE_RE = {
  id: /^[A-Za-z_][\w.-]{0,63}$/,
  viewBox: /^[\d\s.,eE+-]{1,80}$/,
  len: /^[\d\s.,eE+%-]*(px|pt|em|%)?$/,
  num: /^[\d.eE+-]{1,16}%?$/,
  path: /^[MmLlHhVvCcSsQqTtAaZz\d\s.,eE+-]{0,60000}$/,
  points: /^[\d\s.,eE+-]{0,60000}$/,
  keyword: /^[A-Za-z][A-Za-z\s-]{0,40}$/,
  transform: /^[a-zA-Z\d\s.,()eE+-]{0,400}$/,
  paint: /^(none|currentColor|transparent|#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\([\d\s.,%]{1,40}\)|url\(#[A-Za-z_][\w.-]{0,63}\))$/
};
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export class SvgRejected extends Error {
  constructor(reason) { super(`svg_rejected: ${reason}`); this.reason = reason; this.code = "svg_rejected"; }
}
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,6});/g, (m, e) => {
    if (e[0] === "#") { const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : ""; }
    if (e in NAMED) return NAMED[e];
    throw new SvgRejected("unknown_entity");
  });
}
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function cleanValue(kind, raw) {
  const v = decodeEntities(raw).trim();
  // Belt and braces: no scheme, no CSS escapes, no expression/import anywhere.
  if (/(javascript|vbscript|data)\s*:|expression\s*\(|@import|\\|<|>/i.test(v)) return null;
  if (/url\s*\(/i.test(v) && !/^url\(#[A-Za-z_][\w.-]{0,63}\)$/.test(v)) return null;
  const re = VALUE_RE[kind];
  return re && re.test(v) ? v : null;
}

/**
 * Sanitize SVG text. Returns { svg, removed } where `removed` lists what was
 * dropped (for the uploader's information). Throws SvgRejected on anything
 * that must not be parsed at all.
 */
export function sanitizeSvg(input) {
  if (typeof input !== "string") input = Buffer.isBuffer(input) ? input.toString("utf8") : String(input ?? "");
  if (Buffer.byteLength(input, "utf8") > MAX_BYTES) throw new SvgRejected("too_large");
  let src = input.replace(/^\uFEFF/, "");
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(src)) throw new SvgRejected("doctype_entity_or_cdata");
  src = src.replace(/^\s*<\?xml[^?]*\?>/, "");
  if (/<\?/.test(src)) throw new SvgRejected("processing_instruction");
  src = src.replace(/<!--[\s\S]*?-->/g, "");
  if (/<!--/.test(src)) throw new SvgRejected("unterminated_comment");

  const removed = new Set();
  const out = [];
  const stack = []; // { name, keep }
  let skipDepth = 0, elements = 0, sawRoot = false, rootClosed = false;
  const tagRe = /<\s*(\/)?\s*([A-Za-z][\w:.-]*)((?:\s+[^\s=\/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/)?\s*>/y;
  const attrRe = /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const textChunk = lt === -1 ? src.slice(i) : src.slice(i, lt);
    if (textChunk) {
      if (!skipDepth && stack.length && TEXT_ELEMENTS.has(stack.at(-1).name)) {
        const t = decodeEntities(textChunk);
        if (t.length > 2000) throw new SvgRejected("text_too_long");
        out.push(esc(t));
      } else if (textChunk.trim() && !stack.length) throw new SvgRejected("text_outside_root");
    }
    if (lt === -1) break;
    tagRe.lastIndex = lt;
    const m = tagRe.exec(src);
    if (!m) throw new SvgRejected("malformed_markup");
    i = tagRe.lastIndex;
    const [, closing, rawName, rawAttrs, selfClosing] = m;
    const name = rawName.toLowerCase();
    if (closing) {
      const top = stack.pop();
      if (!top || top.name !== name) throw new SvgRejected("mismatched_tag");
      if (top.skip) { skipDepth--; continue; }
      out.push(`</${CANON[name] || name}>`);
      if (!stack.length) rootClosed = true;
      continue;
    }
    if (rootClosed) throw new SvgRejected("content_after_root");
    if (++elements > MAX_ELEMENTS) throw new SvgRejected("too_many_elements");
    if (stack.length >= MAX_DEPTH) throw new SvgRejected("too_deep");
    if (!sawRoot) { if (name !== "svg") throw new SvgRejected("root_must_be_svg"); sawRoot = true; }
    const allowed = !skipDepth && ELEMENTS.has(name) && !rawName.includes(":");
    if (!allowed) {
      if (!skipDepth) removed.add(`<${rawName}>`);
      if (!selfClosing) { stack.push({ name, skip: true }); skipDepth++; }
      continue;
    }
    const attrs = [];
    if (name === "svg" && !stack.length) attrs.push('xmlns="http://www.w3.org/2000/svg"');
    attrRe.lastIndex = 0;
    let a;
    while ((a = attrRe.exec(rawAttrs || ""))) {
      const an = a[1].toLowerCase(), av = a[2] ?? a[3];
      if (an === "xmlns" || an.startsWith("xmlns:")) continue; // re-added canonically for the root only
      const kind = ATTRIBUTES.get(an);
      if (!kind || av === undefined) { removed.add(an.startsWith("on") ? "event handlers" : `@${an}`); continue; }
      const v = cleanValue(kind, av);
      if (v === null) { removed.add(`@${an} value`); continue; }
      attrs.push(`${CANON_ATTR[an] || an}="${esc(v)}"`);
    }
    out.push(`<${CANON[name] || name}${attrs.length ? " " + attrs.join(" ") : ""}${selfClosing ? "/>" : ">"}`);
    if (!selfClosing) stack.push({ name, skip: false });
    else if (!stack.length) rootClosed = true;
  }
  if (!sawRoot || stack.length) throw new SvgRejected(sawRoot ? "unclosed_tags" : "not_svg");
  return { svg: out.join(""), removed: [...removed] };
}
