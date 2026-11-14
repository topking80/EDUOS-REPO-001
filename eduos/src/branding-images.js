// EduOS 32.3.0: mascot image processing.
//  - The type comes from the file's magic bytes, never from the client's
//    Content-Type or file name. Only PNG, JPEG, WebP and SVG are accepted.
//  - Raster images are DECODED and RE-ENCODED (sharp/libvips): nothing of the
//    original byte stream is kept. EXIF/XMP/ICC metadata is dropped (sharp
//    writes none unless asked), EXIF orientation is applied first, animation is
//    flattened to the first frame, and decoding is bounded by a pixel limit and
//    a timeout.
//  - SVG goes through the strict allowlist sanitizer (svg-sanitize.js); the
//    sanitized SVG is stored and rasterized from that, never from the upload.
//  - Square crops are generated at ICON_SIZES as PNG. Browsers only ever get
//    those PNGs (and, for editors, the sanitized SVG served with a CSP that
//    forbids scripts).
import sharp from "sharp";
import { sanitizeSvg, SvgRejected, MAX_BYTES as SVG_MAX_BYTES } from "./svg-sanitize.js";
import { autoText } from "./contrast.js";

sharp.cache(false);       // modest memory: no libvips operation cache
sharp.concurrency(1);     // one thread per operation; requests are already parallel

export const ICON_SIZES = [512, 192, 180, 96, 48, 32];
export const MIN_PIXELS = 64, MAX_DIMENSION = 4096;
const LIMIT_INPUT_PIXELS = MAX_DIMENSION * MAX_DIMENSION;

export class ImageRejected extends Error {
  constructor(reason) { super(`image_rejected: ${reason}`); this.reason = reason; this.code = "image_rejected"; }
}

export function detectType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  const head = buf.subarray(0, 1024).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  // Markup that mentions <svg early is handed to the strict sanitizer, which
  // refuses DOCTYPE/ENTITY/CDATA and anything whose root is not <svg>.
  if (head.startsWith("<") && /<svg[\s>\/]/i.test(head)) return "svg";
  return null;
}

async function crops(pipelineFactory, fit) {
  const out = [];
  for (const size of ICON_SIZES) {
    const data = await pipelineFactory()
      .resize(size, size, { fit, position: "centre", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    out.push({ variant: `png_${size}`, mime: "image/png", width: size, height: size, bytes: data });
  }
  return out;
}

/**
 * Validate and process an upload. Returns { type, variants: [{variant, mime,
 * width, height, bytes}], removed } where removed lists sanitizer removals.
 */
export async function processMascot(buf, { maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new ImageRejected("empty");
  if (buf.length > maxBytes) throw new ImageRejected("too_large");
  const type = detectType(buf);
  if (!type) throw new ImageRejected("unsupported_type");
  if (type === "svg") {
    if (buf.length > SVG_MAX_BYTES) throw new ImageRejected("too_large");
    let clean;
    try { clean = sanitizeSvg(buf.toString("utf8")); } catch (e) { if (e instanceof SvgRejected) throw new ImageRejected(e.reason); throw e; }
    const svgBuf = Buffer.from(clean.svg, "utf8");
    const open = () => sharp(svgBuf, { density: 144, limitInputPixels: LIMIT_INPUT_PIXELS, failOn: "error" }).timeout({ seconds: 10 });
    let meta;
    try { meta = await open().metadata(); } catch { throw new ImageRejected("undecodable"); }
    if (!meta.width || !meta.height) throw new ImageRejected("undecodable");
    const variants = await crops(open, "contain");
    variants.unshift({ variant: "svg", mime: "image/svg+xml", width: meta.width, height: meta.height, bytes: svgBuf });
    return { type, variants, removed: clean.removed };
  }
  const open = () => sharp(buf, { limitInputPixels: LIMIT_INPUT_PIXELS, failOn: "error", animated: false, pages: 1 }).timeout({ seconds: 10 }).rotate();
  let meta;
  try { meta = await sharp(buf, { limitInputPixels: LIMIT_INPUT_PIXELS, failOn: "error", animated: false }).metadata(); }
  catch (e) { throw new ImageRejected(/pixel limit/i.test(e.message) ? "too_many_pixels" : "undecodable"); }
  if (meta.format !== type && !(type === "jpeg" && meta.format === "jpeg")) throw new ImageRejected("type_mismatch");
  if (!meta.width || !meta.height || meta.width < MIN_PIXELS || meta.height < MIN_PIXELS) throw new ImageRejected("too_small");
  if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) throw new ImageRejected("too_many_pixels");
  try { return { type, variants: await crops(open, "cover"), removed: [] }; }
  catch { throw new ImageRejected("undecodable"); }
}

/** The fallback school icon (no mascot uploaded): a star on the primary colour. No text, so no fonts are needed. */
export function defaultIconSvg(primary = "#1f4e79") {
  const fg = autoText(primary);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${primary}"/>` +
    `<path fill="${fg}" d="M32 11l6.2 13.3 14.6 1.6-10.9 9.9 3 14.4L32 42.9l-12.9 7.3 3-14.4-10.9-9.9 14.6-1.6z"/></svg>`;
}
export async function renderPng(svgText, size) {
  return sharp(Buffer.from(svgText), { density: 144, failOn: "error" }).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}
