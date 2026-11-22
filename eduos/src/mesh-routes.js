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
import { withTenantTransaction, pool } from "./db.js";
import { config } from "./config.js";
import { pageOf, pageSql, paged } from "./paging.js";
import { loadPlatformKey, signJwt, makeHint, readHint, consumeHintDurably, launchClaims, validLtiConfig, ltiConfigFingerprint,
  newBrowserBinding, browserBindingMatches, bindingCookieName, AUTO_SUBMIT_SCRIPT, AUTO_SUBMIT_SCRIPT_HASH,
  DEEP_LINK_TTL_MS, decodeJwt, verifyToolJwt, acceptContentItems,
  LTI_SCOPES, NRPS_SCOPE, SERVICE_TOKEN_TTL_MS, verifyClientAssertion, pairwiseSub, pairwiseContext,
  AGS_SCORE_SCOPE, AGS_LINEITEM_READ_SCOPE } from "./lti.js";
import { request as outboundRequest } from "./integrations/http.js";
import crypto from "node:crypto";
import { getCookie, serialize as serializeCookie } from "./cookies.js";

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
         a.dpa_status,a.coppa_compliant,a.owner_school_id,a.lti_registration_status,a.lti_approved_config_hash,lic.id AS license_id,lic.seat_limit,lic.ends_on,
         (a.integration_type='lti13' AND a.integration_config ? 'deepLinkingUrl') AS deep_linking
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
  if (!partial && b.integrationType === "lti13" && !LTI_SCOPES.includes(b.dataSharingScope || "none")) return "unsupported_lti_data_scope";
  // Class lists (roster_basic) go to a tool only through NRPS (LTI-03).
  if (!partial && b.integrationType === "lti13" && b.dataSharingScope === "roster_basic" && b.integrationConfig?.namesRoles !== true) return "roster_scope_needs_names_roles";
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
        if (nextType === "lti13" && !LTI_SCOPES.includes(nextScope)) return fail(400, "unsupported_lti_data_scope");
        if (nextType === "lti13" && nextScope === "roster_basic" && nextCfg?.namesRoles !== true) return fail(400, "roster_scope_needs_names_roles");
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
        // Two-person rule (also enforced in PostgreSQL): the registrant can't approve.
        if (a.created_by === req.actor.userId) return fail(409, "lti_second_approver_required");
        if (!validLtiConfig(a.integration_config, { allowInsecureLoopback: config.nodeEnv !== "production" })) return fail(409, "lti_configuration_invalid");
        const fingerprint = ltiConfigFingerprint(a.integration_config, a.data_sharing_scope);
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
        integrationType: r.integration_type, deepLinking: Boolean(r.deep_linking), dataSharingScope: r.data_sharing_scope, coppaCompliant: r.coppa_compliant })),
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
          ? (await client.query("SELECT integration_config,data_sharing_scope,lti_registration_status,lti_approved_config_hash,lti_approved_at FROM apps WHERE id=$1", [a.id])).rows[0]
          : null;
        if (a.integration_type === "lti13" && !validLtiConfig(cfg.integration_config, { allowInsecureLoopback: config.nodeEnv !== "production" })) return fail(409, "lti_configuration_invalid");
        if (a.integration_type === "lti13" && (cfg.lti_registration_status !== "approved" || cfg.lti_approved_config_hash !== ltiConfigFingerprint(cfg.integration_config, a.data_sharing_scope))) return fail(409, "lti_approval_required");
        // LTI-02: open a link a teacher placed on an assignment (visible to this user by RLS).
        const contentLinkId = req.body?.contentLinkId ?? null;
        if (contentLinkId !== null) {
          if (a.integration_type !== "lti13" || !validId(contentLinkId)) return fail(400, "invalid_content_link");
          const link = await client.query("SELECT id FROM lti_content_links WHERE id=$1 AND app_id=$2", [contentLinkId, a.id]);
          if (!link.rowCount) return fail(404, "content_not_available");
        }
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
        // Bind the launch to this browser: the OIDC request that comes back
        // through the tool must present this cookie (see /lti/authorize).
        const binding = newBrowserBinding();
        res.append("Set-Cookie", serializeCookie(bindingCookieName(launch.rows[0].id), binding.value, ltiBindingCookie(300)));
        const hint = makeHint(ltiKey, { l: launch.rows[0].id, a: a.id, u: req.actor.userId, d: req.actor.districtId, r: req.actor.role, s: req.actor.schoolId || null, c: ltiConfigFingerprint(ltiCfg, a.data_sharing_scope), v: new Date(cfg.lti_approved_at).toISOString(), b: binding.hash, ...(contentLinkId ? { k: contentLinkId } : {}) });
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

  // LTI-02: a teacher opens a tool to choose content for one of their assignments.
  app.post("/api/apps/:appId/deep-link", requireSession, requireCsrf, requirePermission("apps", "launch"), async (req, res, next) => {
    if (!validId(req.params.appId) || !validId(req.body?.assignmentId)) return res.status(400).json({ error: "invalid_request" });
    if (!["teacher", "principal"].includes(req.actor.role)) return res.status(403).json({ error: "deep_linking_teachers_only" });
    try {
      const r = await withTenantTransaction(req.actor, async client => {
        const { rows } = await availableApps(client, req.actor, req.params.appId);
        if (!rows.length) return fail(403, "app_not_available");
        const a = rows[0];
        if (a.integration_type !== "lti13") return fail(409, "not_an_lti_tool");
        if (!ltiKey) return fail(503, "lti_not_configured");
        const cfg = (await client.query("SELECT integration_config,lti_registration_status,lti_approved_config_hash,lti_approved_at FROM apps WHERE id=$1", [a.id])).rows[0];
        if (!validLtiConfig(cfg.integration_config, { allowInsecureLoopback: config.nodeEnv !== "production" })) return fail(409, "lti_configuration_invalid");
        if (cfg.lti_registration_status !== "approved" || cfg.lti_approved_config_hash !== ltiConfigFingerprint(cfg.integration_config, a.data_sharing_scope)) return fail(409, "lti_approval_required");
        if (!cfg.integration_config.deepLinkingUrl) return fail(409, "deep_linking_not_registered");
        const can = (await client.query("SELECT eduos_can_manage_assignment($1) AS ok", [req.body.assignmentId])).rows[0];
        if (!can?.ok) return fail(403, "assignment_not_manageable");
        const seat = (await client.query("SELECT eduos_claim_seat($1) AS r", [a.license_id])).rows[0].r;
        if (seat === "exhausted") return fail(409, "no_seats_available");
        if (seat !== "ok") return fail(409, "license_inactive");
        const launch = await client.query(
          `INSERT INTO app_launches(district_id,app_id,license_id,user_id,school_id,role,integration_type,shared_scope)
           VALUES($1,$2,$3,$4,$5,$6,'lti13',$7) RETURNING id`,
          [req.actor.districtId, a.id, a.license_id, req.actor.userId, req.actor.schoolId || null, req.actor.role, a.data_sharing_scope]);
        await audit(client, req, "deep_link_start", "app", a.id, { launchId: launch.rows[0].id, assignmentId: req.body.assignmentId }, req.actor.schoolId || null);
        const ltiCfg = cfg.integration_config, binding = newBrowserBinding();
        res.append("Set-Cookie", serializeCookie(bindingCookieName(launch.rows[0].id), binding.value, ltiBindingCookie(300)));
        const hint = makeHint(ltiKey, { l: launch.rows[0].id, a: a.id, u: req.actor.userId, d: req.actor.districtId, r: req.actor.role, s: req.actor.schoolId || null,
          c: ltiConfigFingerprint(ltiCfg, a.data_sharing_scope), v: new Date(cfg.lti_approved_at).toISOString(), b: binding.hash, m: "dl", g: req.body.assignmentId });
        const u = new URL(ltiCfg.loginUrl);
        u.searchParams.set("iss", issuer); u.searchParams.set("login_hint", launch.rows[0].id);
        u.searchParams.set("target_link_uri", ltiCfg.deepLinkingUrl); u.searchParams.set("lti_message_hint", hint);
        u.searchParams.set("client_id", ltiCfg.clientId);
        return { status: 200, data: { url: u.href } };
      });
      res.setHeader("Cache-Control", "no-store");
      send(res, r);
    } catch (e) { next(e); }
  });

  // The tool returns the browser to /lti/authorize from its own site, possibly
  // as a form POST, so the binding cookie must be SameSite=None (which browsers
  // only accept with Secure). Plain-HTTP development falls back to Lax.
  function ltiBindingCookie(maxAge) {
    const secure = Boolean(config.secureCookies);
    return { httpOnly: true, secure, sameSite: secure ? "none" : "lax", path: "/lti/authorize", maxAge };
  }

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
    // Only the browser that started the launch may complete it. Without this, a
    // copied lti_message_hint (it passes through the tool and the address bar)
    // would let someone else receive this user's id_token.
    const bindingName = validId(hint.l) ? bindingCookieName(hint.l) : null;
    if (!bindingName || !browserBindingMatches(getCookie(req.headers.cookie, bindingName), hint.b))
      return deny(403, "launch_browser_mismatch");
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
        if (typeof hint.c !== "string" || ltiConfigFingerprint(cfg, app.data_sharing_scope) !== hint.c)
          return { error: "lti_registration_changed", status: 409 };
        if (app.lti_registration_status !== "approved" || app.lti_approved_config_hash !== ltiConfigFingerprint(cfg, app.data_sharing_scope))
          return { error: "lti_approval_required", status: 409 };
        if (!app.lti_approved_at || hint.v !== new Date(app.lti_approved_at).toISOString())
          return { error: "lti_approval_changed", status: 409 };
        if (app.integration_type !== "lti13" || p.client_id !== cfg.clientId) return { error: "client_mismatch", status: 400 };
        if (!LTI_SCOPES.includes(app.data_sharing_scope) || (app.data_sharing_scope === "roster_basic" && cfg.namesRoles !== true)) return { error: "unsupported_lti_data_scope", status: 403 };
        if (!Array.isArray(cfg.redirectUris) || !cfg.redirectUris.includes(p.redirect_uri)) return { error: "redirect_uri_not_registered", status: 400 };
        // Claim the launch atomically in the same tenant transaction as the
        // authorization checks. This prevents replay across processes/restarts.
        // LTI-02: Deep Linking request (teacher choosing content) or a placed content link.
        let assignment = null, content = null;
        if (hint.m === "dl") {
          if (!["teacher", "principal"].includes(launch.role) || !cfg.deepLinkingUrl) return { error: "deep_linking_not_allowed", status: 403 };
          assignment = (await client.query("SELECT id,title,eduos_can_manage_assignment(id) AS ok FROM assignments WHERE id=$1", [hint.g])).rows[0];
          if (!assignment?.ok) return { error: "assignment_not_manageable", status: 403 };
        } else if (hint.k !== undefined) {
          if (!validId(hint.k)) return { error: "invalid_or_expired_launch", status: 400 };
          // LTI-03: the assignment's course (when the user can see it) becomes the
          // launch context, and its class list is offered if a teacher shared it.
          content = (await client.query(`SELECT l.id,l.title,l.url,l.custom,co.id AS course_id,co.title AS course_title,
              (SELECT s.id FROM lti_course_sharing s WHERE s.course_id=co.id AND s.app_id=l.app_id) AS sharing_id,
              EXISTS(SELECT 1 FROM eduos_lti_ags_link(l.id, l.app_id)) AS grades_on
             FROM lti_content_links l JOIN assignments x ON x.id=l.assignment_id LEFT JOIN courses co ON co.id=x.course_id
            WHERE l.id=$1 AND l.app_id=$2`, [hint.k, app.id])).rows[0];
          if (!content) return { error: "content_not_available", status: 403 };
        }
        const consumed = await consumeHintDurably(client, hint.d, hint.l, new Date(hint.exp));
        if (!consumed) return { error: "launch_already_used", status: 409 };
        return { app, launch, user, school, assignment, content };
      });
      if (result.error) return deny(result.status, result.error);
      const ctx = result;
      let deepLinking = null;
      if (ctx.assignment) {
        // The data claim comes back inside the tool's signed response: it says
        // which launch, user and assignment the content is for, and is bound to
        // this browser and accepted once.
        const dataId = crypto.randomUUID(), dataBinding = newBrowserBinding();
        const data = makeHint(ltiKey, { t: "dld", i: dataId, l: hint.l, a: hint.a, u: hint.u, d: hint.d, r: hint.r, s: hint.s ?? null, g: ctx.assignment.id,
          c: hint.c, v: hint.v, b: dataBinding.hash }, Date.now(), DEEP_LINK_TTL_MS);
        res.append("Set-Cookie", serializeCookie(`eduos_ltidl_${dataId.replace(/-/g, "")}`, dataBinding.value,
          { ...ltiBindingCookie(DEEP_LINK_TTL_MS / 1000), path: "/lti/deep-link/return" }));
        deepLinking = { returnUrl: `${issuer}/lti/deep-link/return`, data, title: `Add to: ${String(ctx.assignment.title).slice(0, 120)}` };
      }
      const content = ctx.content ? { id: ctx.content.id, title: ctx.content.title, url: ctx.content.url, custom: ctx.content.custom } : null;
      const context = ctx.content?.course_id ? { id: ctx.content.course_id, title: ctx.content.course_title } : null;
      const nrps = context && ctx.content.sharing_id && ctx.app.data_sharing_scope === "roster_basic" && ctx.app.integration_config?.namesRoles === true
        ? { url: `${issuer}/lti/nrps/${ctx.content.sharing_id}/memberships` } : null;
      // LTI-04: the activity's line item, while grade passback is allowed end to end.
      const ags = ctx.content?.grades_on && ctx.app.integration_config?.assignmentGrades === true ? { lineitem: `${issuer}/lti/ags/${ctx.content.id}/lineitem` } : null;
      const idToken = signJwt(ltiKey, launchClaims({ key: ltiKey, issuer, app: ctx.app, launch: { role: ctx.launch.role, districtId: hint.d }, user: ctx.user, school: ctx.school, nonce: p.nonce, deepLinking, content, context, nrps, ags }));
      const esc = v => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const target = new URL(p.redirect_uri);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.append("Set-Cookie", serializeCookie(bindingName, "", ltiBindingCookie(0)));
      // Only the fixed auto-submit script may run (hash, not 'unsafe-inline').
      res.setHeader("Content-Security-Policy", `default-src 'none'; script-src '${AUTO_SUBMIT_SCRIPT_HASH}'; style-src 'unsafe-inline'; form-action ${target.origin}; frame-ancestors 'self'; base-uri 'none'`);
      res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Opening app…</title></head>
