// EduOS 32.3.0: school branding and the icon display designer.
//
// A branding profile exists per school, plus a district default (school_id
// NULL) that schools inherit from field by field. Each scope has at most one
// draft and one published profile; publishing archives the previous one, so
// any earlier version can be restored into the draft. People only ever see
// PUBLISHED branding (RLS: drafts are visible to editors only).
//
// Who may edit: superintendent / it_admin for every school and the district
// default; a principal for their own school only. Everyone reads the
// published branding of the school they have selected (and the district
// default). The checks below are repeated in PostgreSQL (db/011).
//
// Publishing is blocked when any text-on-background pair the theme can show
// is below WCAG AA 4.5:1; icon pairs below 3:1 are warnings.
import crypto from "node:crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission, isDistrictRole } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { BrandModel as M } from "./brand-model.js";
import { processMascot, ImageRejected, defaultIconSvg, renderPng, ICON_SIZES } from "./branding-images.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validId = v => typeof v === "string" && UUID_RE.test(v);
const ANON_USER = "00000000-0000-0000-0000-000000000000";
const FIELDS = { mascotName: "mascot_name", motto: "motto", primary: "primary_color", secondary: "secondary_color", accent: "accent_color", font: "font", appAppearance: "app_appearance" };
const send = (res, r) => res.status(r.status).json(r.error ? { error: r.error, ...(r.extra || {}) } : { data: r.data });
const fail = (status, error, extra) => ({ status, error, extra });
const audit = (client, req, action, id, detail, schoolId = null) => client.query(
  `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id,school_id)
   VALUES($1,$2,$3,$4,'branding',$5,'success',$6,$7,$8)`,
  [req.actor.districtId, req.actor.userId, req.actor.role, action, id, detail ? JSON.stringify(detail) : null, req.requestId, schoolId]);

export const assetUrl = (uploadId, variant) => uploadId ? `/api/branding/assets/${uploadId}/${variant}` : null;
const mascotUrls = id => id ? Object.fromEntries(ICON_SIZES.map(s => [s, assetUrl(id, `png_${s}`)])) : null;

export function toApi(r) {
  if (!r) return null;
  return { id: r.id, schoolId: r.school_id, status: r.status, version: r.version, mascotName: r.mascot_name, motto: r.motto,
    primary: r.primary_color, secondary: r.secondary_color, accent: r.accent_color, font: r.font, appAppearance: r.app_appearance, mascotUploadId: r.mascot_upload_id,
    tiles: r.tiles && r.tiles.preset ? r.tiles : null, basedOnVersion: r.based_on_version, updatedAt: r.updated_at,
    publishedAt: r.published_at, publishedByName: r.published_by_name ?? undefined };
}

