// HSP-03: independent private school foundation (db/162; design in
// docs/product/hsp-03-private-school-foundation.md).
//
// From any signed-in session:
//   POST /api/private-school/schools                {legalName, displayName, campusName, timeZone?, jurisdiction?, websiteDomain?}: register; pending verification
//   POST /api/private-school/invitations/accept     {token}
// In a private-school session (POST /api/session/context to switch):
//   GET   /api/private-school/me                    the school, its status, your role and campus
//   PATCH /api/private-school/school                school admin: name, time zone, jurisdiction, website domain, branding
//   POST  /api/private-school/closure               school admin: {reason}: ask the platform to close the school
//   GET   /api/private-school/export                school admin: the school's records as one file (closure or moving away)
//   GET/POST /api/private-school/campuses, PATCH /api/private-school/campuses/:id
//   GET   /api/private-school/members               staff list (guardians see only themselves) and open invitations
//   POST  /api/private-school/invitations           {email, role, campusId?, learnerIds?}: link shown once
//   POST  /api/private-school/invitations/:id/revoke
//   POST  /api/private-school/members/:id/role      school admin: {role, campusId?}
//   POST  /api/private-school/members/:id/revoke    school admin: {reason}
//   GET/POST /api/private-school/learners           enrolling needs a verified (active) school
//   PATCH /api/private-school/learners/:id, POST /api/private-school/learners/:id/withdraw {reason, on?}
//   POST  /api/private-school/learners/:id/guardians {membershipId, relationship, authority}
//   POST  /api/private-school/guardian-links/:id/revoke
//   GET/POST /api/private-school/calendar, POST /api/private-school/calendar/:id/cancel
//   GET   /api/private-school/audit
//
// The school, role and campus come from the session's membership. Row-level
// security (db/162) enforces the same rules.
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withPrivateSchoolTransaction, withUserTransaction, pool } from "./db.js";
import { rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const ROLES = ["school_admin", "campus_admin", "registrar", "finance", "teacher", "staff", "guardian"];
const CAMPUS_ROLES = ["campus_admin", "teacher", "staff"];
const STAFF = ROLES.filter(r => r !== "guardian");
const GRADES = ["pre_k", "k", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
const KINDS = ["event", "holiday", "term_start", "term_end", "closure", "meeting"];
const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const DAY = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isTime = v => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
const isTz = tz => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return typeof tz === "string" && tz.length <= 64; } catch { return false; } };
const emailOk = v => typeof v === "string" && v.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const today = () => new Date().toISOString().slice(0, 10);
const ymd = v => v instanceof Date ? v.toISOString().slice(0, 10) : v;

export function psAudit(c, req, action, type, id = null, detail = null) {
  return c.query("INSERT INTO private_school_audit_events(school_id, actor_user_id, actor_role, action, resource_type, resource_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [req.actor.privateSchoolId, req.actor.userId, req.actor.privateSchoolRole, action, type, id, detail]);
}
export const school = (fn, status = 200) => async (req, res, next) => {
  try {
    if (req.actor?.tenantKind !== "private_school") throw new HttpError(403, "private_school_context_required");
    const data = await withPrivateSchoolTransaction(req.actor, c => fn(c, req));
    res.setHeader("Cache-Control", "no-store");
    res.status(status).json({ data });
  } catch (e) {
    if (e.code === "23514" && /school administrator/.test(e.message)) return sendError(res, next, new HttpError(409, "school_needs_an_admin"));
    if (e.code === "42501") return sendError(res, next, new HttpError(403, "not_allowed"));
    sendError(res, next, e);
  }
};
const role = req => req.actor.privateSchoolRole;
const needRole = (req, roles, code = "not_allowed") => { if (!roles.includes(role(req))) throw new HttpError(403, code); };
const needActive = async c => { if (!(await one(c, "SELECT eduos_ps_active() AS ok")).ok) throw new HttpError(409, "school_not_verified"); };
const learnerOut = l => ({ id: l.id, campusId: l.campus_id, displayName: l.display_name, gradeLevel: l.grade_level, localNumber: l.local_number, enrollmentStatus: l.enrollment_status,
  enrolledOn: ymd(l.enrolled_on), withdrawnOn: ymd(l.withdrawn_on) });
const schoolOut = s => ({ id: s.id, legalName: s.legal_name, displayName: s.display_name, status: s.status, timeZone: s.time_zone, jurisdiction: s.jurisdiction_ref,
  websiteDomain: s.website_domain, domainVerified: !!s.domain_verified_at, branding: s.branding, verifiedAt: s.verified_at, closureRequestedAt: s.closure_requested_at });
const brandingOk = b => b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).every(k => ["primaryColor", "accentColor", "mascotName"].includes(k))
  && (b.primaryColor == null || COLOR.test(b.primaryColor)) && (b.accentColor == null || COLOR.test(b.accentColor)) && (b.mascotName == null || cleanText(b.mascotName, 60));

