// EduOS 32.3.0 school branding: SVG sanitizer, contrast math, image processing,
// the shared branding model and the migration/permission contracts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { sanitizeSvg, SvgRejected } from "../src/svg-sanitize.js";
import { ratio, luminance, autoText, suggest, check } from "../src/contrast.js";
import { processMascot, detectType, ImageRejected, defaultIconSvg, ICON_SIZES } from "../src/branding-images.js";
import { BrandModel as M } from "../src/brand-model.js";
import { ROLE_PERMISSIONS } from "../src/policy.js";
import { FLOW_EVENT_TYPES } from "../src/flow-events.js";

process.env.DATABASE_URL ||= "postgres://eduos:test@127.0.0.1:1/eduos";
process.env.PUBLIC_ORIGIN ||= "http://localhost:8080";
process.env.OIDC_ISSUER ||= "https://idp.example.test";
process.env.OIDC_CLIENT_ID ||= "eduos-test";
process.env.OIDC_CLIENT_SECRET ||= "test-secret";
process.env.OIDC_REDIRECT_URI ||= "http://localhost:8080/auth/callback";
const { validateDraftInput } = await import("../src/branding-routes.js");
const read = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const FORBIDDEN = /<script|onload|onerror|onclick|onmouse|onbegin|foreignObject|<image|<use|<style|style=|href|javascript|data:|<iframe|<animate|<set|xlink|<a[\s>]|<!ENTITY|evil/i;

test("SVG sanitizer removes scripts, handlers, foreignObject, external refs and unsafe values", () => {
  const samples = [
    `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="5"/></svg>`,
    `<svg><script type="text/javascript">alert(document.cookie)</script><rect width="1" height="1"/></svg>`,
    `<svg><SCRIPT>alert(1)</SCRIPT><rect width="1" height="1"/></svg>`,
    `<svg><foreignObject width="100" height="100"><iframe src="https://evil.example"></iframe></foreignObject></svg>`,
    `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://evil.example/s.svg#x"/><image href="https://evil.example/p.png"/></svg>`,
    `<svg><a href="javascript:alert(1)"><rect width="9" height="9"/></a></svg>`,
    `<svg><rect width="9" height="9" fill="url(https://evil.example/#g)"/><rect width="9" height="9" fill="url(#ok)"/></svg>`,
    `<svg><rect width="9" height="9" style="fill:url(javascript:alert(1))"/></svg>`,
    `<svg><rect width="9" height="9" fill="&#106;&#97;vascript:alert(1)"/></svg>`,
    `<svg><animate attributeName="href" to="javascript:alert(1)"/><set attributeName="onload" to="alert(1)"/></svg>`,
    `<svg><style>@import url(https://evil.example/x.css); rect{fill:red}</style><rect width="1" height="1" class="x"/></svg>`,
    `<svg><circle r="5" onmouseover="alert(1)" ONCLICK="x()" onbegin="y()"/></svg>`,
    `<svg><g transform="translate(1,1)"><path d="M0 0L10 10" stroke="#000"/></g><text x="1" y="9">Go &amp; win &lt;script&gt;</text></svg>`,
    `<svg><rect width="1" height="1" fill="expression(alert(1))"/></svg>`,
    `<svg><handler xmlns:ev="http://www.w3.org/2001/xml-events" ev:event="load">alert(1)</handler></svg>`,
    `<svg><feImage href="https://evil.example/x"/><rect width="1" height="1" filter="url(#f)"/></svg>`
  ];
  for (const s of samples) {
    const { svg } = sanitizeSvg(s);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, s);
    assert.doesNotMatch(svg, FORBIDDEN, s);
  }
  const keep = sanitizeSvg(samples[6]).svg; assert.match(keep, /fill="url\(#ok\)"/);
  const text = sanitizeSvg(samples[12]).svg; assert.match(text, /Go &amp; win &lt;script&gt;/); assert.match(text, /<path d="M0 0L10 10"/);
  assert.ok(sanitizeSvg(samples[1]).removed.includes("<script>"));
});