/** Validate a draft update (partial). Returns an error code or null. */
export function validateDraftInput(body, { isSchool }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "invalid_body";
  for (const k of Object.keys(body)) if (!(k in FIELDS) && k !== "tiles") return `unknown_field_${k}`;
  const nullable = v => v === null && isSchool; // schools may clear a field to inherit the district default
  for (const k of ["primary", "secondary", "accent"]) {
    const v = body[k];
    if (v !== undefined && !nullable(v) && !(typeof v === "string" && /^#[0-9a-f]{6}$/.test(v.toLowerCase()))) return `invalid_${k}`;
  }
  if (body.font !== undefined && body.font !== null && !(body.font in M.FONTS)) return "invalid_font";
  if (body.appAppearance !== undefined && body.appAppearance !== null && !M.APPEARANCES.includes(body.appAppearance)) return "invalid_app_appearance";
  if (body.mascotName !== undefined && body.mascotName !== null && !(typeof body.mascotName === "string" && body.mascotName.trim().length >= 1 && body.mascotName.trim().length <= 60 && !/[<>]/.test(body.mascotName))) return "invalid_mascot_name";
  if (body.motto !== undefined && body.motto !== null && !(typeof body.motto === "string" && body.motto.trim().length >= 1 && body.motto.trim().length <= 120 && !/[<>]/.test(body.motto))) return "invalid_motto";
  if (body.tiles !== undefined && body.tiles !== null) { const e = M.validateTiles(body.tiles); if (e) return e; }
  if (body.tiles === null && !isSchool) return "invalid_tiles";
  return null;
}

async function loadScope(client, scope) {
  if (scope === "district") return { schoolId: null, name: "District default" };
  if (!validId(scope)) return null;
  const s = await client.query("SELECT id,name FROM schools WHERE id=$1", [scope]);
  return s.rowCount ? { schoolId: s.rows[0].id, name: s.rows[0].name } : null;
}
const sameScope = "school_id IS NOT DISTINCT FROM $1";
async function profiles(client, schoolId, statuses) {
  const r = await client.query(`SELECT p.*, u.display_name AS published_by_name FROM branding_profiles p LEFT JOIN users u ON u.id=p.published_by
     WHERE ${sameScope.replace("school_id", "p.school_id")} AND p.status = ANY($2) ORDER BY p.version DESC NULLS FIRST`, [schoolId, statuses]);
  return r.rows;
}
/** Tiles the theme will be checked against: built-ins plus apps available to that school. */
async function tilesFor(client, schoolId) {
  const apps = await client.query(
    `SELECT a.id,a.name,a.category FROM apps a WHERE a.status='active' AND EXISTS (SELECT 1 FROM app_assignments x
       WHERE x.app_id=a.id AND x.revoked_at IS NULL AND (x.scope='district' OR x.school_id=$1)) ORDER BY a.name LIMIT 100`, [schoolId]);
  return [...Object.entries(M.BUILTIN_TILES).map(([key, t]) => ({ key, name: t.label })),
    ...apps.rows.map(a => ({ key: `app:${a.id}`, name: a.name, category: a.category }))];
}
async function inheritedFor(client, schoolId) {
  if (schoolId === null) return M.effective();
  const d = await profiles(client, null, ["published"]);
  return M.effective(toApi(d[0]));
}
function report(effective, tiles) {
  const r = M.contrastPairs(effective, tiles);
  return { summary: M.summarize(r), report: r.filter(x => x.level !== "ok"), checked: r.length };
}
const canEdit = (actor, schoolId) => isDistrictRole(actor.role) || (actor.role === "principal" && schoolId !== null && schoolId === actor.schoolId);

export function registerBrandingRoutes(app, { emitServerFlow }) {
  // ---- what people see: the selected school's published branding ----
  app.get("/api/branding/current", requireSession, async (req, res, next) => {
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const school = req.actor.schoolId ? (await client.query("SELECT id,name FROM schools WHERE id=$1", [req.actor.schoolId])).rows[0] || null : null;
        const district = (await client.query("SELECT name FROM districts WHERE id=$1", [req.actor.districtId])).rows[0];
        const pub = await client.query(`SELECT * FROM branding_profiles WHERE status='published' AND (school_id IS NULL OR school_id=$1)`, [req.actor.schoolId || null]);
        const sp = pub.rows.find(r => r.school_id), dp = pub.rows.find(r => !r.school_id);
        const pref = await client.query("SELECT theme,reduce_motion,text_size FROM user_preferences WHERE user_id=$1 AND district_id=$2", [req.actor.userId, req.actor.districtId]);
        const eff = M.effective(toApi(sp), toApi(dp));
        return { school, districtName: district?.name || null, branding: eff, mascot: mascotUrls(eff.mascotUploadId),
          versions: { school: sp?.version ?? null, district: dp?.version ?? null },
          publicKey: school ? `${req.actor.districtId}.${school.id}` : null, uploadMaxKb: Math.round(config.brandingUploadMaxBytes / 1024),
          preferences: { theme: pref.rows[0]?.theme || "school", reduceMotion: Boolean(pref.rows[0]?.reduce_motion), textSize: pref.rows[0]?.text_size || "standard" } };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: out });
    } catch (e) { next(e); }
  });

  app.put("/api/me/preferences", requireSession, requireCsrf, async (req, res, next) => {
    const { theme, reduceMotion, textSize } = req.body || {};
    if ((theme !== undefined && !["school", "high_contrast"].includes(theme)) || (reduceMotion !== undefined && typeof reduceMotion !== "boolean") ||
        (textSize !== undefined && !["standard", "large", "larger"].includes(textSize)))
      return res.status(400).json({ error: "invalid_preferences" });
    try {
      const row = await withTenantTransaction(req.actor, async client => {
        const r = await client.query(`INSERT INTO user_preferences(user_id,district_id,theme,reduce_motion,text_size) VALUES($1,$2,coalesce($3,'school'),coalesce($4,false),coalesce($5,'standard'))
          ON CONFLICT (user_id,district_id) DO UPDATE SET theme=coalesce($3,user_preferences.theme), reduce_motion=coalesce($4,user_preferences.reduce_motion),
            text_size=coalesce($5,user_preferences.text_size), updated_at=now()
          RETURNING theme,reduce_motion,text_size`, [req.actor.userId, req.actor.districtId, theme ?? null, reduceMotion ?? null, textSize ?? null]);
        await audit(client, req, "preferences.update", req.actor.userId, { theme: r.rows[0].theme, reduceMotion: r.rows[0].reduce_motion, textSize: r.rows[0].text_size }, req.actor.schoolId);
        return r.rows[0];
      });
      res.json({ data: { theme: row.theme, reduceMotion: row.reduce_motion, textSize: row.text_size } });
    } catch (e) { next(e); }
  });

  // ---- processed images (RLS: same school, the district default, or editors) ----
  app.get("/api/branding/assets/:uploadId/:variant", requireSession, async (req, res, next) => {
    const { uploadId, variant } = req.params;
    if (!validId(uploadId) || !/^(svg|png_(512|192|180|96|48|32))$/.test(variant)) return res.status(404).end();
    try {
      const r = await withTenantTransaction(req.actor, client => client.query("SELECT mime,bytes FROM branding_assets WHERE upload_id=$1 AND variant=$2", [uploadId, variant]));
      if (!r.rowCount) return res.status(404).end();
      res.setHeader("Content-Type", r.rows[0].mime);
      res.setHeader("X-Content-Type-Options", "nosniff");
      // Even a sanitized SVG is served as an inert document: no scripts, no fetches.
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
      res.setHeader("Cache-Control", "private, max-age=86400, immutable");
      res.end(r.rows[0].bytes);
    } catch (e) { next(e); }
  });

  // ---- designer (editors) ----
  app.get("/api/branding/scopes", requireSession, requirePermission("branding", "manage"), async (req, res, next) => {
    try {
      const rows = await withTenantTransaction(req.actor, async client => {
        const schools = isDistrictRole(req.actor.role)
          ? (await client.query("SELECT id,name FROM schools WHERE status='active' ORDER BY name")).rows
          : (await client.query("SELECT id,name FROM schools WHERE id=$1", [req.actor.schoolId])).rows;
        const st = await client.query(`SELECT school_id, max(version) FILTER (WHERE status='published') AS published, bool_or(status='draft') AS draft
           FROM branding_profiles GROUP BY school_id`);
        const by = new Map(st.rows.map(r => [r.school_id || "district", r]));
        const scopes = isDistrictRole(req.actor.role) ? [{ scope: "district", name: "District default" }] : [];
        for (const s of schools) scopes.push({ scope: s.id, name: s.name });
        return scopes.map(s => ({ ...s, publishedVersion: by.get(s.scope)?.published ?? null, hasDraft: Boolean(by.get(s.scope)?.draft) }));
      });
      res.json({ data: rows });
    } catch (e) { next(e); }
  });

  const editor = (handler, after = null) => async (req, res, next) => {
    try {
      const r = await withTenantTransaction(req.actor, async client => {
        const scope = await loadScope(client, req.params.scope);
        if (!scope) return fail(404, "school_not_found");
        if (!canEdit(req.actor, scope.schoolId)) return fail(403, "forbidden");
        const out = await handler(req, client, scope);
        // Same transaction as the change (2026-11-17 audit, finding 4): the flow event and its
        // webhook jobs commit with it or not at all.
        if (after && out.status < 300) await after(req, out, client);
        return out;
      });
      send(res, r);
    } catch (e) {
      if (e instanceof ImageRejected) return res.status(e.reason === "too_large" ? 413 : 422).json({ error: "image_rejected", reason: e.reason });
      next(e);
    }
  };
  async function view(client, scope) {
    const [draft] = await profiles(client, scope.schoolId, ["draft"]);
    const history = await profiles(client, scope.schoolId, ["published", "archived"]);
    const published = history.find(h => h.status === "published") || null;
    const inherited = await inheritedFor(client, scope.schoolId);
    const tiles = await tilesFor(client, scope.schoolId);
    const working = toApi(draft || published);
    const eff = M.effective(working, inherited);
    return { scope: scope.schoolId || "district", name: scope.name, draft: toApi(draft), published: toApi(published), inherited,
      effective: eff, mascot: mascotUrls(eff.mascotUploadId), tiles,
      history: history.map(h => ({ version: h.version, status: h.status, publishedAt: h.published_at, publishedByName: h.published_by_name })),
      contrast: report(eff, tiles) };
  }
  /** Get the draft row, creating it from the published profile (or empty) if needed. */
  async function ensureDraft(req, client, scope) {
    const [d] = await profiles(client, scope.schoolId, ["draft"]);
    if (d) return d;
    const [p] = await profiles(client, scope.schoolId, ["published"]);
    const r = await client.query(`INSERT INTO branding_profiles(district_id,school_id,status,mascot_name,motto,primary_color,secondary_color,accent_color,font,mascot_upload_id,tiles,based_on_version,created_by,updated_by,app_appearance)
       VALUES($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13) RETURNING *`,
      [req.actor.districtId, scope.schoolId, p?.mascot_name ?? null, p?.motto ?? null, p?.primary_color ?? null, p?.secondary_color ?? null, p?.accent_color ?? null,
       p?.font ?? null, p?.mascot_upload_id ?? null, p?.tiles ?? {}, p?.version ?? null, req.actor.userId, p?.app_appearance ?? null]);
    return r.rows[0];
  }

  app.get("/api/branding/:scope", requireSession, requirePermission("branding", "manage"), editor(async (req, client, scope) => ({ status: 200, data: await view(client, scope) })));

  app.put("/api/branding/:scope/draft", requireSession, requireCsrf, requirePermission("branding", "manage"), editor(async (req, client, scope) => {
    const body = req.body || {};
    const err = validateDraftInput(body, { isSchool: scope.schoolId !== null });
    if (err) return fail(400, err);
    const d = await ensureDraft(req, client, scope);
    const sets = [], vals = [];
    for (const [k, col] of Object.entries(FIELDS)) if (body[k] !== undefined) {
      let v = body[k]; if (typeof v === "string") v = ["primary", "secondary", "accent"].includes(k) ? v.toLowerCase() : v.trim();
      vals.push(v); sets.push(`${col}=$${vals.length}`);
    }
    if (body.tiles !== undefined) { vals.push(body.tiles === null ? {} : body.tiles); sets.push(`tiles=$${vals.length}`); }
    vals.push(req.actor.userId); sets.push(`updated_by=$${vals.length}`, "updated_at=now()");
    vals.push(d.id);
    await client.query(`UPDATE branding_profiles SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
    await audit(client, req, "draft.save", d.id, { fields: Object.keys(body) }, scope.schoolId);
    return { status: 200, data: await view(client, scope) };
  }));

  const rawImage = express.raw({ type: () => true, limit: config.brandingUploadMaxBytes });
  app.post("/api/branding/:scope/mascot", requireSession, requireCsrf, requirePermission("branding", "manage"),
    (req, res, next) => rawImage(req, res, err => err ? res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? "image_too_large" : "invalid_body" }) : next()),
    editor(async (req, client, scope) => {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const out = await processMascot(buf, { maxBytes: config.brandingUploadMaxBytes });
      const up = await client.query(`INSERT INTO branding_uploads(district_id,school_id,source_type,source_sha256,removed,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [req.actor.districtId, scope.schoolId, out.type, crypto.createHash("sha256").update(buf).digest("hex"), JSON.stringify(out.removed), req.actor.userId]);
      const uploadId = up.rows[0].id;
      for (const v of out.variants)
        await client.query(`INSERT INTO branding_assets(upload_id,district_id,school_id,variant,mime,width,height,bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [uploadId, req.actor.districtId, scope.schoolId, v.variant, v.mime, v.width, v.height, v.bytes]);
      const d = await ensureDraft(req, client, scope);
      await client.query("UPDATE branding_profiles SET mascot_upload_id=$1, updated_by=$2, updated_at=now() WHERE id=$3", [uploadId, req.actor.userId, d.id]);
      await audit(client, req, "mascot.upload", uploadId, { type: out.type, bytes: buf.length, removed: out.removed }, scope.schoolId);
      return { status: 201, data: { uploadId, type: out.type, removed: out.removed, urls: mascotUrls(uploadId), view: await view(client, scope) } };
    }));

  app.delete("/api/branding/:scope/mascot", requireSession, requireCsrf, requirePermission("branding", "manage"), editor(async (req, client, scope) => {
    const d = await ensureDraft(req, client, scope);
    await client.query("UPDATE branding_profiles SET mascot_upload_id=NULL, updated_by=$1, updated_at=now() WHERE id=$2", [req.actor.userId, d.id]);
    await audit(client, req, "mascot.remove", d.id, null, scope.schoolId);
    return { status: 200, data: await view(client, scope) };
  }));

  app.post("/api/branding/:scope/publish", requireSession, requireCsrf, requirePermission("branding", "manage"), editor(async (req, client, scope) => {
    const [d] = await profiles(client, scope.schoolId, ["draft"]);
    if (!d) return fail(409, "no_draft");
    const eff = M.effective(toApi(d), await inheritedFor(client, scope.schoolId));
    const c = report(eff, await tilesFor(client, scope.schoolId));
    if (!c.summary.ok) return fail(422, "contrast_failed", { contrast: c });
    const max = await client.query(`SELECT coalesce(max(version),0)+1 AS v FROM branding_profiles WHERE ${sameScope} AND version IS NOT NULL`, [scope.schoolId]);
    await client.query(`UPDATE branding_profiles SET status='archived' WHERE ${sameScope} AND status='published'`, [scope.schoolId]);
    await client.query(`UPDATE branding_profiles SET status='published', version=$1, published_by=$2, published_at=now(), contrast_report=$3 WHERE id=$4`,
      [max.rows[0].v, req.actor.userId, JSON.stringify(c), d.id]);
    await audit(client, req, "publish", d.id, { version: max.rows[0].v, warnings: c.summary.warnings }, scope.schoolId);
    return { status: 200, data: { version: max.rows[0].v, profileId: d.id, schoolId: scope.schoolId, view: await view(client, scope) } };
  }, (req, r, client) => emitServerFlow(req, "branding.published", r.data.profileId, r.data.schoolId, null, client)));

  app.post("/api/branding/:scope/restore", requireSession, requireCsrf, requirePermission("branding", "manage"), editor(async (req, client, scope) => {
    const version = Number(req.body?.version);
    if (!Number.isInteger(version) || version < 1) return fail(400, "invalid_version");
    const src = (await client.query(`SELECT * FROM branding_profiles WHERE ${sameScope} AND version=$2`, [scope.schoolId, version])).rows[0];
    if (!src) return fail(404, "version_not_found");
    await client.query(`DELETE FROM branding_profiles WHERE ${sameScope} AND status='draft'`, [scope.schoolId]);
    const r = await client.query(`INSERT INTO branding_profiles(district_id,school_id,status,mascot_name,motto,primary_color,secondary_color,accent_color,font,mascot_upload_id,tiles,based_on_version,created_by,updated_by,app_appearance)
       VALUES($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13) RETURNING id`,
      [req.actor.districtId, scope.schoolId, src.mascot_name, src.motto, src.primary_color, src.secondary_color, src.accent_color, src.font, src.mascot_upload_id, src.tiles, version, req.actor.userId, src.app_appearance]);
    await audit(client, req, "restore", r.rows[0].id, { version }, scope.schoolId);
    return { status: 200, data: await view(client, scope) };
  }));

  app.post("/api/branding/:scope/reset", requireSession, requireCsrf, requirePermission("branding", "manage"), editor(async (req, client, scope) => {
    // Schools: every field inherits the district default. District: the EduOS default.
    await client.query(`DELETE FROM branding_profiles WHERE ${sameScope} AND status='draft'`, [scope.schoolId]);
    const r = await client.query(`INSERT INTO branding_profiles(district_id,school_id,status,tiles,created_by,updated_by) VALUES($1,$2,'draft','{}'::jsonb,$3,$3) RETURNING id`,
      [req.actor.districtId, scope.schoolId, req.actor.userId]);
    await audit(client, req, "reset", r.rows[0].id, null, scope.schoolId);
    return { status: 200, data: await view(client, scope) };
  }));

  app.delete("/api/branding/:scope/draft", requireSession, requireCsrf, requirePermission("branding", "manage"), editor(async (req, client, scope) => {
    const r = await client.query(`DELETE FROM branding_profiles WHERE ${sameScope} AND status='draft' RETURNING id`, [scope.schoolId]);
    if (r.rowCount) await audit(client, req, "draft.discard", r.rows[0].id, null, scope.schoolId);
    return { status: 200, data: await view(client, scope) };
  }));

  // ---- public: sign-in landing, favicon and PWA manifest for one school ----
  // Keyed by "<districtId>.<schoolId>" (both random UUIDs). Only PUBLISHED
  // branding is readable (RLS with app.role='anonymous' and app.school_id).
  const publicLimiter = rateLimit({ windowMs: 60_000, limit: config.publicBrandingRateLimit, standardHeaders: true, legacyHeaders: false });
  const iconCache = new Map(); // key -> png (bounded)
  async function publicBranding(districtId, schoolId) {
    if (!validId(districtId) || !validId(schoolId)) return null;
    return withTenantTransaction({ districtId, userId: ANON_USER, role: "anonymous", schoolId }, async client => {
      const s = await client.query("SELECT id,name FROM schools WHERE id=$1 AND status='active'", [schoolId]);
      if (!s.rowCount) return null;
      const d = await client.query("SELECT name FROM districts WHERE id=$1", [districtId]);
      const pub = await client.query("SELECT * FROM branding_profiles WHERE status='published' AND (school_id IS NULL OR school_id=$1)", [schoolId]);
      const sp = pub.rows.find(r => r.school_id), dp = pub.rows.find(r => !r.school_id);
      const eff = M.effective(toApi(sp), toApi(dp));
      return { school: s.rows[0], districtName: d.rows[0]?.name || null, eff, version: `${dp?.version || 0}.${sp?.version || 0}` };
    });
  }
  const publicKey = (req) => [req.params.districtId, req.params.schoolId];
  app.get("/api/public/branding/:districtId/:schoolId", publicLimiter, async (req, res, next) => {
    try {
      const b = await publicBranding(...publicKey(req));
      if (!b) return res.status(404).json({ error: "not_found" });
      const base = `/api/public/branding/${req.params.districtId}/${req.params.schoolId}`;
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json({ data: { schoolName: b.school.name, districtName: b.districtName, mascotName: b.eff.mascotName, motto: b.eff.motto,
        primary: b.eff.primary, secondary: b.eff.secondary, accent: b.eff.accent, font: b.eff.font, appAppearance: b.eff.appAppearance, version: b.version,
        icons: Object.fromEntries([512, 192, 180, 32].map(s => [s, `${base}/icon-${s}.png?v=${b.version}`])), manifest: `${base}/manifest.webmanifest?v=${b.version}` } });
    } catch (e) { next(e); }
  });
  app.get("/api/public/branding/:districtId/:schoolId/icon-:size.png", publicLimiter, async (req, res, next) => {
    const size = Number(req.params.size);
    if (![512, 192, 180, 96, 48, 32].includes(size)) return res.status(404).end();
    try {
      const [districtId, schoolId] = publicKey(req);
      if (!validId(districtId) || !validId(schoolId)) return res.status(404).end();
      const png = await withTenantTransaction({ districtId, userId: ANON_USER, role: "anonymous", schoolId }, async client => {
        const pub = await client.query("SELECT school_id,primary_color,mascot_upload_id,version FROM branding_profiles WHERE status='published' AND (school_id IS NULL OR school_id=$1)", [schoolId]);
        const ok = await client.query("SELECT 1 FROM schools WHERE id=$1 AND status='active'", [schoolId]);
        if (!ok.rowCount) return null;
        const sp = pub.rows.find(r => r.school_id), dp = pub.rows.find(r => !r.school_id);
        const upload = sp?.mascot_upload_id || dp?.mascot_upload_id || null;
        if (upload) {
          const a = await client.query("SELECT bytes FROM branding_assets WHERE upload_id=$1 AND variant=$2", [upload, `png_${size}`]);
          if (a.rowCount) return a.rows[0].bytes;
        }
        const primary = sp?.primary_color || dp?.primary_color || M.SYSTEM_DEFAULT.primary;
        const key = `${primary}:${size}`;
        if (!iconCache.has(key)) { if (iconCache.size > 256) iconCache.clear(); iconCache.set(key, await renderPng(defaultIconSvg(primary), size)); }
        return iconCache.get(key);
      });
      if (!png) return res.status(404).end();
      res.setHeader("Content-Type", "image/png"); res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=300");
      res.end(png);
    } catch (e) { next(e); }
  });
  app.get("/api/public/branding/:districtId/:schoolId/manifest.webmanifest", publicLimiter, async (req, res, next) => {
    try {
      const b = await publicBranding(...publicKey(req));
      if (!b) return res.status(404).json({ error: "not_found" });
      const base = `/api/public/branding/${req.params.districtId}/${req.params.schoolId}`;
      res.setHeader("Content-Type", "application/manifest+json"); res.setHeader("Cache-Control", "public, max-age=300");
      // 32.4.0: ?app=mobile describes the dark, phone-first role app under /app/.
      const mobile = req.query.app === "mobile";
      res.end(JSON.stringify({ name: `${b.school.name} · EduOS${mobile ? " Mobile" : ""}`, short_name: b.school.name.slice(0, 12),
        start_url: `${mobile ? "/app/" : "/"}?school=${req.params.districtId}.${req.params.schoolId}`, ...(mobile ? { scope: "/app/", id: "/app/" } : {}),
        display: "standalone", theme_color: mobile ? "#0b0f19" : b.eff.primary, background_color: mobile ? "#0b0f19" : "#ffffff",
        icons: [192, 512].map(s => ({ src: `${base}/icon-${s}.png?v=${b.version}`, sizes: `${s}x${s}`, type: "image/png", purpose: "any" })) }));
    } catch (e) { next(e); }
  });
}