export function registerPrivateSchoolRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `ps:${req.actor?.userId}` });
  const registerLimiter = rateLimit({ windowMs: 3600_000, limit: 3, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `ps-reg:${req.actor?.userId}` });

  // ---------- from any context ----------
  app.post("/api/private-school/schools", requireSession, requireCsrf, registerLimiter, async (req, res, next) => {
    try {
      const b = req.body || {}, tz = b.timeZone || "America/New_York";
      const domain = b.websiteDomain ? String(b.websiteDomain).trim().toLowerCase() : null;
      if (!cleanText(b.legalName, 200, 2) || !cleanText(b.displayName, 120, 2) || !cleanText(b.campusName, 120) || !isTz(tz)
        || (b.jurisdiction != null && !/^US-[A-Z]{2}$/.test(b.jurisdiction)) || (domain && !DOMAIN.test(domain)))
        throw new HttpError(400, "invalid_school", { hint: "legalName, displayName, campusName, timeZone, jurisdiction like US-TX, websiteDomain like example.org" });
      if (!req.actor.verifiedEmail) throw new HttpError(403, "verified_email_required");
      const r = await withUserTransaction(req.actor, async c => (await one(c, "SELECT eduos_register_private_school($1,$2,$3,$4,$5,$6,$7) AS out",
        [req.actor.userId, b.legalName.trim(), b.displayName.trim(), b.campusName.trim(), tz, b.jurisdiction ?? null, domain])).out)
        .catch(e => { if (/pending_limit_reached/.test(e.message)) throw new HttpError(409, "pending_limit_reached"); throw e; });
      res.status(201).json({ data: { ...r, status: "pending_verification", note: "The platform verifies the school's identity before learner records can be added." } });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/private-school/invitations/accept", requireSession, requireCsrf, limiter, async (req, res, next) => {
    try {
      const token = req.body?.token;
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{30,100}$/.test(token)) throw new HttpError(400, "invalid_token");
      if (!req.actor.verifiedEmail) throw new HttpError(403, "verified_email_required");
      const r = await withUserTransaction(req.actor, async c => (await one(c, "SELECT eduos_accept_private_school_invitation($1,$2,$3) AS out", [req.actor.userId, req.actor.verifiedEmail, sha256(token)])).out);
      if (!r.ok) throw new HttpError(r.error === "already_a_member" ? 409 : 400, r.error);
      res.json({ data: r });
    } catch (e) { sendError(res, next, e); }
  });

  // ---------- the school in context ----------
  app.get("/api/private-school/me", requireSession, school(async (c, req) => {
    const s = await one(c, "SELECT * FROM private_schools");
    const campus = req.actor.privateSchoolCampusId ? await one(c, "SELECT id, name FROM private_school_campuses WHERE id=$1", [req.actor.privateSchoolCampusId]) : null;
    const counts = await one(c, `SELECT (SELECT count(*)::int FROM private_school_learners WHERE enrollment_status='enrolled') AS learners,
        (SELECT count(*)::int FROM private_school_campuses WHERE status='active') AS campuses`);
    return { school: schoolOut(s), role: role(req), campus, displayName: req.actor.displayName, learnersYouCanSee: counts.learners, campuses: counts.campuses };
  }));

  app.patch("/api/private-school/school", limiter, requireSession, requireCsrf, school(async (c, req) => {
    needRole(req, ["school_admin"], "school_admin_only");
    const b = req.body || {}, domain = b.websiteDomain === undefined ? undefined : b.websiteDomain === null ? null : String(b.websiteDomain).trim().toLowerCase();
    if ((b.displayName !== undefined && !cleanText(b.displayName, 120, 2)) || (b.timeZone !== undefined && !isTz(b.timeZone)) || (b.jurisdiction != null && !/^US-[A-Z]{2}$/.test(b.jurisdiction))
      || (domain && !DOMAIN.test(domain)) || (b.branding !== undefined && !brandingOk(b.branding)))
      throw new HttpError(400, "invalid_school");
    const s = await one(c, `UPDATE private_schools SET display_name=coalesce($1, display_name), time_zone=coalesce($2, time_zone),
        jurisdiction_ref=CASE WHEN $6 THEN $3 ELSE jurisdiction_ref END, website_domain=CASE WHEN $7 THEN $4 ELSE website_domain END,
        branding=coalesce($5::jsonb, branding) RETURNING *`,
      [b.displayName?.trim() ?? null, b.timeZone ?? null, b.jurisdiction ?? null, domain ?? null, b.branding ? JSON.stringify(b.branding) : null, "jurisdiction" in b, "websiteDomain" in b]);
    await psAudit(c, req, "update", "private_school", s.id, Object.keys(b).join(","));
    return schoolOut(s);
  }));

  app.post("/api/private-school/closure", limiter, requireSession, requireCsrf, school(async (c, req) => {
    needRole(req, ["school_admin"], "school_admin_only");
    const reason = req.body?.reason;
    if (!cleanText(reason, 500, 5)) throw new HttpError(400, "reason_required");
    const s = await one(c, "UPDATE private_schools SET closure_requested_by=$1, closure_requested_at=now() WHERE closure_requested_at IS NULL RETURNING id", [req.actor.userId]);
    if (!s) throw new HttpError(409, "closure_already_requested");
    await psAudit(c, req, "request_closure", "private_school", s.id, reason.trim());
    return { requested: true, note: "Export the school's records first. The platform closes the school after confirming with you." };
  }));

  app.get("/api/private-school/export", requireSession, school(async (c, req) => {
    needRole(req, ["school_admin"], "school_admin_only");
    const s = await one(c, "SELECT * FROM private_schools");
    const doc = { format: "eduos-private-school-export-1", exportedAt: new Date().toISOString(), school: schoolOut(s),
      campuses: await rows(c, "SELECT id, name, city, status FROM private_school_campuses ORDER BY name"),
      staff: await rows(c, `SELECT m.role, m.campus_id, m.joined_at, u.display_name FROM private_school_memberships m JOIN users u ON u.id=m.user_id WHERE m.status='active' AND m.role <> 'guardian' ORDER BY m.role`),
      learners: (await rows(c, "SELECT * FROM private_school_learners ORDER BY display_name")).map(learnerOut),
      guardianLinks: await rows(c, `SELECT g.learner_id, g.relationship, g.authority, u.display_name FROM private_school_guardian_links g JOIN users u ON u.id=g.user_id WHERE g.revoked_at IS NULL`),
      calendar: await rows(c, "SELECT title, kind, audience, campus_id, starts_at, ends_at FROM private_school_calendar_events WHERE cancelled_at IS NULL ORDER BY starts_at") };
    await psAudit(c, req, "export", "private_school", s.id, `learners=${doc.learners.length}`);
    return doc;
  }));

  // ---------- campuses ----------
  app.get("/api/private-school/campuses", requireSession, school(async c => rows(c, "SELECT id, name, city, status FROM private_school_campuses ORDER BY status, name")));
  app.post("/api/private-school/campuses", limiter, requireSession, requireCsrf, school(async (c, req) => {
    needRole(req, ["school_admin"], "school_admin_only");
    const b = req.body || {};
    if (!cleanText(b.name, 120) || (b.city != null && !cleanText(b.city, 120))) throw new HttpError(400, "invalid_campus");
    const k = await one(c, "INSERT INTO private_school_campuses(school_id, name, city, created_by) VALUES ($1,$2,$3,$4) RETURNING id, name, city, status",
      [req.actor.privateSchoolId, b.name.trim(), b.city?.trim() ?? null, req.actor.userId]);
    await psAudit(c, req, "create", "private_school_campus", k.id);
    return k;
  }, 201));
  app.patch("/api/private-school/campuses/:id", limiter, requireSession, requireCsrf, school(async (c, req) => {
    needRole(req, ["school_admin"], "school_admin_only");
    const b = req.body || {};
    if (!validId(req.params.id) || (b.name !== undefined && !cleanText(b.name, 120)) || (b.status !== undefined && !["active", "closed"].includes(b.status))) throw new HttpError(400, "invalid_campus");
    if (b.status === "closed" && (await one(c, "SELECT count(*)::int AS n FROM private_school_learners WHERE campus_id=$1 AND enrollment_status='enrolled'", [req.params.id])).n)
      throw new HttpError(409, "campus_has_learners");
    const k = await one(c, "UPDATE private_school_campuses SET name=coalesce($2, name), city=CASE WHEN $5 THEN $3 ELSE city END, status=coalesce($4, status) WHERE id=$1 RETURNING id, name, city, status",
      [req.params.id, b.name?.trim() ?? null, b.city ?? null, b.status ?? null, "city" in b]);
    if (!k) throw new HttpError(404, "campus_not_found");
    await psAudit(c, req, "update", "private_school_campus", k.id, Object.keys(b).join(","));
    return k;
  }));

  // ---------- members and invitations ----------
  app.get("/api/private-school/members", requireSession, school(async (c, req) => {
    const members = await rows(c, `SELECT m.id, m.role, m.campus_id, m.joined_at, u.display_name, m.user_id FROM private_school_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.status='active' ORDER BY m.role, u.display_name`);
    const invitations = await rows(c, `SELECT id, email, role, campus_id, invited_at, expires_at FROM private_school_invitations WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY invited_at DESC`);
    return { members: members.map(m => ({ id: m.id, role: m.role, campusId: m.campus_id, name: m.display_name, joinedAt: m.joined_at, you: m.id === req.actor.privateSchoolMembershipId })),
      invitations: invitations.map(i => ({ id: i.id, email: i.email, role: i.role, campusId: i.campus_id, invitedAt: i.invited_at, expiresAt: i.expires_at })) };
  }));

  app.post("/api/private-school/invitations", limiter, requireSession, requireCsrf, school(async (c, req) => {
    const b = req.body || {};
    const learnerIds = Array.isArray(b.learnerIds) ? [...new Set(b.learnerIds)] : [];
    if (!emailOk(b.email) || !ROLES.includes(b.role) || (b.campusId != null && !validId(b.campusId)) || learnerIds.some(x => !validId(x)) || learnerIds.length > 20)
      throw new HttpError(400, "invalid_invitation");
    if (b.role === "guardian") needRole(req, ["school_admin", "registrar", "campus_admin"]); else needRole(req, ["school_admin"], "school_admin_only");
    if (CAMPUS_ROLES.includes(b.role) !== (b.campusId != null)) throw new HttpError(400, "campus_required_for_campus_roles");
    if (b.role !== "guardian" && learnerIds.length) throw new HttpError(400, "learners_only_for_guardians");
    if (b.role === "guardian") await needActive(c);
    if (b.campusId && !(await one(c, "SELECT id FROM private_school_campuses WHERE id=$1 AND status='active'", [b.campusId]))) throw new HttpError(404, "campus_not_found");
    if (learnerIds.length && (await rows(c, "SELECT id FROM private_school_learners WHERE id = ANY($1) AND enrollment_status='enrolled'", [learnerIds])).length !== learnerIds.length)
      throw new HttpError(404, "learner_not_found");
    const token = crypto.randomBytes(32).toString("base64url");
    const i = await one(c, `INSERT INTO private_school_invitations(school_id, email, role, campus_id, learner_ids, token_hash, invited_by, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '7 days') RETURNING id, expires_at`,
      [req.actor.privateSchoolId, b.email.trim().toLowerCase(), b.role, b.campusId ?? null, learnerIds, sha256(token), req.actor.userId]);
    await psAudit(c, req, "invite", "private_school_invitation", i.id, `role=${b.role};learners=${learnerIds.length}`);
    return { id: i.id, expiresAt: i.expires_at, token, link: `/app/#/private-school-invite/${token}`, note: "Shown once. They accept it signed in with that email." };
  }, 201));

  app.post("/api/private-school/invitations/:id/revoke", limiter, requireSession, requireCsrf, school(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const r = await one(c, "UPDATE private_school_invitations SET revoked_at=now() WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id", [req.params.id]);
    if (!r) throw new HttpError(404, "invitation_not_found");
    await psAudit(c, req, "revoke", "private_school_invitation", r.id);
    return { revoked: true };
  }));

  app.post("/api/private-school/members/:id/role", limiter, requireSession, requireCsrf, school(async (c, req) => {
    needRole(req, ["school_admin"], "school_admin_only");
    const b = req.body || {};
    if (!validId(req.params.id) || !STAFF.includes(b.role) || (b.campusId != null && !validId(b.campusId))) throw new HttpError(400, "invalid_role");
    if (CAMPUS_ROLES.includes(b.role) !== (b.campusId != null)) throw new HttpError(400, "campus_required_for_campus_roles");
    const cur = await one(c, "SELECT role FROM private_school_memberships WHERE id=$1 AND status='active'", [req.params.id]);
    if (!cur) throw new HttpError(404, "member_not_found");
    if (cur.role === "guardian") throw new HttpError(400, "guardians_keep_their_role");
    const m = await one(c, "UPDATE private_school_memberships SET role=$2, campus_id=$3 WHERE id=$1 RETURNING id, role, campus_id", [req.params.id, b.role, b.campusId ?? null]);
    await psAudit(c, req, "change_role", "private_school_membership", m.id, `role=${b.role}`);
    return { id: m.id, role: m.role, campusId: m.campus_id };
  }));

  app.post("/api/private-school/members/:id/revoke", limiter, requireSession, requireCsrf, school(async (c, req) => {
    needRole(req, ["school_admin"], "school_admin_only");
    const reason = req.body?.reason;
    if (!validId(req.params.id) || !cleanText(reason, 500, 3)) throw new HttpError(400, "reason_required");
    const m = await one(c, "UPDATE private_school_memberships SET status='revoked', revoked_by=$2, revoked_at=now(), revoke_reason=$3 WHERE id=$1 AND status='active' RETURNING id, user_id, role",
      [req.params.id, req.actor.userId, reason.trim()]);
    if (!m) throw new HttpError(404, "member_not_found");
    const links = m.role === "guardian" ? (await c.query("UPDATE private_school_guardian_links SET revoked_by=$2, revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [m.user_id, req.actor.userId])).rowCount : 0;
    const ended = (await c.query("UPDATE sessions SET revoked_at=now() WHERE private_school_membership_id=$1 AND revoked_at IS NULL", [m.id])).rowCount;
    await psAudit(c, req, "revoke", "private_school_membership", m.id, `links=${links};sessions=${ended}`);
    return { revoked: true, sessionsEnded: ended };
  }));

  // ---------- learners ----------
  app.get("/api/private-school/learners", requireSession, school(async c =>
    (await rows(c, "SELECT * FROM private_school_learners ORDER BY enrollment_status, display_name")).map(learnerOut)));

  app.post("/api/private-school/learners", limiter, requireSession, requireCsrf, school(async (c, req) => {
    needRole(req, ["school_admin", "registrar", "campus_admin"]);
    await needActive(c);
    const b = req.body || {};
    if (!cleanText(b.displayName, 120) || !validId(b.campusId) || (b.gradeLevel != null && !GRADES.includes(b.gradeLevel)) || (b.localNumber != null && !cleanText(b.localNumber, 40))
      || (b.enrolledOn != null && !DAY(b.enrolledOn)))
      throw new HttpError(400, "invalid_learner", { hint: "displayName, campusId, gradeLevel, localNumber, enrolledOn" });
    if (!(await one(c, "SELECT id FROM private_school_campuses WHERE id=$1 AND status='active'", [b.campusId]))) throw new HttpError(404, "campus_not_found");
    try {
      const l = await one(c, `INSERT INTO private_school_learners(school_id, campus_id, display_name, grade_level, local_number, enrolled_on, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [req.actor.privateSchoolId, b.campusId, b.displayName.trim(), b.gradeLevel ?? null, b.localNumber?.trim() ?? null, b.enrolledOn ?? today(), req.actor.userId]);
      await psAudit(c, req, "enroll", "private_school_learner", l.id, `campus=${b.campusId}`);
      return learnerOut(l);
    } catch (e) { if (e.code === "23505") throw new HttpError(409, "local_number_in_use"); throw e; }
  }, 201));

  app.patch("/api/private-school/learners/:id", limiter, requireSession, requireCsrf, school(async (c, req) => {
    needRole(req, ["school_admin", "registrar", "campus_admin"]);
    const b = req.body || {};
    if (!validId(req.params.id) || (b.displayName !== undefined && !cleanText(b.displayName, 120)) || (b.gradeLevel != null && !GRADES.includes(b.gradeLevel))
      || (b.campusId !== undefined && !validId(b.campusId))) throw new HttpError(400, "invalid_learner");
    if (b.campusId && !(await one(c, "SELECT id FROM private_school_campuses WHERE id=$1 AND status='active'", [b.campusId]))) throw new HttpError(404, "campus_not_found");
    const l = await one(c, `UPDATE private_school_learners SET display_name=coalesce($2, display_name), grade_level=CASE WHEN $5 THEN $3 ELSE grade_level END, campus_id=coalesce($4, campus_id)
        WHERE id=$1 AND enrollment_status='enrolled' RETURNING *`, [req.params.id, b.displayName?.trim() ?? null, b.gradeLevel ?? null, b.campusId ?? null, "gradeLevel" in b]);
    if (!l) throw new HttpError(404, "learner_not_found");
    await psAudit(c, req, "update", "private_school_learner", l.id, Object.keys(b).join(","));
    return learnerOut(l);
  }));

  app.post("/api/private-school/learners/:id/withdraw", limiter, requireSession, requireCsrf, school(async (c, req) => {
    needRole(req, ["school_admin", "registrar", "campus_admin"]);
    const b = req.body || {};
    if (!validId(req.params.id) || !cleanText(b.reason, 300, 3) || (b.on != null && !DAY(b.on))) throw new HttpError(400, "reason_required");
    const l = await one(c, "UPDATE private_school_learners SET enrollment_status='withdrawn', withdrawn_on=$2, withdraw_reason=$3 WHERE id=$1 AND enrollment_status='enrolled' RETURNING *",
      [req.params.id, b.on ?? today(), b.reason.trim()]);
    if (!l) throw new HttpError(404, "learner_not_found");
    await psAudit(c, req, "withdraw", "private_school_learner", l.id, b.reason.trim());
    return learnerOut(l);
  }));

  app.post("/api/private-school/learners/:id/guardians", limiter, requireSession, requireCsrf, school(async (c, req) => {
    needRole(req, ["school_admin", "registrar", "campus_admin"]);
    await needActive(c);
    const b = req.body || {};
    if (!validId(req.params.id) || !validId(b.membershipId) || !["parent", "legal_guardian", "other_guardian"].includes(b.relationship) || !["full", "view"].includes(b.authority ?? "full"))
      throw new HttpError(400, "invalid_guardian_link");
    const m = await one(c, "SELECT user_id FROM private_school_memberships WHERE id=$1 AND role='guardian' AND status='active'", [b.membershipId]);
    const l = await one(c, "SELECT id FROM private_school_learners WHERE id=$1 AND enrollment_status='enrolled'", [req.params.id]);
    if (!m || !l) throw new HttpError(404, "guardian_or_learner_not_found");
    const g = await one(c, `INSERT INTO private_school_guardian_links(school_id, learner_id, user_id, relationship, authority, created_by) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT DO NOTHING RETURNING id`, [req.actor.privateSchoolId, l.id, m.user_id, b.relationship, b.authority ?? "full", req.actor.userId]);
    if (!g) throw new HttpError(409, "already_linked");
    await psAudit(c, req, "link", "private_school_guardian_link", g.id, `learner=${l.id}`);
    return { id: g.id };
  }, 201));

  app.post("/api/private-school/guardian-links/:id/revoke", limiter, requireSession, requireCsrf, school(async (c, req) => {
    needRole(req, ["school_admin", "registrar", "campus_admin"]);
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const g = await one(c, "UPDATE private_school_guardian_links SET revoked_by=$2, revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id", [req.params.id, req.actor.userId]);
    if (!g) throw new HttpError(404, "link_not_found");
    await psAudit(c, req, "unlink", "private_school_guardian_link", g.id);
    return { revoked: true };
  }));

  // ---------- calendar ----------
  app.get("/api/private-school/calendar", requireSession, school(async (c, req) => {
    const from = isTime(req.query.from) ? req.query.from : new Date(Date.now() - 86400_000).toISOString();
    const to = isTime(req.query.to) ? req.query.to : new Date(Date.now() + 62 * 86400_000).toISOString();
    if (Date.parse(to) - Date.parse(from) > 400 * 86400_000) throw new HttpError(400, "range_too_long");
    return (await rows(c, `SELECT e.*, k.name AS campus FROM private_school_calendar_events e LEFT JOIN private_school_campuses k ON k.id=e.campus_id
        WHERE e.cancelled_at IS NULL AND e.starts_at < $2 AND e.ends_at >= $1 ORDER BY e.starts_at`, [from, to]))
      .map(e => ({ id: e.id, title: e.title, kind: e.kind, audience: e.audience, campusId: e.campus_id, campus: e.campus, startsAt: e.starts_at, endsAt: e.ends_at }));
  }));
  app.post("/api/private-school/calendar", limiter, requireSession, requireCsrf, school(async (c, req) => {
    needRole(req, ["school_admin", "campus_admin"]);
    const b = req.body || {};
    if (!cleanText(b.title, 200) || (b.kind != null && !KINDS.includes(b.kind)) || (b.audience != null && !["everyone", "staff"].includes(b.audience))
      || !isTime(b.startsAt) || !isTime(b.endsAt) || Date.parse(b.endsAt) < Date.parse(b.startsAt) || (b.campusId != null && !validId(b.campusId)))
      throw new HttpError(400, "invalid_event");
    const campusId = role(req) === "campus_admin" ? req.actor.privateSchoolCampusId : b.campusId ?? null;
    const e = await one(c, `INSERT INTO private_school_calendar_events(school_id, campus_id, title, kind, audience, starts_at, ends_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.actor.privateSchoolId, campusId, b.title.trim(), b.kind || "event", b.audience || "everyone", b.startsAt, b.endsAt, req.actor.userId]);
    await psAudit(c, req, "create", "private_school_event", e.id);
    return { id: e.id };
  }, 201));
  app.post("/api/private-school/calendar/:id/cancel", limiter, requireSession, requireCsrf, school(async (c, req) => {
    needRole(req, ["school_admin", "campus_admin"]);
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const e = await one(c, "UPDATE private_school_calendar_events SET cancelled_by=$2, cancelled_at=now() WHERE id=$1 AND cancelled_at IS NULL RETURNING id", [req.params.id, req.actor.userId]);
    if (!e) throw new HttpError(404, "event_not_found");
    await psAudit(c, req, "cancel", "private_school_event", e.id);
    return { cancelled: true };
  }));

  app.get("/api/private-school/audit", requireSession, school(async c =>
    (await rows(c, `SELECT a.action, a.resource_type, a.resource_id, a.detail, a.occurred_at, a.actor_role, u.display_name FROM private_school_audit_events a LEFT JOIN users u ON u.id=a.actor_user_id
        ORDER BY a.occurred_at DESC, a.id DESC LIMIT 200`)).map(a => ({ action: a.action, resourceType: a.resource_type, resourceId: a.resource_id, detail: a.detail, at: a.occurred_at, by: a.display_name || "Platform", role: a.actor_role }))));
}