test("SVG sanitizer refuses DOCTYPE/ENTITY (XXE, billion laughs), CDATA, PIs and malformed or oversized input", () => {
  const bad = {
    '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><svg>&lol2;</svg>': "doctype_entity_or_cdata",
    '<!DOCTYPE svg SYSTEM "file:///etc/passwd"><svg/>': "doctype_entity_or_cdata",
    "<svg><![CDATA[<script>alert(1)</script>]]></svg>": "doctype_entity_or_cdata",
    '<svg><?xml-stylesheet href="evil.css"?></svg>': "processing_instruction",
    "<html><svg/></html>": "root_must_be_svg",
    "<svg><g></svg>": "mismatched_tag",
    "<svg><rect": "malformed_markup",
    "<svg/><svg/>": "content_after_root",
    "<svg><text>&nbsp;</text></svg>": "unknown_entity",
    "just text": "text_outside_root"
  };
  for (const [s, reason] of Object.entries(bad)) assert.throws(() => sanitizeSvg(s), e => e instanceof SvgRejected && e.reason === reason, s);
  assert.throws(() => sanitizeSvg("<svg>" + "<g>".repeat(40) + "</g>".repeat(40) + "</svg>"), e => e.reason === "too_deep");
  assert.throws(() => sanitizeSvg("<svg>" + "<rect/>".repeat(5001) + "</svg>"), e => e.reason === "too_many_elements");
  assert.throws(() => sanitizeSvg("<svg>" + " ".repeat(300 * 1024) + "</svg>"), e => e.reason === "too_large");
});

test("contrast math matches WCAG 2.1 reference values and suggestions pass", () => {
  assert.equal(ratio("#000000", "#ffffff"), 21);
  assert.equal(ratio("#ffffff", "#ffffff"), 1);
  assert.equal(ratio("#767676", "#ffffff"), 4.54); // the classic lightest AA grey on white
  assert.equal(ratio("#777777", "#ffffff"), 4.48);
  assert.equal(ratio("#0000ff", "#ffffff"), 8.59);
  assert.ok(Math.abs(luminance("#ffffff") - 1) < 1e-9 && luminance("#000000") === 0);
  assert.equal(autoText("#ffffff"), "#0f1d2e"); assert.equal(autoText("#123a6b"), "#ffffff");
  for (const [fg, bg] of [["#ffffff", "#f6c445"], ["#f2b134", "#ffffff"], ["#888888", "#777777"], ["#1f4e79", "#123a6b"]]) {
    const s = suggest(fg, bg); assert.ok(s && ratio(s, bg) >= 4.5, `${fg} on ${bg} -> ${s}`);
  }
  const r = check([{ id: "a", fg: "#ffffff", bg: "#f6c445", kind: "text" }, { id: "b", fg: "#ffffff", bg: "#f6c445", kind: "non-text" }, { id: "c", fg: "#000000", bg: "#ffffff", kind: "text" }]);
  assert.deepEqual(r.map(x => x.level), ["error", "warning", "ok"]);
  assert.throws(() => ratio("red", "#ffffff"));
});

test("image processing re-encodes rasters, strips EXIF, applies orientation and crops squares", async () => {
  const jpg = await sharp({ create: { width: 400, height: 200, channels: 3, background: "#ff0000" } }).jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { Artist: "gps-and-name-marker" } } }).toBuffer();
  assert.ok(jpg.includes(Buffer.from("gps-and-name-marker")));
  const out = await processMascot(jpg);
  assert.equal(out.type, "jpeg");
  assert.deepEqual(out.variants.map(v => v.variant), ICON_SIZES.map(s => `png_${s}`));
  for (const v of out.variants) {
    const m = await sharp(v.bytes).metadata();
    assert.equal(m.format, "png"); assert.equal(m.width, m.height); assert.equal(m.exif, undefined); assert.equal(m.orientation, undefined);
    assert.ok(!v.bytes.includes(Buffer.from("gps-and-name-marker")));
  }
  const webp = await sharp({ create: { width: 128, height: 128, channels: 4, background: "#00ff0080" } }).webp().toBuffer();
  assert.equal((await processMascot(webp)).type, "webp");
  const png = await sharp({ create: { width: 100, height: 300, channels: 3, background: "#000" } }).png().toBuffer();
  assert.equal((await processMascot(png)).variants[0].width, 512);
  const svg = await processMascot(Buffer.from(defaultIconSvg("#7a1f2b")));
  assert.equal(svg.type, "svg"); assert.equal(svg.variants[0].variant, "svg"); assert.equal(svg.variants.length, ICON_SIZES.length + 1);
});

test("image processing refuses unsupported, mislabelled, corrupt, tiny, huge and oversized files", async () => {
  const reason = async (buf, opts) => { try { await processMascot(buf, opts); return "accepted"; } catch (e) { assert.ok(e instanceof ImageRejected, e.message); return e.reason; } };
  assert.equal(await reason(Buffer.from("GIF89a" + "\0".repeat(64))), "unsupported_type");
  assert.equal(await reason(Buffer.from("%PDF-1.7\n" + "x".repeat(64))), "unsupported_type");
  assert.equal(await reason(Buffer.alloc(0)), "empty");
  assert.equal(await reason(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 3)])), "undecodable");
  assert.equal(await reason(await sharp({ create: { width: 32, height: 32, channels: 3, background: "#000" } }).png().toBuffer()), "too_small");
  assert.equal(await reason(await sharp({ create: { width: 5000, height: 64, channels: 3, background: "#000" } }).png().toBuffer()), "too_many_pixels");
  assert.equal(await reason(Buffer.alloc(3 * 1024 * 1024, 1)), "too_large");
  assert.equal(await reason(Buffer.from('<svg viewBox="0 0 64 64" width="64" height="64"><script>alert(1)</script><circle cx="32" cy="32" r="30" fill="#123a6b"/></svg>')), "accepted", "sanitized, then rendered");
  assert.equal(await reason(Buffer.from('<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>')), "doctype_entity_or_cdata");
  assert.equal(detectType(Buffer.from("<html><body>hi</body></html>xxxxxxxx")), null);
});

