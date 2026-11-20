// 32.2.0: district resource mesh. An app is registered once in the district
// catalog, licensed once (district-wide seats, or unlimited) and assigned to
// the whole district or to chosen schools, grades and roles. A school that
// owns an app can share it with other schools. Principals and teachers request
// apps; the district (superintendent or IT admin) decides.
//
// Privacy rules enforced here and in db/010_district_resource_mesh.sql:
//  - Sharing an app grants other schools' users the right to LAUNCH it. It
//    never grants anyone access to another school's student records, seats or
//    launch rows (RESTRICTIVE RLS); cross-school usage is visible only as
//    per-school counts through eduos_app_usage().
//  - A launch sends only the launching user's own claims, limited by the app's
//    data_sharing_scope (none < identity < roster_*). EduOS never pushes rosters.
//  - Pupils cannot launch an app that receives data unless its DPA is signed
//    and current; pupils in grade 7 or below only get COPPA-compliant apps.
//  - Every catalog change and every launch is audited with its scope.
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission, isDistrictRole, canPerform } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { pageOf, pageSql, paged } from "./paging.js";
import { loadPlatformKey, signJwt, makeHint, readHint, consumeHintDurably, launchClaims, validLtiConfig, ltiConfigFingerprint } from "./lti.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validId = v => typeof v === "string" && UUID_RE.test(v);
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.trim().length <= max;
const optText = (v, max) => v === undefined || v === null || (typeof v === "string" && v.length <= max);
const SECRET_CONFIG_KEY_RE = /secret|password|private|credential|token|api[_-]?key|access[_-]?key/i;
function hasSecretConfigKey(value) {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (SECRET_CONFIG_KEY_RE.test(key)) return true;
      if (child && typeof child === "object") pending.push(child);
    }
  }
  return false;
}
const httpUrl = v => typeof v === "string" && v.length <= 2048 && /^https?:\/\/[^\s]+$/.test(v) && (() => { try { return Boolean(new URL(v)); } catch { return false; } })();
const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z"));