<body><main><h1 style="font:16px system-ui">Opening ${esc(ctx.app.name)}…</h1>
<form id="lti" method="post" action="${esc(p.redirect_uri)}"><input type="hidden" name="id_token" value="${esc(idToken)}">${p.state !== undefined ? `<input type="hidden" name="state" value="${esc(p.state)}">` : ""}
<noscript><button type="submit">Continue to ${esc(ctx.app.name)}</button></noscript></form></main>
<script>${AUTO_SUBMIT_SCRIPT}</script></body></html>`);
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
      const parsed = {};
      const appendScalar = (previous, value) => previous === undefined ? value
        : Array.isArray(previous) ? [...previous, value] : [previous, value];
      for (const [key, value] of new URLSearchParams(req.body.toString("utf8"))) {
        if (!allowedFormParameters.has(key)) return res.status(400).type("text/plain").send("LTI launch refused: invalid_request");
        // Assign only fixed protocol properties. Never use a request-controlled
        // key as an object property, even after allowlist validation.
        switch (key) {
          case "scope": parsed.scope = appendScalar(parsed.scope, value); break;
          case "response_type": parsed.response_type = appendScalar(parsed.response_type, value); break;
          case "response_mode": parsed.response_mode = appendScalar(parsed.response_mode, value); break;
          case "prompt": parsed.prompt = appendScalar(parsed.prompt, value); break;
          case "client_id": parsed.client_id = appendScalar(parsed.client_id, value); break;
          case "redirect_uri": parsed.redirect_uri = appendScalar(parsed.redirect_uri, value); break;
          case "login_hint": parsed.login_hint = appendScalar(parsed.login_hint, value); break;
          case "lti_message_hint": parsed.lti_message_hint = appendScalar(parsed.lti_message_hint, value); break;
          case "state": parsed.state = appendScalar(parsed.state, value); break;
          case "nonce": parsed.nonce = appendScalar(parsed.nonce, value); break;
          default: return res.status(400).type("text/plain").send("LTI launch refused: invalid_request");
        }
      }
      req.body = parsed;
      return ltiAuthorize(req, res, next);
    });
  });
  // LTI-02: the tool's Deep Linking response (form POST of a JWT signed by the tool).
  const jwksCache = new Map(); // jwksUrl -> { keys, until }
  async function toolJwks(url, { refresh = false } = {}) {
    const hit = jwksCache.get(url);
    if (hit && hit.until > Date.now() && !refresh) return hit.keys;
    const r = await outboundRequest(url, { options: { allowInsecureLoopback: config.nodeEnv !== "production", allowedHosts: config.integrationsAllowedHosts, timeoutMs: 10_000 } });
    if (r.status !== 200) throw Object.assign(new Error("tool_jwks_unavailable"), { code: "tool_jwks_unavailable" });
    let keys; try { keys = JSON.parse(r.text); } catch { keys = null; }
    if (!keys || !Array.isArray(keys.keys) || keys.keys.length > 20) throw Object.assign(new Error("tool_jwks_invalid"), { code: "tool_jwks_invalid" });
    jwksCache.set(url, { keys, until: Date.now() + 5 * 60_000 });
    return keys;
  }
  const deepLinkPage = (status, heading, lines = []) => (res) => {
    const esc = v => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    res.status(status).setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(heading)}</title></head>
<body><main style="font:16px system-ui;max-width:40rem;margin:2rem auto"><h1 style="font-size:1.25rem">${esc(heading)}</h1>${lines.map(l => `<p>${esc(l)}</p>`).join("")}
<p>You can close this window and return to EduOS.</p></main></body></html>`);
  };
  const expressRawDeepLink = express.raw({ type: "application/x-www-form-urlencoded", limit: "64kb" });
  app.post("/lti/deep-link/return", (req, res, next) => {
    if (!req.is("application/x-www-form-urlencoded")) return deepLinkPage(415, "Content wasn't added", ["The tool sent an unsupported response."])(res);
    expressRawDeepLink(req, res, async error => {
      if (error) return next(error);
      const refuse = (code, status = 400) => deepLinkPage(status, "Content wasn't added", [`Reason: ${code.replace(/_/g, " ")}.`])(res);
      try {
        if (!ltiKey) return refuse("lti_not_configured", 503);
        let jwt = null;
        for (const [k, v] of new URLSearchParams(req.body.toString("utf8"))) { if (k !== "JWT" || jwt !== null) return refuse("invalid_request"); jwt = v; }
        const decoded = decodeJwt(jwt);
        const dataClaim = decoded?.payload?.["https://purl.imsglobal.org/spec/lti-dl/claim/data"];
        const data = typeof dataClaim === "string" ? readHint(ltiKey, dataClaim) : null;
        if (!data || data.t !== "dld" || !validId(data.i) || !validId(data.d) || !validId(data.u) || !validId(data.a) || !validId(data.g)) return refuse("invalid_or_expired_request");
        if (!browserBindingMatches(getCookie(req.headers.cookie, `eduos_ltidl_${data.i.replace(/-/g, "")}`), data.b)) return refuse("browser_mismatch", 403);
        const actor = { districtId: data.d, userId: data.u, role: data.r, schoolId: data.s ?? null };
        const appRow = await withTenantTransaction(actor, c => c.query(
          "SELECT id,name,integration_type,integration_config,data_sharing_scope,lti_registration_status,lti_approved_config_hash,lti_approved_at FROM apps WHERE id=$1 AND status='active'", [data.a]));
        const app_ = appRow.rows[0], cfg = app_?.integration_config;
        if (!app_ || app_.integration_type !== "lti13" || !validLtiConfig(cfg, { allowInsecureLoopback: config.nodeEnv !== "production" }) || !cfg.jwksUrl)
          return refuse("tool_not_available", 409);
        const fp = ltiConfigFingerprint(cfg, app_.data_sharing_scope);
        if (fp !== data.c || app_.lti_registration_status !== "approved" || app_.lti_approved_config_hash !== fp || new Date(app_.lti_approved_at).toISOString() !== data.v)
          return refuse("tool_approval_changed", 409);
        let claims;
        try {
          try { claims = verifyToolJwt(jwt, await toolJwks(cfg.jwksUrl), { clientId: cfg.clientId, issuer }); }
          catch (e) { if (e.code !== "jwt_key_not_found") throw e; claims = verifyToolJwt(jwt, await toolJwks(cfg.jwksUrl, { refresh: true }), { clientId: cfg.clientId, issuer }); }
        } catch (e) { return refuse(e.code || "jwt_invalid", 400); }
        if (claims["https://purl.imsglobal.org/spec/lti/claim/message_type"] !== "LtiDeepLinkingResponse" ||
            claims["https://purl.imsglobal.org/spec/lti/claim/version"] !== "1.3.0" ||
            claims["https://purl.imsglobal.org/spec/lti/claim/deployment_id"] !== cfg.deploymentId ||
            claims["https://purl.imsglobal.org/spec/lti-dl/claim/data"] !== dataClaim) return refuse("response_claims_invalid");
        let items;
        try { items = acceptContentItems(claims["https://purl.imsglobal.org/spec/lti-dl/claim/content_items"], cfg, { allowInsecureLoopback: config.nodeEnv !== "production" }); }
        catch (e) { return refuse(e.code || "content_items_invalid"); }
        const outcome = await withTenantTransaction(actor, async client => {
          const member = await client.query("SELECT 1 FROM memberships WHERE user_id=$1 AND district_id=$2 AND role=$3 AND school_id IS NOT DISTINCT FROM $4::uuid AND status='active'",
            [data.u, data.d, data.r, data.s ?? null]);
          if (!member.rowCount) return { error: "membership_inactive" };
          const asg = (await client.query("SELECT id,title,eduos_can_manage_assignment(id) AS ok FROM assignments WHERE id=$1", [data.g])).rows[0];
          if (!asg?.ok) return { error: "assignment_not_manageable" };
          // The tool must still be assigned and licensed for this teacher.
          if (!(await availableApps(client, actor, data.a)).rows.length) return { error: "app_not_available" };
          try { await client.query("INSERT INTO lti_deep_link_returns(district_id,data_id,app_id) VALUES($1,$2,$3)", [data.d, data.i, data.a]); }
          catch (e) { if (e.code === "23505") return { error: "response_already_used" }; throw e; }
          for (const it of items.accepted)
            await client.query(`INSERT INTO lti_content_links(district_id,assignment_id,app_id,title,description,url,custom,created_by)
              VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [data.d, asg.id, data.a, it.title, it.text, it.url, JSON.stringify(it.custom), data.u]);
          await client.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,school_id)
              VALUES($1,$2,$3,'deep_link_return','assignment',$4,'success',$5,$6)`,
            [data.d, data.u, data.r, asg.id, JSON.stringify({ appId: data.a, added: items.accepted.length, skipped: items.skipped.length,
              lineItemsIgnored: items.accepted.filter(x => x.lineItemIgnored).length }), data.s ?? null]);
          return { title: asg.title };
        });
        if (outcome.error) return refuse(outcome.error, 409);
        res.append("Set-Cookie", serializeCookie(`eduos_ltidl_${data.i.replace(/-/g, "")}`, "", { ...ltiBindingCookie(0), path: "/lti/deep-link/return" }));
        const msg = typeof claims["https://purl.imsglobal.org/spec/lti-dl/claim/msg"] === "string" ? claims["https://purl.imsglobal.org/spec/lti-dl/claim/msg"].slice(0, 300) : null;
        const lines = [`${items.accepted.length} ${items.accepted.length === 1 ? "activity was" : "activities were"} added to "${outcome.title}".`];
        if (items.skipped.length) lines.push(`${items.skipped.length} item${items.skipped.length === 1 ? " was" : "s were"} not added (only links to ${app_.name}'s own site are accepted).`);
        if (items.accepted.some(x => x.lineItemIgnored)) lines.push("Grade passback isn't turned on, so grades from this tool won't come back to EduOS.");
        if (msg) lines.push(`${app_.name} says: ${msg}`);
        return deepLinkPage(200, items.accepted.length ? "Added" : "Nothing was added", lines)(res);
      } catch (e) { next(e); }
    });
  });

  // ---- LTI-03: services for tools (OAuth 2.0 client credentials + NRPS) ----
  // Tools aren't users: these run in a district-only transaction and read
  // through checked SECURITY DEFINER functions.
  async function serviceTx(districtId, callback) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.district_id',$1,true)", [String(districtId)]);
      const out = await callback(client);
      await client.query("COMMIT");
      return out;
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
    finally { client.release(); }
  }
  /**
   * The approved, unchanged registration of an app in a district, with the
   * service scopes it may be granted now, or null. Class lists need NRPS and
   * roster_basic; grades need AGS registered and the district's grade policy on.
   */
  async function serviceRegistration(districtId, appId) {
    if (!validId(districtId) || !validId(appId)) return null;
    const r = await serviceTx(districtId, c => c.query(`SELECT a.integration_config,a.data_sharing_scope,a.lti_approved_config_hash,a.lti_approved_at,
        coalesce((SELECT p.enabled FROM lti_grade_policy p WHERE p.district_id=a.district_id), false) AS grades_on
       FROM apps a WHERE a.id=$1 AND a.status='active' AND a.integration_type='lti13' AND a.lti_registration_status='approved'`, [appId])).then(x => x.rows[0]);
    if (!r) return null;
    const cfg = r.integration_config;
    if (!validLtiConfig(cfg, { allowInsecureLoopback: config.nodeEnv !== "production" }) || !cfg.jwksUrl) return null;
    const fp = ltiConfigFingerprint(cfg, r.data_sharing_scope);
    if (r.lti_approved_config_hash !== fp) return null;
    const scopes = [];
    if (cfg.namesRoles === true && r.data_sharing_scope === "roster_basic") scopes.push(NRPS_SCOPE);
    if (cfg.assignmentGrades === true && r.grades_on) scopes.push(AGS_SCORE_SCOPE, AGS_LINEITEM_READ_SCOPE);
    return scopes.length ? { districtId, cfg, fingerprint: fp, approvedAt: new Date(r.lti_approved_at).toISOString(), scopes } : null;
  }
  /** A service token's claims if it's ours, live, and grants one of `need`. */
  async function serviceToken(req, need) {
    const m = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(req.headers.authorization || "");
    const tok = m && ltiKey ? readHint(ltiKey, m[1]) : null;
    if (!tok || tok.t !== "svc" || !validId(tok.d) || !validId(tok.a) || typeof tok.sc !== "string") return null;
    const granted = tok.sc.split(" ");
    if (!need.some(x => granted.includes(x))) return null;
    // The registration must still be approved and unchanged, and still allowed this scope.
    const reg = await serviceRegistration(tok.d, tok.a);
    if (!reg || reg.fingerprint !== tok.c || reg.approvedAt !== tok.v || !need.some(x => granted.includes(x) && reg.scopes.includes(x))) return null;
    return tok;
  }
  const oauthError = (res, status, error) => { res.status(status).setHeader("Cache-Control", "no-store"); return res.json({ error }); };
  const tokenLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  // Each registration has its own token URL (district and app), so the tool's
  // client ID needs no global uniqueness and the lookup stays inside the
  // district's row-level security.
  app.post("/lti/token/:districtId/:appId", tokenLimiter, (req, res, next) => {
    if (!req.is("application/x-www-form-urlencoded")) return oauthError(res, 400, "invalid_request");
    expressRawUrlencoded(req, res, async error => {
      if (error) return next(error);
      try {
        if (!ltiKey) return oauthError(res, 503, "temporarily_unavailable");
        const f = {};
        for (const [k, v] of new URLSearchParams(req.body.toString("utf8"))) {
          if (!["grant_type", "client_assertion_type", "client_assertion", "scope"].includes(k) || f[k] !== undefined) return oauthError(res, 400, "invalid_request");
          switch (k) { case "grant_type": f.grant_type = v; break; case "client_assertion_type": f.client_assertion_type = v; break;
            case "client_assertion": f.client_assertion = v; break; case "scope": f.scope = v; break; }
        }
        if (f.grant_type !== "client_credentials") return oauthError(res, 400, "unsupported_grant_type");
        if (f.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" || typeof f.client_assertion !== "string") return oauthError(res, 401, "invalid_client");
        const scopes = [...new Set(String(f.scope || "").split(" ").filter(Boolean))];
        if (!scopes.length || scopes.some(x => ![NRPS_SCOPE, AGS_SCORE_SCOPE, AGS_LINEITEM_READ_SCOPE].includes(x))) return oauthError(res, 400, "invalid_scope");
        const reg = await serviceRegistration(req.params.districtId, req.params.appId);
        if (!reg) return oauthError(res, 401, "invalid_client");
        if (scopes.some(x => !reg.scopes.includes(x))) return oauthError(res, 400, "invalid_scope");
        const tokenUrl = `${issuer}/lti/token/${req.params.districtId}/${req.params.appId}`;
        let assertion;
        try {
          try { assertion = verifyClientAssertion(f.client_assertion, await toolJwks(reg.cfg.jwksUrl), { clientId: reg.cfg.clientId, tokenUrl }); }
          catch (e) { if (e.code !== "jwt_key_not_found") throw e; assertion = verifyClientAssertion(f.client_assertion, await toolJwks(reg.cfg.jwksUrl, { refresh: true }), { clientId: reg.cfg.clientId, tokenUrl }); }
        } catch { return oauthError(res, 401, "invalid_client"); }
        const fresh = await serviceTx(reg.districtId, async c => {
          try { await c.query("INSERT INTO lti_service_assertions(district_id,app_id,jti,expires_at) VALUES($1,$2,$3,to_timestamp($4))", [reg.districtId, req.params.appId, assertion.jti, assertion.exp]); }
          catch (e) { if (e.code === "23505") return false; throw e; }
          await c.query("INSERT INTO lti_service_access_log(district_id,app_id,service) VALUES($1,$2,'token')", [reg.districtId, req.params.appId]);
          return true;
        });
        if (!fresh) return oauthError(res, 401, "invalid_client");
        const token = makeHint(ltiKey, { t: "svc", d: reg.districtId, a: req.params.appId, c: reg.fingerprint, v: reg.approvedAt, sc: scopes.join(" ") }, Date.now(), SERVICE_TOKEN_TTL_MS);
        res.setHeader("Cache-Control", "no-store"); res.setHeader("Pragma", "no-cache");
        return res.json({ access_token: token, token_type: "Bearer", expires_in: SERVICE_TOKEN_TTL_MS / 1000, scope: scopes.join(" ") });
      } catch (e) { next(e); }
    });
  });

  // NRPS 2.0 membership container for one shared course.
  app.get("/lti/nrps/:sharingId/memberships", tokenLimiter, async (req, res, next) => {
    const deny = (status, error) => { res.status(status).setHeader("Cache-Control", "no-store"); if (status === 401) res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"'); return res.json({ error }); };
    try {
      if (!ltiKey) return deny(503, "temporarily_unavailable");
      const tok = await serviceToken(req, [NRPS_SCOPE]);
      if (!tok) return deny(401, "invalid_token");
      if (!validId(req.params.sharingId)) return deny(404, "not_found");
      const roleFilter = req.query.role;
      if (roleFilter !== undefined && typeof roleFilter !== "string") return deny(400, "invalid_request");
      const want = roleFilter ? (/^(Learner|Instructor)$/.test(roleFilter.split("#").pop()) ? roleFilter.split("#").pop() : "none") : null;
      let returned = [];
      const rows = await serviceTx(tok.d, async c => {
        const r = (await c.query("SELECT * FROM eduos_lti_nrps_members($1,$2)", [req.params.sharingId, tok.a])).rows;
        returned = r.filter(x => !want || x.lti_role === want);
        // Logged as what the tool actually receives.
        if (r.length) await c.query("INSERT INTO lti_service_access_log(district_id,app_id,course_id,service,members) VALUES($1,$2,$3,'nrps_memberships',$4)",
          [tok.d, tok.a, r[0].course_id, returned.length]);
        return r;
      });
      if (!rows.length) return deny(404, "not_found");
      const role = r => `http://purl.imsglobal.org/vocab/lis/v2/membership#${r}`;
      const members = returned.map(r => ({
        user_id: pairwiseSub(ltiKey, tok.a, r.user_id), status: "Active", roles: [role(r.lti_role)], name: r.display_name, email: r.email }));
      res.setHeader("Cache-Control", "no-store");
      res.type("application/vnd.ims.lti-nrps.v2.membershipcontainer+json");
      return res.send(JSON.stringify({ id: `${issuer}/lti/nrps/${req.params.sharingId}/memberships`,
        context: { id: pairwiseContext(ltiKey, tok.a, rows[0].course_id), title: rows[0].course_title }, members }));
    } catch (e) { next(e); }
  });

  // ---- LTI-04: Assignment and Grade Services ----
  const agsDeny = (res, status, error) => { res.status(status).setHeader("Cache-Control", "no-store"); if (status === 401) res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"'); return res.json({ error }); };
  app.get("/lti/ags/:linkId/lineitem", tokenLimiter, async (req, res, next) => {
    try {
      const tok = await serviceToken(req, [AGS_LINEITEM_READ_SCOPE]);
      if (!tok) return agsDeny(res, 401, "invalid_token");
      if (!validId(req.params.linkId)) return agsDeny(res, 404, "not_found");
      const li = await serviceTx(tok.d, async c => {
        const r = (await c.query("SELECT * FROM eduos_lti_ags_link($1,$2)", [req.params.linkId, tok.a])).rows[0];
        if (r) await c.query("INSERT INTO lti_service_access_log(district_id,app_id,course_id,service) VALUES($1,$2,$3,'ags_lineitem')", [tok.d, tok.a, r.course_id]);
        return r;
      });
      if (!li) return agsDeny(res, 404, "not_found");
      res.setHeader("Cache-Control", "no-store");
      res.type("application/vnd.ims.lis.v2.lineitem+json");
      return res.send(JSON.stringify({ id: `${issuer}/lti/ags/${req.params.linkId}/lineitem`, label: li.title, scoreMaximum: Number(li.points), resourceLinkId: req.params.linkId }));
    } catch (e) { next(e); }
  });
  const scoreBody = express.raw({ type: ["application/vnd.ims.lis.v1.score+json", "application/json"], limit: "8kb" });
  const ACTIVITY = ["Initialized", "Started", "InProgress", "Submitted", "Completed"];
  const GRADING = ["FullyGraded", "Pending", "PendingManual", "Failed", "NotReady"];
  app.post("/lti/ags/:linkId/lineitem/scores", tokenLimiter, (req, res, next) => scoreBody(req, res, async error => {
    if (error) return next(error);
    try {
      const tok = await serviceToken(req, [AGS_SCORE_SCOPE]);
      if (!tok) return agsDeny(res, 401, "invalid_token");
      if (!validId(req.params.linkId)) return agsDeny(res, 404, "not_found");
      let b; try { b = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : ""); } catch { b = null; }
      const num = v => v === undefined || v === null ? null : typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e6 ? v : NaN;
      const given = num(b?.scoreGiven), max = num(b?.scoreMaximum), ts = Date.parse(b?.timestamp);
      if (!b || typeof b !== "object" || typeof b.userId !== "string" || b.userId.length > 64 || Number.isNaN(given) || Number.isNaN(max) ||
          (given !== null && (max === null || max <= 0 || given > max)) || !ACTIVITY.includes(b.activityProgress) || !GRADING.includes(b.gradingProgress) ||
          !Number.isFinite(ts) || ts > Date.now() + 300_000 || (b.comment !== undefined && (typeof b.comment !== "string" || b.comment.length > 1000)))
        return agsDeny(res, 400, "invalid_score");
      const outcome = await serviceTx(tok.d, async c => {
        // The tool names the learner by the per-tool id it saw at launch.
        const learners = (await c.query("SELECT * FROM eduos_lti_ags_learners($1,$2)", [req.params.linkId, tok.a])).rows;
        const who = learners.find(l => pairwiseSub(ltiKey, tok.a, l.user_id) === b.userId);
        if (!who) return learners.length ? "unknown_user" : "not_found";
        const payload = { scoreGiven: given, scoreMaximum: max, activityProgress: b.activityProgress, gradingProgress: b.gradingProgress, timestamp: new Date(ts).toISOString() };
        const r = (await c.query("SELECT eduos_lti_record_score($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) AS o",
          [req.params.linkId, tok.a, who.student_id, given, max, b.activityProgress, b.gradingProgress, b.comment ?? null, new Date(ts), JSON.stringify(payload)])).rows[0].o;
        if (r !== "not_found") await c.query("INSERT INTO lti_service_access_log(district_id,app_id,service) VALUES($1,$2,'ags_score')", [tok.d, tok.a]);
        return r;
      });
      if (outcome === "not_found") return agsDeny(res, 404, "not_found");
      if (outcome === "unknown_user") return agsDeny(res, 422, "user_not_in_activity");
      res.setHeader("Cache-Control", "no-store");
      return res.status(204).end();
    } catch (e) { next(e); }
  }));

  // District guidelines: grade passback on or off, and whether teachers review each score.
  app.get("/api/lti/grade-policy", requireSession, async (req, res, next) => {
    try {
      const p = await withTenantTransaction(req.actor, c => c.query("SELECT enabled,teacher_review_required FROM lti_grade_policy WHERE district_id=$1", [req.actor.districtId]));
      res.json({ data: { enabled: p.rows[0]?.enabled ?? false, teacherReviewRequired: p.rows[0]?.teacher_review_required ?? true, canEdit: isDistrictRole(req.actor.role) } });
    } catch (e) { next(e); }
  });
  app.put("/api/lti/grade-policy", requireSession, requireCsrf, async (req, res, next) => {
    if (!isDistrictRole(req.actor.role)) return res.status(403).json({ error: "district_administrator_required" });
    const { enabled, teacherReviewRequired } = req.body || {};
    if (typeof enabled !== "boolean" || typeof teacherReviewRequired !== "boolean") return res.status(400).json({ error: "invalid_policy" });
    try {
      await withTenantTransaction(req.actor, async c => {
        await c.query(`INSERT INTO lti_grade_policy(district_id,enabled,teacher_review_required,updated_by) VALUES($1,$2,$3,$4)
          ON CONFLICT (district_id) DO UPDATE SET enabled=EXCLUDED.enabled,teacher_review_required=EXCLUDED.teacher_review_required,updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [req.actor.districtId, enabled, teacherReviewRequired, req.actor.userId]);
        await audit(c, req, "update", "lti_grade_policy", req.actor.districtId, { enabled, teacherReviewRequired });
      });
      res.json({ data: { enabled, teacherReviewRequired } });
    } catch (e) { next(e); }
  });

  // School approvals: principals approve for their school; district leads oversee and can revoke.
  app.get("/api/lti/grade-approvals", requireSession, async (req, res, next) => {
    const district = isDistrictRole(req.actor.role);
    if (!district && req.actor.role !== "principal") return res.status(403).json({ error: "forbidden" });
    try {
      const data = await withTenantTransaction(req.actor, async c => {
        const approvals = (await c.query(`SELECT g.id,g.school_id AS "schoolId",sc.name AS "schoolName",g.app_id AS "appId",a.name AS "appName",
            ua.display_name AS "approvedBy",g.approved_at AS "approvedAt",ur.display_name AS "revokedBy",g.revoked_at AS "revokedAt",g.revoke_reason AS "revokeReason",
            (SELECT count(*)::int FROM lti_score_events e JOIN lti_content_links l ON l.id=e.content_link_id JOIN assignments x ON x.id=l.assignment_id
              WHERE e.app_id=g.app_id AND x.school_id=g.school_id AND e.received_at>now()-interval '30 days') AS "scores30d"
           FROM lti_school_grade_approvals g JOIN schools sc ON sc.id=g.school_id JOIN apps a ON a.id=g.app_id
           JOIN users ua ON ua.id=g.approved_by LEFT JOIN users ur ON ur.id=g.revoked_by
          WHERE ($1 OR g.school_id=$2::uuid) ORDER BY g.revoked_at IS NOT NULL, sc.name, a.name LIMIT 500`, [district, req.actor.schoolId || null])).rows;
        // Tools this principal could approve: approved registrations with grade passback, available at the school.
        const tools = district ? [] : (await availableApps(c, req.actor)).rows.filter(a => a.integration_type === "lti13");
        const capable = tools.length ? (await c.query(`SELECT id,name FROM apps WHERE id=ANY($1::uuid[]) AND (integration_config->>'assignmentGrades')='true' AND lti_registration_status='approved'`,
          [tools.map(t => t.id)])).rows : [];
        const policy = (await c.query("SELECT enabled,teacher_review_required FROM lti_grade_policy WHERE district_id=$1", [req.actor.districtId])).rows[0];
        return { policy: { enabled: policy?.enabled ?? false, teacherReviewRequired: policy?.teacher_review_required ?? true }, approvals,
          candidates: capable.map(x => ({ appId: x.id, appName: x.name })), canApprove: !district };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { next(e); }
  });
  app.put("/api/lti/grade-approvals", requireSession, requireCsrf, async (req, res, next) => {
    const { appId, approved, schoolId = req.actor.schoolId, reason = null } = req.body || {};
    if (!validId(appId) || typeof approved !== "boolean" || !validId(schoolId) || (reason !== null && (typeof reason !== "string" || reason.length > 500)))
      return res.status(400).json({ error: "invalid_request" });
    const district = isDistrictRole(req.actor.role);
    if (approved && req.actor.role !== "principal") return res.status(403).json({ error: district ? "schools_approve_grade_passback" : "forbidden" });
    if (!approved && !district && !(req.actor.role === "principal" && schoolId === req.actor.schoolId)) return res.status(403).json({ error: "forbidden" });
    if (approved && schoolId !== req.actor.schoolId) return res.status(403).json({ error: "own_school_only" });
    try {
      const r = await withTenantTransaction(req.actor, async c => {
        if (approved) {
          const avail = (await availableApps(c, req.actor, appId)).rows[0];
          const cfg = avail && (await c.query("SELECT integration_config,lti_registration_status FROM apps WHERE id=$1", [appId])).rows[0];
          if (!cfg || avail.integration_type !== "lti13" || cfg.lti_registration_status !== "approved" || cfg.integration_config?.assignmentGrades !== true)
            return fail(409, "tool_not_registered_for_grades");
          try { await c.query("INSERT INTO lti_school_grade_approvals(district_id,school_id,app_id,approved_by) VALUES($1,$2,$3,$4)", [req.actor.districtId, schoolId, appId, req.actor.userId]); }
          catch (e) { if (e.code !== "23505") throw e; }
        } else {
          const done = await c.query(`UPDATE lti_school_grade_approvals SET revoked_by=$4,revoked_at=now(),revoke_reason=$5
              WHERE district_id=$1 AND school_id=$2 AND app_id=$3 AND revoked_at IS NULL`, [req.actor.districtId, schoolId, appId, req.actor.userId, reason]);
          if (!done.rowCount) return fail(404, "approval_not_found");
        }
        await audit(c, req, approved ? "approve_grade_passback" : "revoke_grade_passback", "app", appId, { schoolId, reason }, schoolId);
        return { status: 200, data: { appId, schoolId, approved } };
      });
      send(res, r);
    } catch (e) { next(e); }
  });

  // A teacher turns grade passback on for one placed activity.
  app.put("/api/lti/content-links/:id/grades", requireSession, requireCsrf, async (req, res, next) => {
    if (!validId(req.params.id) || typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "invalid_request" });
    try {
      const r = await withTenantTransaction(req.actor, async c => {
        const l = (await c.query(`SELECT l.id,l.app_id,l.assignment_id,x.school_id,eduos_can_manage_assignment(l.assignment_id) AS manage,
            a.integration_config,a.lti_registration_status FROM lti_content_links l JOIN assignments x ON x.id=l.assignment_id JOIN apps a ON a.id=l.app_id WHERE l.id=$1`, [req.params.id])).rows[0];
        if (!l?.manage) return fail(404, "content_link_not_found");
        if (req.body.enabled) {
          const policy = (await c.query("SELECT enabled FROM lti_grade_policy WHERE district_id=$1", [req.actor.districtId])).rows[0];
          if (!policy?.enabled) return fail(409, "district_grade_passback_off");
          if (l.lti_registration_status !== "approved" || l.integration_config?.assignmentGrades !== true) return fail(409, "tool_not_registered_for_grades");
          const ok = await c.query("SELECT 1 FROM lti_school_grade_approvals WHERE school_id=$1 AND app_id=$2 AND revoked_at IS NULL", [l.school_id, l.app_id]);
          if (!ok.rowCount) return fail(409, "school_has_not_approved_tool");
        }
        await c.query("UPDATE lti_content_links SET grades_enabled_by=$2,grades_enabled_at=$3 WHERE id=$1",
          [l.id, req.body.enabled ? req.actor.userId : null, req.body.enabled ? new Date() : null]);
        await audit(c, req, req.body.enabled ? "enable_grade_passback" : "disable_grade_passback", "assignment", l.assignment_id, { contentLinkId: l.id }, l.school_id);
        return { status: 200, data: { id: l.id, gradesEnabled: req.body.enabled } };
      });
      send(res, r);
    } catch (e) { next(e); }
  });

  // Teachers review tool scores: record into the gradebook, or dismiss.
  app.get("/api/lti/scores", requireSession, async (req, res, next) => {
    if (!validId(req.query?.assignmentId)) return res.status(400).json({ error: "invalid_assignment_id" });
    try {
      const rows = await withTenantTransaction(req.actor, c => c.query(`SELECT s.id,s.student_id AS "studentId",st.display_name AS "studentName",l.title AS activity,a.name AS "appName",
          s.score_given::float8 AS "scoreGiven",s.score_maximum::float8 AS "scoreMaximum",s.grading_progress AS "gradingProgress",s.comment,s.status,
          s.tool_timestamp AS "receivedFor",sub.score::float8 AS "gradebookScore",sub.grade_source AS "gradebookSource"
         FROM lti_scores s JOIN students st ON st.id=s.student_id JOIN lti_content_links l ON l.id=s.content_link_id JOIN apps a ON a.id=l.app_id
         LEFT JOIN assignment_submissions sub ON sub.assignment_id=s.assignment_id AND sub.student_id=s.student_id AND sub.graded_at IS NOT NULL
        WHERE s.assignment_id=$1 ORDER BY st.display_name LIMIT 1000`, [req.query.assignmentId]));
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: rows.rows });
    } catch (e) { next(e); }
  });
  app.post("/api/lti/scores/:id/:action", requireSession, requireCsrf, async (req, res, next) => {
    if (!validId(req.params.id) || !["record", "dismiss"].includes(req.params.action)) return res.status(404).json({ error: "not_found" });
    try {
      const r = await withTenantTransaction(req.actor, async c => {
        const s = (await c.query(`SELECT s.*,x.points_possible FROM lti_scores s JOIN assignments x ON x.id=s.assignment_id WHERE s.id=$1 FOR UPDATE OF s`, [req.params.id])).rows[0];
        if (!s) return fail(404, "score_not_found");
        if (req.params.action === "dismiss") {
          await c.query("UPDATE lti_scores SET status='dismissed',reviewed_by=$2,reviewed_at=now(),updated_at=now() WHERE id=$1", [s.id, req.actor.userId]);
        } else {
          if (s.status === "not_final" || s.score_given === null) return fail(409, "score_not_final");
          const existing = (await c.query("SELECT grade_source FROM assignment_submissions WHERE assignment_id=$1 AND student_id=$2 AND graded_at IS NOT NULL",
            [s.assignment_id, s.student_id])).rows[0];
          // A teacher's own grade is replaced only when they say so.
          if (existing && existing.grade_source !== "lti" && req.body?.overwrite !== true) return fail(409, "teacher_grade_exists");
          const ratio = Math.min(Number(s.score_given) / Number(s.score_maximum), 1);
          await c.query(`INSERT INTO assignment_submissions(district_id,assignment_id,student_id,score,points_earned,graded_by,graded_at,grade_source)
              VALUES($1,$2,$3,$4,$5,$6,now(),'lti')
              ON CONFLICT (assignment_id,student_id) DO UPDATE SET score=EXCLUDED.score,points_earned=EXCLUDED.points_earned,graded_by=EXCLUDED.graded_by,graded_at=now(),grade_source='lti'`,
            [req.actor.districtId, s.assignment_id, s.student_id, Math.round(ratio * 10000) / 100, Math.round(ratio * Number(s.points_possible) * 100) / 100, req.actor.userId]);
          await c.query("UPDATE lti_scores SET status='recorded',reviewed_by=$2,reviewed_at=now(),updated_at=now() WHERE id=$1", [s.id, req.actor.userId]);
        }
        await audit(c, req, req.params.action === "record" ? "record_tool_score" : "dismiss_tool_score", "assignment", s.assignment_id,
          { scoreId: s.id, studentId: s.student_id, overwrite: req.body?.overwrite === true });
        return { status: 200, data: { id: s.id, status: req.params.action === "record" ? "recorded" : "dismissed" } };
      });
      send(res, r);
    } catch (e) { next(e); }
  });

  // Teachers choose, per course, which NRPS tools may read the class list.
  app.get("/api/lti/course-sharing", requireSession, async (req, res, next) => {
    if (!validId(req.query?.courseId)) return res.status(400).json({ error: "invalid_course_id" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const course = (await client.query("SELECT id,eduos_can_manage_course(id) AS manage FROM courses WHERE id=$1", [req.query.courseId])).rows[0];
        if (!course) return null;
        const shared = (await client.query(`SELECT s.app_id AS "appId",a.name AS "appName",s.enabled_at AS "enabledAt",u.display_name AS "enabledBy"
            FROM lti_course_sharing s JOIN apps a ON a.id=s.app_id JOIN users u ON u.id=s.enabled_by WHERE s.course_id=$1 ORDER BY a.name`, [course.id])).rows;
        let candidates = [];
        if (course.manage) {
          const avail = (await availableApps(client, req.actor)).rows.filter(a => a.integration_type === "lti13" && a.data_sharing_scope === "roster_basic");
          const cfgs = avail.length ? (await client.query("SELECT id,integration_config FROM apps WHERE id=ANY($1::uuid[])", [avail.map(a => a.id)])).rows : [];
          candidates = avail.filter(a => cfgs.find(c => c.id === a.id)?.integration_config?.namesRoles === true).map(a => ({ appId: a.id, appName: a.name }));
        }
        return { canManage: course.manage, shared, candidates };
      });
      if (!out) return res.status(404).json({ error: "course_not_found" });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: out });
    } catch (e) { next(e); }
  });
  app.put("/api/lti/course-sharing", requireSession, requireCsrf, async (req, res, next) => {
    const { courseId, appId, enabled } = req.body || {};
    if (!validId(courseId) || !validId(appId) || typeof enabled !== "boolean") return res.status(400).json({ error: "invalid_request" });
    try {
      const r = await withTenantTransaction(req.actor, async client => {
        const course = (await client.query("SELECT id,eduos_can_manage_course(id) AS manage FROM courses WHERE id=$1", [courseId])).rows[0];
        if (!course?.manage) return fail(403, "course_not_manageable");
        if (!enabled) {
          await client.query("DELETE FROM lti_course_sharing WHERE course_id=$1 AND app_id=$2", [courseId, appId]);
        } else {
          const { rows } = await availableApps(client, req.actor, appId);
          const a = rows[0];
          if (!a || a.integration_type !== "lti13") return fail(403, "app_not_available");
          const cfg = (await client.query("SELECT integration_config,lti_registration_status,lti_approved_config_hash FROM apps WHERE id=$1", [appId])).rows[0];
          if (a.data_sharing_scope !== "roster_basic" || cfg.integration_config?.namesRoles !== true) return fail(409, "tool_not_approved_for_class_lists");
          if (cfg.lti_registration_status !== "approved" || cfg.lti_approved_config_hash !== ltiConfigFingerprint(cfg.integration_config, a.data_sharing_scope)) return fail(409, "lti_approval_required");
          await client.query("INSERT INTO lti_course_sharing(district_id,course_id,app_id,enabled_by) VALUES($1,$2,$3,$4) ON CONFLICT (district_id,course_id,app_id) DO NOTHING",
            [req.actor.districtId, courseId, appId, req.actor.userId]);
        }
        await audit(client, req, enabled ? "share_class_list" : "stop_sharing_class_list", "course", courseId, { appId });
        return { status: 200, data: { courseId, appId, enabled } };
      });
      send(res, r);
    } catch (e) { next(e); }
  });

  // Links on the assignments of one course (or one assignment) that this user can see.
  app.get("/api/lti/content-links", requireSession, async (req, res, next) => {
    const { courseId = null, assignmentId = null } = req.query || {};
    if ((courseId === null) === (assignmentId === null) || (courseId !== null && !validId(courseId)) || (assignmentId !== null && !validId(assignmentId)))
      return res.status(400).json({ error: "courseId_or_assignmentId_required" });
    try {
      const rows = await withTenantTransaction(req.actor, client => client.query(
        `SELECT l.id,l.assignment_id AS "assignmentId",l.app_id AS "appId",a.name AS "appName",l.title,l.description,l.created_at AS "createdAt",
                eduos_can_manage_assignment(l.assignment_id) AS "canRemove",(l.grades_enabled_at IS NOT NULL) AS "gradesEnabled",
                (a.integration_config->>'assignmentGrades')='true' AS "gradesCapable"
           FROM lti_content_links l JOIN apps a ON a.id=l.app_id JOIN assignments x ON x.id=l.assignment_id
          WHERE ($1::uuid IS NULL OR x.course_id=$1::uuid) AND ($2::uuid IS NULL OR l.assignment_id=$2::uuid)
          ORDER BY l.created_at LIMIT 500`, [courseId, assignmentId]));
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: rows.rows });
    } catch (e) { next(e); }
  });
  app.delete("/api/lti/content-links/:id", requireSession, requireCsrf, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    try {
      const r = await withTenantTransaction(req.actor, async client => {
        const gone = await client.query("DELETE FROM lti_content_links WHERE id=$1 RETURNING assignment_id", [req.params.id]);
        if (!gone.rowCount) return fail(404, "content_link_not_found");
        await audit(client, req, "remove_content_link", "assignment", gone.rows[0].assignment_id, { contentLinkId: req.params.id });
        return { status: 200, data: { removed: true } };
      });
      send(res, r);
    } catch (e) { next(e); }
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
import rateLimit from "express-rate-limit";
const expressRawUrlencoded = express.raw({ type: "application/x-www-form-urlencoded", limit: "16kb" });
