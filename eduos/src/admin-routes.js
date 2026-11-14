// District administration API (32.1.0): schools, users and memberships.
//
// Before 32.1.0 there was no way to provision anyone except direct SQL, so a
// fresh deployment could not be used. Rules:
//  - Superintendents manage schools and every account in their district.
//  - Principals may create and enable/disable teacher, parent and pupil
//    memberships at their own school (never leadership roles, SROs, or themselves).
//  - SRO membership is district-controlled: superintendent and district IT
//    administrators may provision/disable SROs; principals cannot grant or revoke it.
//  - An identity (OIDC issuer + subject) already provisioned in another
//    district is refused: users are global rows, so this API never edits or
//    exposes another district's account.
//  - Disabling a membership or user takes effect on the next request, because
//    requireSession re-checks membership and user status (no cache by default).
//  - Every change is audited in the same transaction.
//  - 32.2.0: IT administrators (district-wide, no student data) manage schools
//    and teacher, parent and pupil accounts at any school. They cannot create or
//    change superintendent or IT-admin accounts, nor give themselves a role.
//  - 32.2.0: optional district caps (district_settings; NULL = unlimited) are
//    enforced when schools and users are created.
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission, isDistrictRole } from "./policy.js";
import { pageOf, pageSql, paged } from "./paging.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validId = v => typeof v === "string" && UUID_RE.test(v);
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.trim().length <= max;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUBJECT_RE = /^[\x21-\x7e]{1,255}$/;
export const ROLES = ["superintendent", "it_admin", "principal", "teacher", "parent", "pupil", "driver", "sro", "librarian", "vice_principal", "counselor", "nurse", "maintenance", "lunch_staff"];
const SCHOOL_LEVELS = ["elementary", "middle", "high", "k8", "k12", "other"];
const PRINCIPAL_MANAGED = ["teacher", "parent", "pupil", "driver", "librarian", "vice_principal", "counselor", "nurse", "maintenance", "lunch_staff"];

const audit = (client, req, action, type, id, detail = null) => client.query(
  `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
   VALUES($1,$2,$3,$4,$5,$6,'success',$7,$8)`,
  [req.actor.districtId, req.actor.userId, req.actor.role, action, type, id, detail, req.requestId]);

const IT_MANAGED = ["principal", "teacher", "parent", "pupil", "driver", "sro", "librarian", "vice_principal", "counselor", "nurse", "maintenance", "lunch_staff"];
function canManage(actor, role, schoolId) {
  if (actor.role === "superintendent") return true;
  if (actor.role === "it_admin") return IT_MANAGED.includes(role);
  return actor.role === "principal" && PRINCIPAL_MANAGED.includes(role) && schoolId === actor.schoolId;
}
async function sroPolicyAllows(client, districtId, actorRole, schoolId) {
  const result = await client.query(
    `SELECT allowed_school_ids, require_superintendent_approval
       FROM sro_district_policies WHERE district_id=$1`, [districtId]);
  const policy = result.rows[0];
  if (!policy) return true; // No district policy row means legacy allow-all behavior.
  if (policy.require_superintendent_approval && actorRole !== "superintendent") return false;
  return policy.allowed_school_ids === null || policy.allowed_school_ids.includes(schoolId);
}

function membershipError(role, schoolId) {
  if (!ROLES.includes(role)) return "invalid_role";
  if (isDistrictRole(role) && schoolId) return "district_role_has_no_school";
  if (!isDistrictRole(role) && !validId(schoolId)) return "school_required";
  return null;
}
const CAP_KEYS = { maxSchools: "max_schools", maxStudents: "max_students", maxUsers: "max_users", maxActiveWebhooks: "max_active_webhooks", maxApps: "max_apps" };
export async function districtCapReached(client, districtId, key, countSql) {
  const cap = (await client.query(`SELECT ${CAP_KEYS[key]} AS v FROM district_settings WHERE district_id=$1`, [districtId])).rows[0]?.v ?? null;
  if (cap === null) return false;
  const n = (await client.query(countSql, [districtId])).rows[0].n;
  return Number(n) >= cap;
}
const fail = (status, error) => ({ status, error });