export const INTEGRATION_TYPES = ["link", "oidc_sso", "lti13", "api"];
export const DATA_SCOPES = ["none", "identity", "roster_basic", "roster_full", "grades", "attendance"];
export const DPA_STATUSES = ["none", "pending", "signed", "sdpc_signed"];
export const ASSIGNABLE_ROLES = ["superintendent", "it_admin", "principal", "teacher", "parent", "pupil"];
export const GRADES = ["PK", "TK", "K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
/** Numeric grade (PK=-1, TK/K=0) or null. */
export function gradeNumber(g) {
  const s = String(g ?? "").trim().toUpperCase();
  if (s === "PK") return -1;
  if (s === "TK" || s === "K" || s === "KG") return 0;
  return /^\d{1,2}$/.test(s) ? Number(s) : null;
}
// COPPA covers children under 13; grade 7 and below is treated as under 13.
export const COPPA_MAX_GRADE = 7;
// Simplified launcher/home for the youngest learners.
export const YOUNG_LEARNER_MAX_GRADE = 2;

const fail = (status, error, extra = {}) => ({ status, error, ...extra });
const send = (res, r) => res.status(r.status).json(r.error ? { error: r.error, ...(r.extra || {}) } : { data: r.data, ...(r.meta || {}) });
const audit = (client, req, action, type, id, detail, schoolId = null) => client.query(
  `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id,school_id)
   VALUES($1,$2,$3,$4,$5,$6,'success',$7,$8,$9)`,
  [req.actor.districtId, req.actor.userId, req.actor.role, action, type, id, detail ? JSON.stringify(detail) : null, req.requestId, schoolId]);

/** Who the current user is for availability: schools and (for learners/families) grades. */
async function learnerContext(client, actor) {
  const schools = actor.schoolId ? [actor.schoolId] : [];
  let grades = [];
  if (actor.role === "pupil" || actor.role === "parent") {
    const rel = actor.role === "pupil" ? ["pupil"] : ["parent", "guardian"];
    const linked = await client.query(
      `SELECT s.school_id,s.grade_level FROM student_user_links l JOIN students s ON s.id=l.student_id
        WHERE l.user_id=$1 AND l.status='active' AND l.relationship=ANY($2)`, [actor.userId, rel]);
    for (const r of linked.rows) { if (r.school_id && !schools.includes(r.school_id)) schools.push(r.school_id); if (r.grade_level) grades.push(String(r.grade_level)); }
  }
  const nums = grades.map(gradeNumber).filter(n => n !== null);
  const youngest = nums.length ? Math.min(...nums) : null;
  return { schools, grades, youngest };
}

const AVAILABLE_SQL = `
  SELECT a.id,a.name,a.vendor,a.description,a.category,a.launch_url,a.integration_type,a.data_sharing_scope,
         a.dpa_status,a.coppa_compliant,a.owner_school_id,a.lti_registration_status,a.lti_approved_config_hash,lic.id AS license_id,lic.seat_limit,lic.ends_on
    FROM apps a
    JOIN LATERAL (
      SELECT l.id,l.seat_limit,l.ends_on FROM app_licenses l
       WHERE l.app_id=a.id AND l.status='active' AND l.starts_on<=current_date AND (l.ends_on IS NULL OR l.ends_on>=current_date)
       ORDER BY (l.seat_limit IS NULL) DESC, l.ends_on DESC NULLS FIRST, l.created_at LIMIT 1) lic ON true
   WHERE a.status='active'
     AND ($6::uuid IS NULL OR a.id=$6::uuid)
     AND EXISTS(SELECT 1 FROM app_assignments x
                 WHERE x.app_id=a.id AND x.revoked_at IS NULL AND $1=ANY(x.roles)
                   AND (x.scope='district' OR x.school_id=ANY($2::uuid[]))
                   AND (x.grade_levels IS NULL OR $1 NOT IN ('pupil','parent') OR x.grade_levels && $3::text[]))
     AND ($1 NOT IN ('pupil','parent') OR a.data_sharing_scope='none'
          OR (a.dpa_status IN ('signed','sdpc_signed') AND (a.dpa_expires_on IS NULL OR a.dpa_expires_on>=current_date)))
     AND ($1<>'pupil' OR $4::int IS NULL OR $4::int>$5::int OR a.coppa_compliant)
   ORDER BY a.name`;
async function availableApps(client, actor, appId = null) {
  const ctx = await learnerContext(client, actor);
  const rows = await client.query(AVAILABLE_SQL, [actor.role, ctx.schools, ctx.grades, ctx.youngest, COPPA_MAX_GRADE, appId]);
  return { ctx, rows: rows.rows };
}

function appOut(r, actor) {
  const out = {
    id: r.id, name: r.name, vendor: r.vendor, description: r.description, category: r.category, launchUrl: r.launch_url,
    integrationType: r.integration_type, registrationStatus: r.lti_registration_status || "not_required", dataSharingScope: r.data_sharing_scope, dpaStatus: r.dpa_status, dpaExpiresOn: r.dpa_expires_on,
    coppaCompliant: r.coppa_compliant, ferpaSchoolOfficial: r.ferpa_school_official, status: r.status,
    ownerSchoolId: r.owner_school_id, ownerSchoolName: r.owner_school_name ?? null, createdAt: r.created_at, updatedAt: r.updated_at
  };
  // Tool registration details are for district roles and the owning school only.
  if (isDistrictRole(actor.role) || (r.owner_school_id && r.owner_school_id === actor.schoolId)) out.integrationConfig = r.integration_config;
  return out;
}

function validateAppBody(body, partial) {
  const b = body || {};
  const allowed = ["name", "vendor", "description", "category", "launchUrl", "integrationType", "integrationConfig", "dataSharingScope",
    "dpaStatus", "dpaExpiresOn", "coppaCompliant", "ferpaSchoolOfficial", "ownerSchoolId", "status"];
  if (Object.keys(b).some(k => !allowed.includes(k))) return "unknown_field";
  const has = k => b[k] !== undefined;
  if (!partial || has("name")) if (!text(b.name, 160)) return "invalid_name";
  if (!partial || has("vendor")) if (!text(b.vendor, 160)) return "invalid_vendor";
  if (!partial || has("launchUrl")) if (!httpUrl(b.launchUrl)) return "invalid_launch_url";
  if (!partial || has("integrationType")) if (!INTEGRATION_TYPES.includes(b.integrationType)) return "invalid_integration_type";
  if (!optText(b.description, 2000) || !optText(b.category, 60)) return "invalid_text";
  if (has("dataSharingScope") && !DATA_SCOPES.includes(b.dataSharingScope)) return "invalid_data_sharing_scope";
  if (has("dpaStatus") && !DPA_STATUSES.includes(b.dpaStatus)) return "invalid_dpa_status";
  if (has("dpaExpiresOn") && b.dpaExpiresOn !== null && !isDate(b.dpaExpiresOn)) return "invalid_dpa_expires_on";
  if ((has("coppaCompliant") && typeof b.coppaCompliant !== "boolean") || (has("ferpaSchoolOfficial") && typeof b.ferpaSchoolOfficial !== "boolean")) return "invalid_flag";
  if (has("ownerSchoolId") && b.ownerSchoolId !== null && !validId(b.ownerSchoolId)) return "invalid_owner_school";
  if (has("status") && !["active", "retired"].includes(b.status)) return "invalid_status";
  if (has("integrationConfig")) {
    const c = b.integrationConfig;
    if (c === null || typeof c !== "object" || Array.isArray(c) || JSON.stringify(c).length > 8192) return "invalid_integration_config";
    if (hasSecretConfigKey(c)) return "integration_config_must_not_hold_secrets";
  }
  if (!partial && b.integrationType === "lti13" && !validLtiConfig(b.integrationConfig)) return "invalid_lti_config";
  if (!partial && b.integrationType === "lti13" && !["none", "identity"].includes(b.dataSharingScope || "none")) return "unsupported_lti_data_scope";
  return null;
}

/** May this actor manage (edit/license/assign) this app? */
function managesApp(actor, app) {
  if (isDistrictRole(actor.role)) return true;
  return actor.role === "principal" && app.owner_school_id && app.owner_school_id === actor.schoolId;
}

export function registerMeshRoutes(app, { emitServerFlow }) {
  const ltiKey = loadPlatformKey(config.ltiPlatformKey, config.ltiPlatformPreviousKey, config.ltiSubjectKey);
  const issuer = config.publicOrigin.replace(/\/$/, "");

  // ---- district settings (caps; NULL = unlimited) ----
  const CAPS = { maxSchools: "max_schools", maxStudents: "max_students", maxUsers: "max_users", maxActiveWebhooks: "max_active_webhooks", maxApps: "max_apps" };
  app.get("/api/district/settings", requireSession, requirePermission("district", "read"), async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const s = (await client.query("SELECT * FROM district_settings WHERE district_id=$1", [req.actor.districtId])).rows[0] || {};
        const c = (await client.query(
          `SELECT (SELECT count(*) FROM schools WHERE status='active')::int AS schools,
                  (SELECT count(*) FROM students)::int AS students,
                  (SELECT count(*) FROM district_users WHERE district_id=$1)::int AS users,
                  (SELECT count(*) FROM webhook_subscriptions WHERE status='active')::int AS active_webhooks,
                  (SELECT count(*) FROM apps WHERE status='active')::int AS apps`, [req.actor.districtId])).rows[0];
        return {
          limits: Object.fromEntries(Object.entries(CAPS).map(([k, col]) => [k, s[col] ?? null])),
          usage: { schools: c.schools, students: c.students, users: c.users, activeWebhooks: c.active_webhooks, apps: c.apps },
          note: "null means unlimited (the default)", updatedAt: s.updated_at ?? null
        };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { next(e); }
  });
  app.patch("/api/district/settings", requireSession, requireCsrf, requirePermission("district", "manage"), async (req, res, next) => {
    const b = req.body || {};
    const keys = Object.keys(b);
    if (!keys.length || keys.some(k => !CAPS[k]) || keys.some(k => b[k] !== null && !(Number.isInteger(b[k]) && b[k] > 0 && b[k] <= 1e9)))
      return res.status(400).json({ error: "invalid_district_settings", fields: Object.keys(CAPS) });
    try {
      await withTenantTransaction(req.actor, async client => {
        const cols = keys.map(k => CAPS[k]);
        await client.query(
          `INSERT INTO district_settings(district_id,${cols.join(",")},updated_by,updated_at)
           VALUES($1,${cols.map((_, i) => `$${i + 3}`).join(",")},$2,now())
           ON CONFLICT(district_id) DO UPDATE SET ${cols.map(c => `${c}=EXCLUDED.${c}`).join(",")},updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [req.actor.districtId, req.actor.userId, ...keys.map(k => b[k])]);
        await audit(client, req, "update", "district_settings", req.actor.districtId, b);
      });
      res.json({ data: { updated: keys } });
    } catch (e) { next(e); }
  });

  // School names only, so the owner of an app can choose schools to share it
  // with. (/api/schools stays limited to a principal's own school.)
  app.get("/api/schools/directory", requireSession, requirePermission("apps", "read"), async (req, res, next) => {
    try {
      const rows = await withTenantTransaction(req.actor, client => client.query("SELECT id,name FROM schools WHERE status='active' ORDER BY name"));
      res.json({ data: rows.rows });
    } catch (e) { next(e); }
  });

  // ---- catalog ----
  app.get("/api/apps", requireSession, requirePermission("apps", "read"), async (req, res, next) => {
    const pgn = pageOf(req);
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const status = req.query.status === "retired" ? "retired" : req.query.status === "all" ? null : "active";
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const rows = await client.query(
          `SELECT a.*,sc.name AS owner_school_name,count(*) OVER() AS total,
                  (SELECT coalesce(json_agg(json_build_object('id',l.id,'seatLimit',l.seat_limit,'startsOn',l.starts_on,'endsOn',l.ends_on,
                          'status',l.status,'purchasedBySchoolId',l.purchased_by_school_id,'note',l.note) ORDER BY l.created_at),'[]')
                     FROM app_licenses l WHERE l.app_id=a.id) AS licenses,
                  (SELECT coalesce(json_agg(json_build_object('id',x.id,'scope',x.scope,'schoolId',x.school_id,'schoolName',xs.name,
                          'gradeLevels',x.grade_levels,'roles',x.roles,'sharedBySchoolId',x.shared_by_school_id) ORDER BY x.created_at),'[]')
                     FROM app_assignments x LEFT JOIN schools xs ON xs.id=x.school_id WHERE x.app_id=a.id AND x.revoked_at IS NULL) AS assignments
             FROM apps a LEFT JOIN schools sc ON sc.id=a.owner_school_id
            WHERE ($1::text IS NULL OR a.status=$1)
              AND ($2::text='' OR a.name ILIKE '%'||$3||'%' OR a.vendor ILIKE '%'||$3||'%' OR a.category ILIKE '%'||$3||'%')
            ORDER BY a.name,a.id ${pageSql(pgn)}`,
          [status, q, q.replace(/[\\%_]/g, m => "\\" + m)]);
        const district = isDistrictRole(req.actor.role);
        const data = rows.rows.map(r => {
          const assignments = district || r.owner_school_id === req.actor.schoolId ? r.assignments
            : r.assignments.filter(x => x.scope === "district" || x.schoolId === req.actor.schoolId);
          const available = r.status === "active" && assignments.some(x => x.scope === "district" || x.schoolId === req.actor.schoolId);
          return { ...appOut(r, req.actor), licenses: r.licenses, assignments, availableToMySchool: district ? null : available, canManage: managesApp(req.actor, r) };
        });
        const total = rows.rows.length ? Number(rows.rows[0].total) : (pgn.offset ? null : 0);
        return paged(data, pgn, { total });
      });
      res.setHeader("Cache-Control", "no-store");
      res.json(out);
    } catch (e) { next(e); }
  });

  // District roles register any app (district- or school-owned). A principal
  // with apps:share registers an app their school bought (owner = their school).
  app.post("/api/apps", requireSession, requireCsrf, async (req, res, next) => {
    const district = canPerform(req.actor, "apps", "manage");
    if (!district && !canPerform(req.actor, "apps", "share")) return res.status(403).json({ error: "forbidden", resource: "apps", action: "manage" });
    const b = req.body || {};
    const problem = validateAppBody(b, false);
    if (problem) return res.status(400).json({ error: problem, integrationTypes: INTEGRATION_TYPES, dataSharingScopes: DATA_SCOPES });
    const owner = district ? (b.ownerSchoolId ?? null) : req.actor.schoolId;
    try {
      const r = await withTenantTransaction(req.actor, async client => {
        if (owner && !(await client.query("SELECT 1 FROM schools WHERE id=$1", [owner])).rowCount) return fail(404, "school_not_found");
        const cap = (await client.query("SELECT max_apps FROM district_settings WHERE district_id=$1", [req.actor.districtId])).rows[0]?.max_apps ?? null;
        if (cap !== null && (await client.query("SELECT count(*)::int AS n FROM apps WHERE status='active'")).rows[0].n >= cap) return fail(409, "district_limit_reached", { limit: "max_apps" });
        const dup = await client.query("SELECT 1 FROM apps WHERE status='active' AND lower(name)=lower($1)", [b.name.trim()]);
        if (dup.rowCount) return fail(409, "app_name_exists");
        const created = await client.query(
          `INSERT INTO apps(district_id,owner_school_id,name,vendor,description,category,launch_url,integration_type,integration_config,
                            data_sharing_scope,dpa_status,dpa_expires_on,coppa_compliant,ferpa_school_official,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [req.actor.districtId, owner, b.name.trim(), b.vendor.trim(), b.description ?? null, b.category ?? null, b.launchUrl, b.integrationType,
           JSON.stringify(b.integrationConfig || {}), b.dataSharingScope || "none", b.dpaStatus || "none", b.dpaExpiresOn ?? null,
           b.coppaCompliant === true, b.ferpaSchoolOfficial === true, req.actor.userId]);
        const a = created.rows[0];
        await audit(client, req, "create", "app", a.id, { name: a.name, ownerSchoolId: owner, integrationType: a.integration_type, dataSharingScope: a.data_sharing_scope, dpaStatus: a.dpa_status }, owner);
        const data = appOut(a, req.actor);
        await emitServerFlow(req, "app.registered", data.id, data.ownerSchoolId, null, client);
        return { status: 201, data };
      });
      send(res, r.error ? { ...r, extra: r.limit ? { limit: r.limit } : {} } : r);
    } catch (e) { if (e.code === "23505") return res.status(409).json({ error: "app_name_exists" }); next(e); }
  });

  app.patch("/api/apps/:appId", requireSession, requireCsrf, requirePermission("apps", "read"), async (req, res, next) => {
    if (!validId(req.params.appId)) return res.status(400).json({ error: "invalid_app_id" });
    const b = req.body || {};
    const problem = validateAppBody(b, true) || (Object.keys(b).length ? null : "empty_update");
    if (problem) return res.status(400).json({ error: problem });
    if (b.ownerSchoolId !== undefined && !isDistrictRole(req.actor.role)) return res.status(403).json({ error: "district_administrator_required" });
    try {
      const r = await withTenantTransaction(req.actor, async client => {
        const found = await client.query("SELECT * FROM apps WHERE id=$1 FOR UPDATE", [req.params.appId]);
        if (!found.rowCount) return fail(404, "app_not_found");
        const cur = found.rows[0];
        if (!managesApp(req.actor, cur)) return fail(403, "cannot_manage_app");
        const nextType = b.integrationType ?? cur.integration_type;
        const nextCfg = b.integrationConfig ?? cur.integration_config;
        const nextScope = b.dataSharingScope ?? cur.data_sharing_scope;
        if (nextType === "lti13" && !validLtiConfig(nextCfg)) return fail(400, "invalid_lti_config");
        if (nextType === "lti13" && !["none", "identity"].includes(nextScope)) return fail(400, "unsupported_lti_data_scope");
        const map = { name: "name", vendor: "vendor", description: "description", category: "category", launchUrl: "launch_url", integrationType: "integration_type",
          dataSharingScope: "data_sharing_scope", dpaStatus: "dpa_status", dpaExpiresOn: "dpa_expires_on", coppaCompliant: "coppa_compliant",
          ferpaSchoolOfficial: "ferpa_school_official", ownerSchoolId: "owner_school_id", status: "status" };
        const sets = [], vals = [req.params.appId];
        for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { vals.push(typeof b[k] === "string" && ["name", "vendor"].includes(k) ? b[k].trim() : b[k]); sets.push(`${col}=$${vals.length}`); }
        if (b.integrationConfig !== undefined) { vals.push(JSON.stringify(b.integrationConfig)); sets.push(`integration_config=$${vals.length}::jsonb`); }
        const updated = await client.query(`UPDATE apps SET ${sets.join(",")},updated_at=now() WHERE id=$1 RETURNING *`, vals);
        await audit(client, req, b.status === "retired" ? "retire" : "update", "app", cur.id, { fields: Object.keys(b) }, cur.owner_school_id);
        const data = appOut(updated.rows[0], req.actor);
        if (b.status === "retired" && cur.status !== "retired") await emitServerFlow(req, "app.retired", data.id, data.ownerSchoolId, null, client);
        return { status: 200, data };
      });
      send(res, r);
    } catch (e) { if (e.code === "23505") return res.status(409).json({ error: "app_name_exists" }); next(e); }
  });

  // LTI registrations require explicit district approval. Re-approval is
  // required after any integration configuration change; revocation is immediate.
  app.post("/api/apps/:appId/lti/approve", requireSession, requireCsrf, requirePermission("apps", "decide"), async (req, res, next) => {
    if (!validId(req.params.appId)) return res.status(400).json({ error: "invalid_app_id" });
    try {
      const r = await withTenantTransaction(req.actor, async client => {
        const found = await client.query("SELECT * FROM apps WHERE id=$1 FOR UPDATE", [req.params.appId]);
        if (!found.rowCount) return fail(404, "app_not_found");
        const a = found.rows[0];
        if (a.integration_type !== "lti13" || a.status !== "active") return fail(409, "lti_registration_not_approvable");
        if (!validLtiConfig(a.integration_config, { allowInsecureLoopback: config.nodeEnv !== "production" })) return fail(409, "lti_configuration_invalid");
        const fingerprint = ltiConfigFingerprint(a.integration_config);
        const updated = await client.query(
          "SELECT * FROM eduos_lti_approve_registration($1,$2,$3)",
          [a.id, fingerprint, req.actor.userId]);
        await audit(client, req, "approve_lti_registration", "app", a.id, { configFingerprint: fingerprint }, a.owner_school_id);
        return { status: 200, data: { id: a.id, registrationStatus: updated.rows[0].registration_status, approvedAt: updated.rows[0].approved_at } };
      });
      send(res, r);
    } catch (e) { next(e); }
  });

  app.post("/api/apps/:appId/lti/revoke", requireSession, requireCsrf, requirePermission("apps", "decide"), async (req, res, next) => {
    if (!validId(req.params.appId)) return res.status(400).json({ error: "invalid_app_id" });
    try {
      const r = await withTenantTransaction(req.actor, async client => {
        const found = await client.query("SELECT * FROM apps WHERE id=$1 FOR UPDATE", [req.params.appId]);
        if (!found.rowCount) return fail(404, "app_not_found");
        const a = found.rows[0];
        if (a.integration_type !== "lti13") return fail(409, "not_an_lti_registration");
        const updated = await client.query(
          "SELECT * FROM eduos_lti_revoke_registration($1,$2)",
          [a.id, req.actor.userId]);
        await audit(client, req, "revoke_lti_registration", "app", a.id, { previousStatus: a.lti_registration_status }, a.owner_school_id);
        return { status: 200, data: { id: a.id, registrationStatus: updated.rows[0].registration_status, revokedAt: updated.rows[0].revoked_at } };
      });
      send(res, r);
    } catch (e) { next(e); }
  });

  // ---- licenses ----
  app.post("/api/apps/:appId/licenses", requireSession, requireCsrf, requirePermission("apps", "read"), async (req, res, next) => {
    if (!validId(req.params.appId)) return res.status(400).json({ error: "invalid_app_id" });
    const { seatLimit = null, startsOn, endsOn = null, note = null } = req.body || {};
    if ((seatLimit !== null && !(Number.isInteger(seatLimit) && seatLimit > 0 && seatLimit <= 1e9)) || (startsOn !== undefined && !isDate(startsOn)) ||
        (endsOn !== null && !isDate(endsOn)) || (startsOn && endsOn && endsOn < startsOn) || !optText(note, 500))
      return res.status(400).json({ error: "invalid_license" });
    try {
      const r = await withTenantTransaction(req.actor, async client => {
        const found = await client.query("SELECT * FROM apps WHERE id=$1", [req.params.appId]);
        if (!found.rowCount) return fail(404, "app_not_found");
        if (!managesApp(req.actor, found.rows[0])) return fail(403, "cannot_manage_app");
        const purchaser = isDistrictRole(req.actor.role) ? null : req.actor.schoolId;
        const lic = await client.query(
          `INSERT INTO app_licenses(district_id,app_id,purchased_by_school_id,seat_limit,starts_on,ends_on,note,created_by)
           VALUES($1,$2,$3,$4,COALESCE($5::date,current_date),$6,$7,$8)
           RETURNING id,seat_limit,starts_on,ends_on,status,purchased_by_school_id,note`,
          [req.actor.districtId, req.params.appId, purchaser, seatLimit, startsOn ?? null, endsOn, note, req.actor.userId]);
        const l = lic.rows[0];
        await audit(client, req, "create", "app_license", l.id, { appId: req.params.appId, seatLimit, startsOn: l.starts_on, endsOn }, purchaser);
        await emitServerFlow(req, "app.licensed", req.params.appId, l.purchased_by_school_id, null, client);
        return { status: 201, data: { id: l.id, seatLimit: l.seat_limit, startsOn: l.starts_on, endsOn: l.ends_on, status: l.status, purchasedBySchoolId: l.purchased_by_school_id, note: l.note } };
      });
      send(res, r);
    } catch (e) { next(e); }
  });
  app.patch("/api/apps/:appId/licenses/:licenseId", requireSession, requireCsrf, requirePermission("apps", "read"), async (req, res, next) => {
    if (!validId(req.params.appId) || !validId(req.params.licenseId)) return res.status(400).json({ error: "invalid_id" });
    const b = req.body || {};
    if (!Object.keys(b).length || Object.keys(b).some(k => !["status", "seatLimit", "endsOn"].includes(k)) ||
        (b.status !== undefined && !["active", "cancelled"].includes(b.status)) ||
        (b.seatLimit !== undefined && b.seatLimit !== null && !(Number.isInteger(b.seatLimit) && b.seatLimit > 0)) ||
        (b.endsOn !== undefined && b.endsOn !== null && !isDate(b.endsOn)))
      return res.status(400).json({ error: "invalid_license_update" });
    try {
      const r = await withTenantTransaction(req.actor, async client => {
        const found = await client.query(`SELECT a.* FROM apps a JOIN app_licenses l ON l.app_id=a.id WHERE a.id=$1 AND l.id=$2`, [req.params.appId, req.params.licenseId]);
        if (!found.rowCount) return fail(404, "license_not_found");
        if (!managesApp(req.actor, found.rows[0])) return fail(403, "cannot_manage_app");
        const u = await client.query(
          `UPDATE app_licenses SET status=COALESCE($2,status),
                  seat_limit=CASE WHEN $3 THEN $4::int ELSE seat_limit END,
                  ends_on=CASE WHEN $5 THEN $6::date ELSE ends_on END
            WHERE id=$1 RETURNING id,seat_limit,starts_on,ends_on,status`,
          [req.params.licenseId, b.status ?? null, b.seatLimit !== undefined, b.seatLimit ?? null, b.endsOn !== undefined, b.endsOn ?? null]);
        await audit(client, req, "update", "app_license", req.params.licenseId, b, found.rows[0].owner_school_id);
        const l = u.rows[0];
        return { status: 200, data: { id: l.id, seatLimit: l.seat_limit, startsOn: l.starts_on, endsOn: l.ends_on, status: l.status } };
      });
      send(res, r);
    } catch (e) { if (e.code === "23514") return res.status(400).json({ error: "invalid_license_update" }); next(e); }
  });

  // ---- assignments and sharing ----
  app.post("/api/apps/:appId/assignments", requireSession, requireCsrf, requirePermission("apps", "read"), async (req, res, next) => {
    if (!validId(req.params.appId)) return res.status(400).json({ error: "invalid_app_id" });
    const { scope, schoolId = null, gradeLevels = null, roles = ["principal", "teacher", "parent", "pupil"] } = req.body || {};
    if (!["district", "school"].includes(scope) || (scope === "school") !== validId(schoolId) ||
        (gradeLevels !== null && !(Array.isArray(gradeLevels) && gradeLevels.length >= 1 && gradeLevels.length <= 16 && gradeLevels.every(g => GRADES.includes(g)))) ||
        !(Array.isArray(roles) && roles.length >= 1 && roles.length <= 6 && new Set(roles).size === roles.length && roles.every(r => ASSIGNABLE_ROLES.includes(r))))
      return res.status(400).json({ error: "invalid_assignment", grades: GRADES, roles: ASSIGNABLE_ROLES });
    try {
      const r = await withTenantTransaction(req.actor, async client => {
        const found = await client.query("SELECT * FROM apps WHERE id=$1", [req.params.appId]);
        if (!found.rowCount) return fail(404, "app_not_found");
        const a = found.rows[0];
        if (a.status !== "active") return fail(409, "app_retired");
        const district = isDistrictRole(req.actor.role);
        // The owning school may share with any school, but only district roles assign district-wide.
        if (!district && !(managesApp(req.actor, a) && scope === "school")) return fail(403, "cannot_assign_app");
        if (scope === "school" && !(await client.query("SELECT 1 FROM schools WHERE id=$1 AND status='active'", [schoolId])).rowCount) return fail(404, "school_not_found");
        const sharedBy = !district && schoolId !== req.actor.schoolId ? req.actor.schoolId : null;
        const ins = await client.query(
          `INSERT INTO app_assignments(district_id,app_id,scope,school_id,grade_levels,roles,shared_by_school_id,assigned_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
          [req.actor.districtId, a.id, scope, schoolId, gradeLevels, roles, sharedBy, req.actor.userId]);
        if (!ins.rowCount) return fail(409, "assignment_exists");
        await audit(client, req, sharedBy ? "share" : "assign", "app_assignment", ins.rows[0].id,
          { appId: a.id, scope, schoolId, gradeLevels, roles, sharedBySchoolId: sharedBy, dataSharingScope: a.data_sharing_scope }, schoolId);
        await emitServerFlow(req, "app.assigned", req.params.appId, schoolId, null, client);
        return { status: 201, data: { id: ins.rows[0].id, appId: a.id, scope, schoolId, gradeLevels, roles, sharedBySchoolId: sharedBy } };
      });
      send(res, r);
    } catch (e) { next(e); }
  });
  app.delete("/api/apps/:appId/assignments/:assignmentId", requireSession, requireCsrf, requirePermission("apps", "read"), async (req, res, next) => {
    if (!validId(req.params.appId) || !validId(req.params.assignmentId)) return res.status(400).json({ error: "invalid_id" });
    try {
      const r = await withTenantTransaction(req.actor, async client => {
        const found = await client.query(
          `SELECT x.id,x.scope,x.school_id,a.owner_school_id FROM app_assignments x JOIN apps a ON a.id=x.app_id
            WHERE x.id=$1 AND x.app_id=$2 AND x.revoked_at IS NULL FOR UPDATE OF x`, [req.params.assignmentId, req.params.appId]);
        if (!found.rowCount) return fail(404, "assignment_not_found");
        const x = found.rows[0];
        if (!isDistrictRole(req.actor.role) && !(managesApp(req.actor, x) && x.scope === "school")) return fail(403, "cannot_assign_app");
        await client.query("UPDATE app_assignments SET revoked_at=now(),revoked_by=$2 WHERE id=$1", [x.id, req.actor.userId]);
        await audit(client, req, "unassign", "app_assignment", x.id, { appId: req.params.appId, scope: x.scope, schoolId: x.school_id }, x.school_id);
        await emitServerFlow(req, "app.unassigned", req.params.appId, x.school_id, null, client);
        return { status: 200, data: { id: x.id, revoked: true }, schoolId: x.school_id };
      });
      send(res, r);
    } catch (e) { next(e); }
  });

  // ---- usage ----
  app.get("/api/apps/:appId/usage", requireSession, requirePermission("apps", "report"), async (req, res, next) => {
    if (!validId(req.params.appId)) return res.status(400).json({ error: "invalid_app_id" });
    try {
      const r = await withTenantTransaction(req.actor, async client => {
        const a = await client.query("SELECT id,name,owner_school_id FROM apps WHERE id=$1", [req.params.appId]);
        if (!a.rowCount) return fail(404, "app_not_found");
        const rows = await client.query(
          `SELECT u.*,s.name AS school_name FROM eduos_app_usage($1) u LEFT JOIN schools s ON s.id=u.school_id ORDER BY s.name NULLS FIRST`, [req.params.appId]);
        const lic = await client.query(
          `SELECT coalesce(sum(seat_limit),0)::bigint AS seats, bool_or(seat_limit IS NULL) AS unlimited FROM app_licenses
            WHERE app_id=$1 AND status='active' AND starts_on<=current_date AND (ends_on IS NULL OR ends_on>=current_date)`, [req.params.appId]);
        const bySchool = rows.rows.map(x => ({ schoolId: x.school_id, schoolName: x.school_name ?? (x.school_id ? null : "District staff"),
          seatsUsed: Number(x.seats_used), launches: Number(x.launches), launches30d: Number(x.launches_30d), lastLaunchAt: x.last_launch_at }));
        const everything = isDistrictRole(req.actor.role) || a.rows[0].owner_school_id === req.actor.schoolId;
        return { status: 200, data: { appId: a.rows[0].id, name: a.rows[0].name, scope: everything ? "district" : "my_school",
          seatsLicensed: lic.rows[0].unlimited ? null : Number(lic.rows[0].seats), unlimited: Boolean(lic.rows[0].unlimited),
          seatsUsed: bySchool.reduce((n, x) => n + x.seatsUsed, 0), launches: bySchool.reduce((n, x) => n + x.launches, 0), bySchool } };
      });
      send(res, r);
    } catch (e) { next(e); }
  });
  // Summary across the catalog. RLS limits seats/launches to what the caller may see.
  app.get("/api/apps-usage", requireSession, requirePermission("apps", "report"), async (req, res, next) => {
    try {
      const rows = await withTenantTransaction(req.actor, client => client.query(
        `SELECT a.id,a.name,a.vendor,a.owner_school_id,
                (SELECT CASE WHEN bool_or(l.seat_limit IS NULL) THEN NULL ELSE sum(l.seat_limit) END FROM app_licenses l
                  WHERE l.app_id=a.id AND l.status='active' AND l.starts_on<=current_date AND (l.ends_on IS NULL OR l.ends_on>=current_date)) AS seats_licensed,
                (SELECT count(*) FROM app_licenses l WHERE l.app_id=a.id AND l.status='active' AND l.starts_on<=current_date AND (l.ends_on IS NULL OR l.ends_on>=current_date)) AS active_licenses,
                (SELECT count(*) FROM app_seats st JOIN app_licenses l ON l.id=st.license_id WHERE l.app_id=a.id) AS seats_used,
                (SELECT count(*) FROM app_launches la WHERE la.app_id=a.id AND la.launched_at>now()-interval '30 days') AS launches_30d,
                (SELECT min(l.ends_on) FROM app_licenses l WHERE l.app_id=a.id AND l.status='active' AND l.ends_on>=current_date) AS next_renewal
           FROM apps a WHERE a.status='active' ORDER BY a.name LIMIT 2000`));
      res.setHeader("Cache-Control", "no-store");
      res.json({ scope: isDistrictRole(req.actor.role) ? "district" : "my_school", data: rows.rows.map(r => ({
        id: r.id, name: r.name, vendor: r.vendor, ownerSchoolId: r.owner_school_id, seatsLicensed: r.seats_licensed === null ? null : Number(r.seats_licensed),
        licensed: Number(r.active_licenses) > 0, seatsUsed: Number(r.seats_used), launches30d: Number(r.launches_30d), nextRenewal: r.next_renewal })) });
    } catch (e) { next(e); }
  });

  // ---- launcher ----
  app.get("/api/my/apps", requireSession, requirePermission("apps", "launch"), async (req, res, next) => {
    try {
      const { ctx, rows } = await withTenantTransaction(req.actor, client => availableApps(client, req.actor));
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: rows.map(r => ({ id: r.id, name: r.name, vendor: r.vendor, description: r.description, category: r.category,
        integrationType: r.integration_type, dataSharingScope: r.data_sharing_scope, coppaCompliant: r.coppa_compliant })),
        learner: { youngestGrade: ctx.youngest, youngLearner: ctx.youngest !== null && ctx.youngest <= YOUNG_LEARNER_MAX_GRADE } });
    } catch (e) { next(e); }
  });

  app.post("/api/apps/:appId/launch", requireSession, requireCsrf, requirePermission("apps", "launch"), async (req, res, next) => {
    if (!validId(req.params.appId)) return res.status(400).json({ error: "invalid_app_id" });
    try {
      const r = await withTenantTransaction(req.actor, async client => {
        const { rows } = await availableApps(client, req.actor, req.params.appId);
        if (!rows.length) return fail(403, "app_not_available");
        const a = rows[0];
        if (a.integration_type === "lti13" && !ltiKey) return fail(503, "lti_not_configured");
        const cfg = a.integration_type === "lti13"
          ? (await client.query("SELECT integration_config,lti_registration_status,lti_approved_config_hash,lti_approved_at FROM apps WHERE id=$1", [a.id])).rows[0]
          : null;
        if (a.integration_type === "lti13" && !validLtiConfig(cfg.integration_config, { allowInsecureLoopback: config.nodeEnv !== "production" })) return fail(409, "lti_configuration_invalid");
        if (a.integration_type === "lti13" && (cfg.lti_registration_status !== "approved" || cfg.lti_approved_config_hash !== ltiConfigFingerprint(cfg.integration_config))) return fail(409, "lti_approval_required");
        const seat = (await client.query("SELECT eduos_claim_seat($1) AS r", [a.license_id])).rows[0].r;
        if (seat === "exhausted") return fail(409, "no_seats_available");
        if (seat !== "ok") return fail(409, "license_inactive");
        const launch = await client.query(
          `INSERT INTO app_launches(district_id,app_id,license_id,user_id,school_id,role,integration_type,shared_scope)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [req.actor.districtId, a.id, a.license_id, req.actor.userId, req.actor.schoolId || null, req.actor.role, a.integration_type, a.data_sharing_scope]);
        await audit(client, req, "launch", "app", a.id, { integrationType: a.integration_type, dataSharingScope: a.data_sharing_scope, launchId: launch.rows[0].id }, req.actor.schoolId || null);
        if (a.integration_type !== "lti13") return { status: 200, data: { url: a.launch_url, integrationType: a.integration_type } };
        const ltiCfg = cfg.integration_config;
        const hint = makeHint(ltiKey, { l: launch.rows[0].id, a: a.id, u: req.actor.userId, d: req.actor.districtId, r: req.actor.role, s: req.actor.schoolId || null, c: ltiConfigFingerprint(ltiCfg), v: new Date(cfg.lti_approved_at).toISOString() });
        const u = new URL(ltiCfg.loginUrl);
        u.searchParams.set("iss", issuer); u.searchParams.set("login_hint", launch.rows[0].id);
        u.searchParams.set("target_link_uri", ltiCfg.targetLinkUri); u.searchParams.set("lti_message_hint", hint);
        u.searchParams.set("client_id", ltiCfg.clientId);
        return { status: 200, data: { url: u.href, integrationType: "lti13" } };
      });
      res.setHeader("Cache-Control", "no-store");
      send(res, r);
    } catch (e) { next(e); }
  });

  // LTI 1.3 OIDC authentication request from the tool (GET or form POST).
  const ltiAuthorize = async (req, res, next) => {
    const deny = (status, error) => res.status(status).type("text/plain").send(`LTI launch refused: ${error}`);
    const query = req.query || {};
    const body = typeof req.body === "object" && req.body ? req.body : {};
    // OIDC parameters must arrive through exactly one transport. Mixing query
    // and form parameters creates ambiguous precedence (parameter pollution).
    if (req.method === "POST" && Object.keys(query).length) return deny(400, "duplicate_request_parameters");
    const p = req.method === "POST" ? body : query;
    if (!ltiKey) return deny(503, "lti_not_configured");
    // Accept only the LTI/OIDC parameters this endpoint implements. Silently
    // ignoring extension or misspelled parameters can create divergent
    // validation between the platform and relying party.
    const allowedParameters = new Set([
      "scope", "response_type", "response_mode", "prompt", "client_id",
      "redirect_uri", "login_hint", "lti_message_hint", "state", "nonce"
    ]);
    if (!p || typeof p !== "object" || Array.isArray(p) ||
        Object.keys(p).some(name => !allowedParameters.has(name)) ||
        (p.prompt !== undefined && p.prompt !== "none") ||
        p.scope !== "openid" || p.response_type !== "id_token" || p.response_mode !== "form_post" ||
        typeof p.nonce !== "string" || p.nonce.length < 1 || p.nonce.length > 256 ||
        typeof p.state !== "string" || p.state.length < 1 || p.state.length > 2048 ||
        typeof p.redirect_uri !== "string" || typeof p.client_id !== "string" ||
        typeof p.login_hint !== "string" || typeof p.lti_message_hint !== "string")
      return deny(400, "invalid_request");
    const hint = readHint(ltiKey, p.lti_message_hint);
    if (!hint || p.login_hint !== hint.l) return deny(400, "invalid_or_expired_launch");
    // The signed hint is bound to one user, app, launch row and tenant, expires
    // in 5 minutes and is accepted once.
    try {
      const actor = { districtId: hint.d, userId: hint.u, role: hint.r, schoolId: hint.s };
      if (!validId(hint.d) || !validId(hint.l) || !validId(hint.a) || !validId(hint.u) ||
          (hint.s !== null && hint.s !== undefined && !validId(hint.s)) ||
          !Number.isFinite(hint.exp) || hint.exp <= Date.now()) return deny(400, "invalid_or_expired_launch");
      const result = await withTenantTransaction(actor, async client => {
        // Re-check the user's live district membership before honoring a signed
        // hint; disabling a membership must revoke in-flight launch authority.
        const membership = await client.query(
          "SELECT 1 FROM memberships WHERE user_id=$1 AND district_id=$2 AND role=$3 AND school_id IS NOT DISTINCT FROM $4::uuid AND status='active'",
          [hint.u, hint.d, hint.r, hint.s || null]
        );
        if (!membership.rowCount) return { error: "membership_inactive", status: 403 };
        // Re-check current catalog assignment, license, DPA and learner eligibility
        // at callback time; a launch hint must not outlive a revoked entitlement.
        const current = await availableApps(client, actor, hint.a);
        if (!current.rows.length) return { error: "app_not_available", status: 403 };
        const app = (await client.query("SELECT * FROM apps WHERE id=$1 AND status='active'", [hint.a])).rows[0];
        const launch = (await client.query("SELECT id,role,school_id,license_id FROM app_launches WHERE id=$1 AND user_id=$2 AND app_id=$3", [hint.l, hint.u, hint.a])).rows[0];
        const user = (await client.query("SELECT id,display_name,email,status FROM users WHERE id=$1", [hint.u])).rows[0];
        const school = hint.s ? (await client.query("SELECT id,name FROM schools WHERE id=$1 AND status='active'", [hint.s])).rows[0] : null;
        if (!app || !launch || !user || user.status !== "active" || (hint.s && !school))
          return { error: "launch_not_found", status: 403 };
        if (launch.role !== hint.r || (launch.school_id || null) !== (hint.s || null))
          return { error: "launch_context_changed", status: 403 };
        // The license whose seat was claimed at launch must still be active;
        // a replacement license must not silently revive a revoked launch.
        const license = await client.query(
          "SELECT 1 FROM app_licenses WHERE id=$1 AND app_id=$2 AND status='active' AND starts_on<=current_date AND (ends_on IS NULL OR ends_on>=current_date)",
          [launch.license_id, hint.a]
        );
        if (!license.rowCount) return { error: "license_inactive", status: 403 };
        const cfg = app.integration_config || {};
        // Revalidate the live registration at callback time as well as launch
        // initiation: configuration may have changed while the browser was
        // completing the OIDC round-trip.
        if (!validLtiConfig(cfg, { allowInsecureLoopback: config.nodeEnv !== "production" }))
          return { error: "lti_configuration_invalid", status: 409 };
        if (typeof hint.c !== "string" || ltiConfigFingerprint(cfg) !== hint.c)
          return { error: "lti_registration_changed", status: 409 };
        if (app.lti_registration_status !== "approved" || app.lti_approved_config_hash !== ltiConfigFingerprint(cfg))
          return { error: "lti_approval_required", status: 409 };
        if (!app.lti_approved_at || hint.v !== new Date(app.lti_approved_at).toISOString())
          return { error: "lti_approval_changed", status: 409 };
        if (app.integration_type !== "lti13" || p.client_id !== cfg.clientId) return { error: "client_mismatch", status: 400 };
        if (!["none", "identity"].includes(app.data_sharing_scope)) return { error: "unsupported_lti_data_scope", status: 403 };
        if (!Array.isArray(cfg.redirectUris) || !cfg.redirectUris.includes(p.redirect_uri)) return { error: "redirect_uri_not_registered", status: 400 };
        // Claim the launch atomically in the same tenant transaction as the
        // authorization checks. This prevents replay across processes/restarts.
        const consumed = await consumeHintDurably(client, hint.d, hint.l, new Date(hint.exp));
        if (!consumed) return { error: "launch_already_used", status: 409 };
        return { app, launch, user, school };
      });
      if (result.error) return deny(result.status, result.error);
      const ctx = result;
      const idToken = signJwt(ltiKey, launchClaims({ key: ltiKey, issuer, app: ctx.app, launch: { role: ctx.launch.role, districtId: hint.d }, user: ctx.user, school: ctx.school, nonce: p.nonce }));
      const esc = v => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const target = new URL(p.redirect_uri);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action ${target.origin}; frame-ancestors 'self'; base-uri 'none'`);
      res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Opening app…</title></head>
<body><main><h1 style="font:16px system-ui">Opening ${esc(ctx.app.name)}…</h1>
<form id="lti" method="post" action="${esc(p.redirect_uri)}"><input type="hidden" name="id_token" value="${esc(idToken)}">${p.state !== undefined ? `<input type="hidden" name="state" value="${esc(p.state)}">` : ""}
<noscript><button type="submit">Continue to ${esc(ctx.app.name)}</button></noscript></form></main>
<script>document.getElementById("lti").submit()</script></body></html>`);
    } catch (e) { next(e); }
  };
  app.get("/lti/authorize", ltiAuthorize);
  app.post("/lti/authorize", (req, res, next) => {
    // LTI response_mode=form_post requires an URL-encoded form body. Do not
    // accept JSON or other parsers' output as an alternate OIDC transport.
    if (!req.is("application/x-www-form-urlencoded")) return res.status(415).type("text/plain").send("LTI launch refused: unsupported_content_type");
    return expressRawUrlencoded(req, res, error => {
      if (error) return next(error);
      // Reject unknown names before constructing an object from request data.
      // Map avoids user-controlled property writes; Object.fromEntries receives
      // only protocol keys from this fixed allowlist and preserves duplicate values.
      const allowedFormParameters = new Set([
        "scope", "response_type", "response_mode", "prompt", "client_id",
        "redirect_uri", "login_hint", "lti_message_hint", "state", "nonce"
      ]);
      const parsed = new Map();
      for (const [key, value] of new URLSearchParams(req.body.toString("utf8"))) {
        if (!allowedFormParameters.has(key)) return res.status(400).type("text/plain").send("LTI launch refused: invalid_request");
        if (parsed.has(key)) {
          const previous = parsed.get(key);
          parsed.set(key, Array.isArray(previous) ? [...previous, value] : [previous, value]);
        } else {
          parsed.set(key, value);
        }
      }
      req.body = Object.fromEntries(parsed);
      return ltiAuthorize(req, res, next);
    });
  });
  app.get("/.well-known/jwks.json", (_req, res) => { res.setHeader("Cache-Control", "public, max-age=300"); res.json(ltiKey ? ltiKey.jwks : { keys: [] }); });

  // ---- requests (principal/teacher -> district) ----
  app.get("/api/app-requests", requireSession, requirePermission("apps", "read"), async (req, res, next) => {
    const pgn = pageOf(req);
    const status = ["pending", "approved", "denied", "withdrawn"].includes(req.query.status) ? req.query.status : null;
    try {
      const rows = await withTenantTransaction(req.actor, client => client.query(
        `SELECT r.id,r.school_id,sc.name AS school_name,r.app_id,a.name AS app_name,r.requested_name,r.requested_vendor,r.requested_url,
                r.reason,r.status,r.decision_note,r.decided_at,r.created_at,u.display_name AS requested_by_name,(r.requested_by=$2) AS mine
           FROM app_requests r JOIN schools sc ON sc.id=r.school_id LEFT JOIN apps a ON a.id=r.app_id JOIN users u ON u.id=r.requested_by
          WHERE ($1::text IS NULL OR r.status=$1) AND ($3<>'teacher' OR r.requested_by=$2)
          ORDER BY (r.status='pending') DESC, r.created_at DESC ${pageSql(pgn)}`, [status, req.actor.userId, req.actor.role]));
      res.setHeader("Cache-Control", "no-store");
      res.json(paged(rows.rows, pgn));
    } catch (e) { next(e); }
  });
  app.post("/api/app-requests", requireSession, requireCsrf, requirePermission("apps", "request"), async (req, res, next) => {
    const { appId = null, name = null, vendor = null, url = null, reason } = req.body || {};
    if (!req.actor.schoolId) return res.status(400).json({ error: "school_required" });
    if (!text(reason, 2000) || (appId === null && !text(name, 160)) || (appId !== null && !validId(appId)) ||
        !optText(vendor, 160) || (url !== null && !httpUrl(url)))
      return res.status(400).json({ error: "invalid_app_request" });
    try {
      const r = await withTenantTransaction(req.actor, async client => {
        if (appId && !(await client.query("SELECT 1 FROM apps WHERE id=$1 AND status='active'", [appId])).rowCount) return fail(404, "app_not_found");
        const dup = await client.query(
          `SELECT 1 FROM app_requests WHERE school_id=$1 AND status='pending' AND (app_id=$2 OR ($2::uuid IS NULL AND lower(requested_name)=lower($3)))`,
          [req.actor.schoolId, appId, name?.trim() ?? null]);
        if (dup.rowCount) return fail(409, "request_already_pending");
        const ins = await client.query(
          `INSERT INTO app_requests(district_id,school_id,requested_by,app_id,requested_name,requested_vendor,requested_url,reason)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,status,created_at`,
          [req.actor.districtId, req.actor.schoolId, req.actor.userId, appId, name?.trim() ?? null, vendor?.trim() || null, url, reason.trim()]);
        await audit(client, req, "request", "app_request", ins.rows[0].id, { appId, name: name?.trim() ?? null }, req.actor.schoolId);
        await emitServerFlow(req, "app.requested", ins.rows[0].id, req.actor.schoolId, null, client);
        return { status: 201, data: { id: ins.rows[0].id, status: "pending", createdAt: ins.rows[0].created_at } };
      });
      send(res, r);
    } catch (e) { next(e); }
  });
  // Approving a request for a catalog app assigns it to the requesting school.
  app.patch("/api/app-requests/:requestId", requireSession, requireCsrf, async (req, res, next) => {
    if (!validId(req.params.requestId)) return res.status(400).json({ error: "invalid_request_id" });
    const { decision, note = null, withdraw = false } = req.body || {};
    try {
      const r = await withTenantTransaction(req.actor, async client => {
        const found = await client.query("SELECT * FROM app_requests WHERE id=$1 FOR UPDATE", [req.params.requestId]);
        if (!found.rowCount) return fail(404, "request_not_found");
        const q = found.rows[0];
        if (q.status !== "pending") return fail(409, "request_not_pending");
        if (withdraw === true) {
          if (q.requested_by !== req.actor.userId) return fail(403, "not_your_request");
          await client.query("UPDATE app_requests SET status='withdrawn' WHERE id=$1", [q.id]);
          await audit(client, req, "withdraw", "app_request", q.id, null, q.school_id);
          return { status: 200, data: { id: q.id, status: "withdrawn" } };
        }
        if (!canPerform(req.actor, "apps", "decide")) return fail(403, "district_administrator_required");
        if (!["approved", "denied"].includes(decision) || !optText(note, 1000)) return fail(400, "invalid_decision");
        // 37.6.0: marketplace requests need an approved privacy review and go
        // through POST /api/marketplace/requests/:id/approve (license + fee hook).
        if (decision === "approved" && q.listing_id) return fail(409, "use_marketplace_approval");
        let assignmentId = null;
        if (decision === "approved" && q.app_id) {
          const ins = await client.query(
            `INSERT INTO app_assignments(district_id,app_id,scope,school_id,assigned_by) VALUES($1,$2,'school',$3,$4)
             ON CONFLICT DO NOTHING RETURNING id`, [req.actor.districtId, q.app_id, q.school_id, req.actor.userId]);
          assignmentId = ins.rows[0]?.id ?? null;
        }
        await client.query("UPDATE app_requests SET status=$2,decided_by=$3,decided_at=now(),decision_note=$4 WHERE id=$1", [q.id, decision, req.actor.userId, note]);
        await audit(client, req, decision === "approved" ? "approve" : "deny", "app_request", q.id, { appId: q.app_id, assignmentId }, q.school_id);
        await emitServerFlow(req, "app.request.decided", q.id, q.school_id, null, client);
        if (assignmentId) await emitServerFlow(req, "app.assigned", q.app_id, q.school_id, null, client);
        return { status: 200, data: { id: q.id, status: decision, assignmentId, nextStep: decision === "approved" && !q.app_id ? "register_and_license_the_app" : null }, schoolId: q.school_id, appId: q.app_id };
      });
      send(res, r);
    } catch (e) { next(e); }
  });
}

// Bounded raw parser for the LTI OIDC POST variant. Parsing raw bytes first
// makes the 16KB cap apply before protocol-field validation and also covers
// chunked requests without relying on Content-Length.
import express from "express";
const expressRawUrlencoded = express.raw({ type: "application/x-www-form-urlencoded", limit: "16kb" });