test("branding model: presets, inheritance, tile validation and the publish gate pairs", () => {
  for (const p of Object.keys(M.PRESETS)) assert.equal(M.validateTiles(M.presetTiles(p)), null, p);
  assert.equal(M.validateTiles({ preset: "custom", base: { bg: "javascript:x" }, overrides: {} }), "invalid_tile_bg");
  assert.equal(M.validateTiles({ preset: "custom", base: {}, overrides: { "app:<script>": {} } }), "invalid_tile_key");
  assert.equal(M.validateTiles({ preset: "custom", base: {}, overrides: { work: { label: "<b>x</b>" } } }), "invalid_label");
  assert.equal(M.validateTiles({ preset: "custom", base: { label: "x" }, overrides: {} }), "label_only_on_tiles");
  const eff = M.effective({ primary: "#123a6b", secondary: null }, { primary: "#000000", secondary: "#5b2a86", accent: "#e8a33d" });
  assert.equal(eff.primary, "#123a6b"); assert.equal(eff.secondary, "#5b2a86"); assert.equal(eff.accent, "#e8a33d"); assert.equal(eff.font, "system");
  for (const p of Object.keys(M.PRESETS)) {
    const b = M.effective({ primary: "#123a6b", secondary: "#0f7c80", accent: "#f6c445", tiles: M.presetTiles(p) });
    assert.equal(M.summarize(M.contrastPairs(b, M.SAMPLE_TILES)).ok, true, `${p} passes with auto text colours`);
  }
  const bad = M.effective({ accent: "#f6c445", tiles: { preset: "custom", base: { bg: "accent", labelColor: "#ffffff" }, overrides: {} } });
  const rep = M.contrastPairs(bad, M.SAMPLE_TILES);
  assert.equal(M.summarize(rep).ok, false);
  assert.ok(rep.filter(r => r.level === "error").every(r => r.kind === "text" && r.suggestion));
  assert.equal(validateDraftInput({ primary: null }, { isSchool: true }), null);
  assert.equal(validateDraftInput({ primary: null }, { isSchool: false }), "invalid_primary");
  assert.equal(validateDraftInput({ evil: 1 }, { isSchool: true }), "unknown_field_evil");
  assert.equal(validateDraftInput({ mascotName: "<img onerror=x>" }, { isSchool: true }), "invalid_mascot_name");
});

test("migration 011, grants, permissions and events", () => {
  const sql = read("db/011_school_branding.sql");
  for (const t of ["branding_uploads", "branding_assets", "branding_profiles", "user_preferences"]) assert.match(sql, new RegExp(`'${t}'`));
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE POLICY scope_read ON branding_profiles AS RESTRICTIVE FOR SELECT\s+USING \(eduos_can_edit_branding\(school_id\) OR \(status = 'published'/);
  assert.match(sql, /current_setting\('app.role', true\) = 'principal'\s+AND p_school = nullif\(current_setting\('app.school_id'/);
  assert.match(sql, /branding_one_published ON branding_profiles\(district_id, school_id\) NULLS NOT DISTINCT WHERE status='published'/);
  assert.match(read("src/migrate.js"), /"011_school_branding.sql"/);
  const grants = read("db/runtime_grants.template.sql");
  assert.match(grants, /REVOKE UPDATE, DELETE, TRUNCATE ON branding_uploads, branding_assets FROM eduos_app/);
  assert.deepEqual(ROLE_PERMISSIONS.principal.branding, ["read", "manage"]);
  assert.deepEqual(ROLE_PERMISSIONS.teacher.branding, ["read"]);
  assert.deepEqual(ROLE_PERMISSIONS.pupil.branding, ["read"]);
  assert.ok(FLOW_EVENT_TYPES.includes ? FLOW_EVENT_TYPES.includes("branding.published") : "branding.published" in FLOW_EVENT_TYPES);
  const routes = read("src/branding-routes.js");
  assert.match(routes, /contrast_failed/);
  assert.match(routes, /Content-Security-Policy", "default-src 'none'/);
  assert.match(read("Caddyfile"), /@dynamic path \/api\/\*/, "public branding is under /api and proxied");
});