// 32.5.0: IANA time zone for the school's "today" (bus runs, pick-up).
export function validTimeZone(tz) {
  if (typeof tz !== "string" || tz.length > 64 || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

export function registerAdminRoutes(app) {
  // 35.6.0: district-owned SRO deployment controls. Only the superintendent
  // can change policy; district IT can inspect it to understand provisioning rules.
  app.get("/api/admin/sro-policy", requireSession, async (req, res, next) => {
    if (!isDistrictRole(req.actor.role)) return res.status(403).json({ error: "district_administrator_required" });
    try {
      const result = await withTenantTransaction(req.actor, client => client.query(
        `SELECT allowed_school_ids,require_superintendent_approval,updated_at
           FROM sro_district_policies WHERE district_id=$1`, [req.actor.districtId]));
      const policy = result.rows[0] || { allowed_school_ids: null, require_superintendent_approval: false, updated_at: null };
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: { allowedSchoolIds: policy.allowed_school_ids, allSchoolsAllowed: policy.allowed_school_ids === null,
        requireSuperintendentApproval: policy.require_superintendent_approval, updatedAt: policy.updated_at } });
    } catch (e) { next(e); }
  });

  app.put("/api/admin/sro-policy", requireSession, requireCsrf, async (req, res, next) => {
    if (req.actor.role !== "superintendent") return res.status(403).json({ error: "superintendent_required" });
    const { allowedSchoolIds = null, requireSuperintendentApproval = false } = req.body || {};
    if ((allowedSchoolIds !== null && (!Array.isArray(allowedSchoolIds) || allowedSchoolIds.length > 500 ||
        !allowedSchoolIds.every(validId) || new Set(allowedSchoolIds).size !== allowedSchoolIds.length)) ||
        typeof requireSuperintendentApproval !== "boolean")
      return res.status(400).json({ error: "invalid_sro_policy" });
    try {
      const result = await withTenantTransaction(req.actor, async client => {
        if (allowedSchoolIds !== null && allowedSchoolIds.length) {
          const schools = await client.query("SELECT id FROM schools WHERE district_id=$1 AND status='active' AND id=ANY($2::uuid[])",
            [req.actor.districtId, allowedSchoolIds]);
          if (schools.rowCount !== allowedSchoolIds.length) return fail(400, "school_scope_invalid");
        }
        const saved = await client.query(
          `INSERT INTO sro_district_policies(district_id,allowed_school_ids,require_superintendent_approval,updated_by)
           VALUES($1,$2,$3,$4) ON CONFLICT(district_id) DO UPDATE SET
             allowed_school_ids=EXCLUDED.allowed_school_ids,
             require_superintendent_approval=EXCLUDED.require_superintendent_approval,
             updated_at=now(),updated_by=EXCLUDED.updated_by
           RETURNING allowed_school_ids,require_superintendent_approval,updated_at`,
          [req.actor.districtId, allowedSchoolIds, requireSuperintendentApproval, req.actor.userId]);
        await audit(client, req, "update", "sro_district_policy", req.actor.districtId,
          JSON.stringify({ allowedSchoolIds, requireSuperintendentApproval }));
        return { status: 200, data: saved.rows[0] };
      });
      res.status(result.status).json(result.error ? { error: result.error } : { data: result.data });
    } catch (e) { next(e); }
  });

  // ---- schools ----
  app.post("/api/schools", requireSession, requireCsrf, requirePermission("schools", "create"), async (req, res, next) => {
    const { name, schoolLevel = null } = req.body || {};
    if (!text(name, 160) || (schoolLevel !== null && !SCHOOL_LEVELS.includes(schoolLevel)))
      return res.status(400).json({ error: "invalid_school", schoolLevels: SCHOOL_LEVELS });
    try {
      const row = await withTenantTransaction(req.actor, async client => {
        const dup = await client.query("SELECT 1 FROM schools WHERE lower(name)=lower($1)", [name.trim()]);
        if (dup.rowCount) return fail(409, "school_name_exists");
        if (await districtCapReached(client, req.actor.districtId, "maxSchools", "SELECT count(*) AS n FROM schools WHERE district_id=$1 AND status='active'"))
          return fail(409, "district_limit_reached");
        const created = await client.query(
          `INSERT INTO schools(district_id,name,school_level) VALUES($1,$2,$3) RETURNING id,name,school_level,status`,
          [req.actor.districtId, name.trim(), schoolLevel]);
        await audit(client, req, "create", "school", created.rows[0].id, JSON.stringify({ name: name.trim() }));
        return { status: 201, data: created.rows[0] };
      });
      res.status(row.status).json(row.error ? { error: row.error } : { data: row.data });
    } catch (e) { next(e); }
  });

  app.patch("/api/schools/:schoolId", requireSession, requireCsrf, requirePermission("schools", "create"), async (req, res, next) => {
    if (!validId(req.params.schoolId)) return res.status(400).json({ error: "invalid_school_id" });
    const { name, schoolLevel, status, timezone } = req.body || {};
    if ((name !== undefined && !text(name, 160)) || (schoolLevel !== undefined && schoolLevel !== null && !SCHOOL_LEVELS.includes(schoolLevel)) ||
        (status !== undefined && !["active", "inactive"].includes(status)) || (timezone !== undefined && !validTimeZone(timezone)) ||
        [name, schoolLevel, status, timezone].every(v => v === undefined))
      return res.status(400).json({ error: "invalid_school_update" });
    try {
      const row = await withTenantTransaction(req.actor, async client => {
        const updated = await client.query(
          `UPDATE schools SET name=COALESCE($2,name), school_level=CASE WHEN $4 THEN $3 ELSE school_level END, status=COALESCE($5,status),
                  timezone=COALESCE($6,timezone)
            WHERE id=$1 RETURNING id,name,school_level,status,timezone`,
          [req.params.schoolId, name?.trim() ?? null, schoolLevel ?? null, schoolLevel !== undefined, status ?? null, timezone ?? null]);
        if (!updated.rowCount) return fail(404, "school_not_found");
        await audit(client, req, "update", "school", req.params.schoolId, JSON.stringify({ name, schoolLevel, status, timezone }));
        return { status: 200, data: updated.rows[0] };
      });
      res.status(row.status).json(row.error ? { error: row.error } : { data: row.data });
    } catch (e) { next(e); }
  });

  // ---- users and memberships ----
  // 32.2.0: paged by user (?limit, ?offset; was a fixed 2,000 memberships),
  // with ?q= name/email search and ?schoolId= for district roles.
  app.get("/api/users", requireSession, async (req, res, next) => {
    if (!["superintendent", "it_admin", "principal"].includes(req.actor.role)) return res.status(403).json({ error: "administrator_required" });
    const role = req.query.role || null;
    if (role && !ROLES.includes(role)) return res.status(400).json({ error: "invalid_role" });
    const schoolFilter = req.query.schoolId || null;
    if (schoolFilter && !validId(schoolFilter)) return res.status(400).json({ error: "invalid_school_id" });
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const pgn = pageOf(req);
    const district = isDistrictRole(req.actor.role);
    try {
      const rows = await withTenantTransaction(req.actor, client => client.query(
        `WITH page AS (
           SELECT u.id, u.display_name, count(*) OVER() AS total
             FROM users u
            WHERE EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.district_id=$1
                           AND ($2::text IS NULL OR m.role=$2) AND ($3 OR m.school_id=$4)
                           AND ($5::uuid IS NULL OR m.school_id=$5))
              AND ($6::text='' OR u.display_name ILIKE '%'||$7||'%' OR u.email ILIKE '%'||$7||'%')
            ORDER BY u.display_name,u.id ${pageSql(pgn)})
         SELECT u.id AS user_id,u.display_name,u.email,u.status AS user_status,u.oidc_subject,page.total,
                m.id AS membership_id,m.role,m.school_id,sc.name AS school_name,m.status,m.is_default
           FROM page JOIN users u ON u.id=page.id
           JOIN memberships m ON m.user_id=u.id AND m.district_id=$1 AND ($3 OR m.school_id=$4)
           LEFT JOIN schools sc ON sc.id=m.school_id
          ORDER BY u.display_name,u.id,m.role`,
        [req.actor.districtId, role, district, req.actor.schoolId, schoolFilter, q, q.replace(/[\\%_]/g, m => "\\" + m)]));
      const users = new Map();
      let total = rows.rows.length ? Number(rows.rows[0].total) : (pgn.offset ? null : 0);
      for (const r of rows.rows) {
        if (!users.has(r.user_id)) users.set(r.user_id, { id: r.user_id, displayName: r.display_name, email: r.email, status: r.user_status,
          oidcSubject: district ? r.oidc_subject : undefined, memberships: [] });
        users.get(r.user_id).memberships.push({ id: r.membership_id, role: r.role, schoolId: r.school_id, schoolName: r.school_name, status: r.status, isDefault: r.is_default });
      }
      const out = paged([...users.values()], pgn, { total });
      res.setHeader("Cache-Control", "no-store");
      res.json({ ...out, roles: ROLES });
    } catch (e) { next(e); }
  });

  app.post("/api/users", requireSession, requireCsrf, async (req, res, next) => {
    const { displayName, email, oidcSubject, oidcIssuer = config.oidcIssuer, role, schoolId = null } = req.body || {};
    if (!text(displayName, 160) || typeof email !== "string" || email.trim().length > 320 || !EMAIL_RE.test(email.trim()) ||
        typeof oidcSubject !== "string" || !SUBJECT_RE.test(oidcSubject) || typeof oidcIssuer !== "string" || !/^https?:\/\/\S{1,500}$/.test(oidcIssuer))
      return res.status(400).json({ error: "invalid_user" });
    const problem = membershipError(role, schoolId);
    if (problem) return res.status(400).json({ error: problem });
    if (!canManage(req.actor, role, schoolId)) return res.status(403).json({ error: "cannot_manage_role_or_school" });
    try {
      const result = await withTenantTransaction(req.actor, async client => {
        if (schoolId) {
          const school = await client.query("SELECT 1 FROM schools WHERE id=$1 AND status='active'", [schoolId]);
          if (!school.rowCount) return fail(404, "school_not_found");
        }
        if (role === "sro" && !(await sroPolicyAllows(client, req.actor.districtId, req.actor.role, schoolId)))
          return fail(403, "sro_district_policy_restriction");
        if (await districtCapReached(client, req.actor.districtId, "maxUsers", "SELECT count(*) AS n FROM district_users WHERE district_id=$1"))
          return fail(409, "district_limit_reached");
        const existing = await client.query("SELECT id FROM users WHERE oidc_issuer=$1 AND oidc_subject=$2", [oidcIssuer.replace(/\/$/, ""), oidcSubject]);
        let userId = existing.rows[0]?.id;
        if (userId) {
          const elsewhere = await client.query("SELECT 1 FROM memberships WHERE user_id=$1 AND district_id<>$2 LIMIT 1", [userId, req.actor.districtId]);
          if (elsewhere.rowCount) return fail(409, "identity_provisioned_in_another_district");
          return fail(409, "user_exists_add_membership_instead");
        }
        userId = (await client.query(
          `INSERT INTO users(oidc_issuer,oidc_subject,display_name,email) VALUES($1,$2,$3,$4) RETURNING id`,
          [oidcIssuer.replace(/\/$/, ""), oidcSubject, displayName.trim(), email.trim().toLowerCase()])).rows[0].id;
        const m = await client.query(
          `INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES($1,$2,$3,$4,true) RETURNING id`,
          [userId, req.actor.districtId, schoolId, role]);
        await audit(client, req, "create", "user", userId, JSON.stringify({ role, schoolId }));
        return { status: 201, data: { id: userId, displayName: displayName.trim(), email: email.trim().toLowerCase(), membershipId: m.rows[0].id, role, schoolId } };
      });
      res.status(result.status).json(result.error ? { error: result.error } : { data: result.data });
    } catch (e) {
      if (e.code === "23505") return res.status(409).json({ error: "duplicate_user_or_membership" });
      next(e);
    }
  });

  app.post("/api/users/:userId/memberships", requireSession, requireCsrf, async (req, res, next) => {
    if (!validId(req.params.userId)) return res.status(400).json({ error: "invalid_user_id" });
    const { role, schoolId = null } = req.body || {};
    const problem = membershipError(role, schoolId);
    if (problem) return res.status(400).json({ error: problem });
    if (!canManage(req.actor, role, schoolId)) return res.status(403).json({ error: "cannot_manage_role_or_school" });
    // Only a superintendent may add a role to their own account.
    if (req.params.userId === req.actor.userId && req.actor.role !== "superintendent") return res.status(403).json({ error: "cannot_grant_self" });
    try {
      const result = await withTenantTransaction(req.actor, async client => {
        const inDistrict = await client.query("SELECT 1 FROM memberships WHERE user_id=$1 AND district_id=$2 LIMIT 1", [req.params.userId, req.actor.districtId]);
        if (!inDistrict.rowCount) return fail(404, "user_not_found");
        if (schoolId && !(await client.query("SELECT 1 FROM schools WHERE id=$1 AND status='active'", [schoolId])).rowCount) return fail(404, "school_not_found");
        if (role === "sro" && !(await sroPolicyAllows(client, req.actor.districtId, req.actor.role, schoolId)))
          return fail(403, "sro_district_policy_restriction");
        const m = await client.query(
          `INSERT INTO memberships(user_id,district_id,school_id,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
          [req.params.userId, req.actor.districtId, schoolId, role]);
        if (!m.rowCount) return fail(409, "membership_exists");
        await audit(client, req, "create", "membership", m.rows[0].id, JSON.stringify({ userId: req.params.userId, role, schoolId }));
        return { status: 201, data: { id: m.rows[0].id, role, schoolId } };
      });
      res.status(result.status).json(result.error ? { error: result.error } : { data: result.data });
    } catch (e) { next(e); }
  });

  app.patch("/api/memberships/:membershipId", requireSession, requireCsrf, async (req, res, next) => {
    if (!validId(req.params.membershipId)) return res.status(400).json({ error: "invalid_membership_id" });
    const { status } = req.body || {};
    if (!["active", "disabled"].includes(status)) return res.status(400).json({ error: "invalid_status" });
    try {
      const result = await withTenantTransaction(req.actor, async client => {
        const found = await client.query("SELECT user_id,role,school_id FROM memberships WHERE id=$1 AND district_id=$2 FOR UPDATE",
          [req.params.membershipId, req.actor.districtId]);
        if (!found.rowCount) return fail(404, "membership_not_found");
        const m = found.rows[0];
        if (m.user_id === req.actor.userId) return fail(409, "cannot_change_own_membership");
        if (!canManage(req.actor, m.role, m.school_id)) return fail(403, "cannot_manage_role_or_school");
        if (m.role === "sro" && status === "active" && !(await sroPolicyAllows(client, req.actor.districtId, req.actor.role, m.school_id)))
          return fail(403, "sro_district_policy_restriction");
        await client.query("UPDATE memberships SET status=$2 WHERE id=$1", [req.params.membershipId, status]);
        await audit(client, req, status === "active" ? "enable" : "disable", "membership", req.params.membershipId, JSON.stringify({ userId: m.user_id, role: m.role }));
        return { status: 200, data: { id: req.params.membershipId, status } };
      });
      res.status(result.status).json(result.error ? { error: result.error } : { data: result.data });
    } catch (e) { next(e); }
  });

  app.patch("/api/users/:userId", requireSession, requireCsrf, async (req, res, next) => {
    if (!isDistrictRole(req.actor.role)) return res.status(403).json({ error: "district_administrator_required" });
    if (!validId(req.params.userId)) return res.status(400).json({ error: "invalid_user_id" });
    const { status, displayName, email } = req.body || {};
    if ((status !== undefined && !["active", "disabled"].includes(status)) || (displayName !== undefined && !text(displayName, 160)) ||
        (email !== undefined && (typeof email !== "string" || !EMAIL_RE.test(email.trim()) || email.length > 320)) ||
        [status, displayName, email].every(v => v === undefined))
      return res.status(400).json({ error: "invalid_user_update" });
    if (req.params.userId === req.actor.userId && status === "disabled") return res.status(409).json({ error: "cannot_disable_self" });
    try {
      const result = await withTenantTransaction(req.actor, async client => {
        const scope = await client.query(
          `SELECT bool_or(district_id=$2) AS here, bool_or(district_id<>$2) AS elsewhere FROM memberships WHERE user_id=$1`,
          [req.params.userId, req.actor.districtId]);
        if (!scope.rows[0].here) return fail(404, "user_not_found");
        if (scope.rows[0].elsewhere) return fail(409, "user_belongs_to_another_district");
        if (req.actor.role === "it_admin") {
          const leader = await client.query("SELECT 1 FROM memberships WHERE user_id=$1 AND district_id=$2 AND role IN ('superintendent','it_admin') LIMIT 1",
            [req.params.userId, req.actor.districtId]);
          if (leader.rowCount && req.params.userId !== req.actor.userId) return fail(403, "cannot_manage_role_or_school");
        }
        const updated = await client.query(
          `UPDATE users SET status=COALESCE($2,status),display_name=COALESCE($3,display_name),email=COALESCE($4,email)
            WHERE id=$1 RETURNING id,display_name,email,status`,
          [req.params.userId, status ?? null, displayName?.trim() ?? null, email?.trim().toLowerCase() ?? null]);
        await audit(client, req, "update", "user", req.params.userId, JSON.stringify({ status, displayName: displayName !== undefined, email: email !== undefined }));
        return { status: 200, data: updated.rows[0] };
      });
      res.status(result.status).json(result.error ? { error: result.error } : { data: result.data });
    } catch (e) { next(e); }
  });
}
