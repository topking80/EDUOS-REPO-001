// HSP-01: the homeschool family workspace (db/160; design in
// docs/product/hsp-00-architecture-and-tenancy.md).
//
// From any signed-in session:
//   POST /api/homeschool/families                 {name, timeZone?, jurisdiction?}: create a family; you are its owner
//   POST /api/homeschool/invitations/accept       {token}: join a family you were invited to (your verified email)
// In a family session (POST /api/session/context to switch):
//   GET  /api/homeschool/me                       the family, your role, the learners you can see (dashboard)
//   PATCH /api/homeschool/family                  owner: name, time zone, jurisdiction
//   GET  /api/homeschool/members                  members (and, for the owner, open invitations)
//   POST /api/homeschool/invitations              owner: {email, role: co_educator|guardian_viewer, learnerIds}; the link is shown once
//   POST /api/homeschool/invitations/:id/revoke   owner
//   POST /api/homeschool/members/:id/role         owner: {role}; ownership can be shared or handed over
//   POST /api/homeschool/members/:id/revoke       owner: {reason}; ends their access and sessions
//   GET/POST /api/homeschool/learners             owner adds; members see learners they have authority over
//   PATCH /api/homeschool/learners/:id            owner
//   POST /api/homeschool/learners/:id/archive     owner
//   POST /api/homeschool/learners/:id/relationships   owner: {membershipId, relationship, authority}
//   POST /api/homeschool/relationships/:id/revoke     owner: {reason}
//   GET/POST /api/homeschool/calendar             events (family-wide or per learner)
//   PATCH /api/homeschool/calendar/:id, POST /api/homeschool/calendar/:id/cancel
//   GET  /api/homeschool/audit                    owner: everything; others: their own actions
//
// The family comes from the session, never from the request. Row-level
// security (db/160) enforces the same rules as these routes.
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withFamilyTransaction, withUserTransaction, pool } from "./db.js";
import { rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const GRADES = ["pre_k", "k", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "adult"];
const KINDS = ["lesson", "field_trip", "co_op", "appointment", "break", "other"];
const ROLES = ["owner", "co_educator", "guardian_viewer"];
const RELATIONSHIPS = ["parent", "legal_guardian", "co_educator"];
const AUTHORITY = ["full", "educational", "view"];
const INVITE_DAYS = 7;
const isTz = tz => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return typeof tz === "string" && tz.length <= 64; } catch { return false; } };
const isTime = v => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
const emailOk = v => typeof v === "string" && v.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

export function familyAudit(c, req, action, type, id = null, detail = null) {
  return c.query("INSERT INTO family_audit_events(family_id, actor_user_id, actor_role, action, resource_type, resource_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [req.actor.familyId, req.actor.userId, req.actor.familyRole, action, type, id, detail]);
}
export const family = (fn, status = 200) => async (req, res, next) => {
  try {
    if (req.actor?.tenantKind !== "homeschool_family") throw new HttpError(403, "family_context_required");
    const data = await withFamilyTransaction(req.actor, c => fn(c, req));
    res.setHeader("Cache-Control", "no-store");
    res.status(status).json({ data });
  } catch (e) {
    if (e.code === "23514" && /active owner/.test(e.message)) return sendError(res, next, new HttpError(409, "family_needs_an_owner"));
    if (e.code === "42501") return sendError(res, next, new HttpError(403, "not_allowed"));
    sendError(res, next, e);
  }
};
const ownerOnly = req => { if (req.actor.familyRole !== "owner") throw new HttpError(403, "family_owner_only"); };
const learnerOut = l => ({ id: l.id, displayName: l.display_name, gradeBand: l.grade_band, birthYear: l.birth_year, status: l.status, authority: l.authority ?? undefined });
const eventOut = e => ({ id: e.id, learnerId: e.learner_id, title: e.title, kind: e.kind, startsAt: e.starts_at, endsAt: e.ends_at, allDay: e.all_day, notes: e.notes,
  cancelled: !!e.cancelled_at, createdBy: e.created_by_name || undefined });

export function registerHomeschoolRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `home:${req.actor?.userId}` });
  const createLimiter = rateLimit({ windowMs: 3600_000, limit: 5, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `home-create:${req.actor?.userId}` });

  // ---------- from any context ----------
  app.post("/api/homeschool/families", requireSession, requireCsrf, createLimiter, async (req, res, next) => {
    try {
      const b = req.body || {};
      const tz = b.timeZone || "America/New_York";
      if (!cleanText(b.name, 120, 2) || !isTz(tz) || (b.jurisdiction != null && !/^US-[A-Z]{2}$/.test(b.jurisdiction)))
        throw new HttpError(400, "invalid_family", { hint: "name (2-120 characters), timeZone (IANA), jurisdiction like US-TX (optional)" });
      if (!req.actor.verifiedEmail) throw new HttpError(403, "verified_email_required");
      const id = await withUserTransaction(req.actor, async c => (await one(c, "SELECT eduos_create_family($1,$2,$3,$4) AS id", [req.actor.userId, b.name.trim(), tz, b.jurisdiction ?? null])).id)
        .catch(e => { if (/family_limit_reached/.test(e.message)) throw new HttpError(409, "family_limit_reached"); throw e; });
      const ctx = (await pool.query("SELECT membership_id FROM eduos_family_contexts($1) WHERE family_id=$2", [req.actor.userId, id])).rows[0];
      res.status(201).json({ data: { familyId: id, membershipId: ctx.membership_id, next: "POST /api/session/context to open it" } });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/homeschool/invitations/accept", requireSession, requireCsrf, limiter, async (req, res, next) => {
    try {
      const token = req.body?.token;
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{30,100}$/.test(token)) throw new HttpError(400, "invalid_token");
      if (!req.actor.verifiedEmail) throw new HttpError(403, "verified_email_required");
      const r = await withUserTransaction(req.actor, async c => (await one(c, "SELECT eduos_accept_family_invitation($1,$2,$3) AS out", [req.actor.userId, req.actor.verifiedEmail, sha256(token)])).out);
      if (!r.ok) throw new HttpError(r.error === "already_a_member" ? 409 : 400, r.error);
      res.json({ data: r });
    } catch (e) { sendError(res, next, e); }
  });

  // ---------- the family in context ----------
  app.get("/api/homeschool/me", requireSession, family(async (c, req) => {
    const f = await one(c, "SELECT id, display_name, time_zone, jurisdiction_ref FROM homeschool_families");
    const learners = await rows(c, "SELECT l.*, eduos_family_authority(l.id) AS authority FROM family_learners l WHERE l.status='active' ORDER BY l.display_name");
    const upcoming = await rows(c, `SELECT e.learner_id, count(*)::int AS n FROM family_calendar_events e
        WHERE e.cancelled_at IS NULL AND e.starts_at >= now() - interval '12 hours' AND e.starts_at < now() + interval '7 days' GROUP BY 1`);
    return { family: { id: f.id, name: f.display_name, timeZone: f.time_zone, jurisdiction: f.jurisdiction_ref }, role: req.actor.familyRole, displayName: req.actor.displayName,
      learners: learners.map(l => ({ ...learnerOut(l), upcomingThisWeek: upcoming.find(u => u.learner_id === l.id)?.n || 0 })),
      familyEventsThisWeek: upcoming.find(u => u.learner_id === null)?.n || 0 };
  }));

  app.patch("/api/homeschool/family", limiter, requireSession, requireCsrf, family(async (c, req) => {
    ownerOnly(req);
    const b = req.body || {};
    if ((b.name !== undefined && !cleanText(b.name, 120, 2)) || (b.timeZone !== undefined && !isTz(b.timeZone)) || (b.jurisdiction != null && !/^US-[A-Z]{2}$/.test(b.jurisdiction)))
      throw new HttpError(400, "invalid_family");
    const f = await one(c, `UPDATE homeschool_families SET display_name=coalesce($1, display_name), time_zone=coalesce($2, time_zone),
        jurisdiction_ref=CASE WHEN $4 THEN $3 ELSE jurisdiction_ref END RETURNING display_name, time_zone, jurisdiction_ref`,
      [b.name?.trim() ?? null, b.timeZone ?? null, b.jurisdiction ?? null, "jurisdiction" in b]);
    await familyAudit(c, req, "update", "family", req.actor.familyId, Object.keys(b).join(","));
    return { name: f.display_name, timeZone: f.time_zone, jurisdiction: f.jurisdiction_ref };
  }));

  app.get("/api/homeschool/members", requireSession, family(async (c, req) => {
    const members = await rows(c, `SELECT m.id, m.role, m.joined_at, u.display_name FROM family_memberships m JOIN users u ON u.id=m.user_id WHERE m.status='active' ORDER BY m.role, u.display_name`);
    const invitations = req.actor.familyRole === "owner" ? await rows(c, `SELECT id, email, role, authority, learner_ids, invited_at, expires_at FROM family_invitations
        WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY invited_at DESC`) : [];
    return { members: members.map(m => ({ id: m.id, role: m.role, name: m.display_name, joinedAt: m.joined_at, you: m.id === req.actor.familyMembershipId })),
      invitations: invitations.map(i => ({ id: i.id, email: i.email, role: i.role, authority: i.authority, learnerIds: i.learner_ids, invitedAt: i.invited_at, expiresAt: i.expires_at })) };
  }));

  app.post("/api/homeschool/invitations", limiter, requireSession, requireCsrf, family(async (c, req) => {
    ownerOnly(req);
    const b = req.body || {};
    const learnerIds = Array.isArray(b.learnerIds) ? [...new Set(b.learnerIds)] : [];
    if (!emailOk(b.email) || !["co_educator", "guardian_viewer"].includes(b.role) || learnerIds.some(x => !validId(x)) || learnerIds.length > 50)
      throw new HttpError(400, "invalid_invitation", { hint: "email, role co_educator or guardian_viewer, learnerIds" });
    const known = learnerIds.length ? await rows(c, "SELECT id FROM family_learners WHERE id = ANY($1) AND status='active'", [learnerIds]) : [];
    if (known.length !== learnerIds.length) throw new HttpError(400, "learner_not_found");
    const open = await one(c, "SELECT count(*)::int AS n FROM family_invitations WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()");
    if (open.n >= 20) throw new HttpError(409, "too_many_open_invitations");
    const token = crypto.randomBytes(32).toString("base64url");
    const i = await one(c, `INSERT INTO family_invitations(family_id, email, role, learner_ids, authority, token_hash, invited_by, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(days => $8)) RETURNING id, expires_at`,
      [req.actor.familyId, b.email.trim().toLowerCase(), b.role, learnerIds, b.role === "co_educator" ? "educational" : "view", sha256(token), req.actor.userId, INVITE_DAYS]);
    await familyAudit(c, req, "invite", "family_invitation", i.id, `role=${b.role};learners=${learnerIds.length}`);
    return { id: i.id, expiresAt: i.expires_at, token, link: `/app/#/homeschool-invite/${token}`, note: "Shown once. Send it to that person only; they accept it signed in with that email." };
  }, 201));

  app.post("/api/homeschool/invitations/:id/revoke", limiter, requireSession, requireCsrf, family(async (c, req) => {
    ownerOnly(req);
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const r = await one(c, "UPDATE family_invitations SET revoked_at=now() WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id", [req.params.id]);
    if (!r) throw new HttpError(404, "invitation_not_found");
    await familyAudit(c, req, "revoke", "family_invitation", r.id);
    return { revoked: true };
  }));

  app.post("/api/homeschool/members/:id/role", limiter, requireSession, requireCsrf, family(async (c, req) => {
    ownerOnly(req);
    const role = req.body?.role;
    if (!validId(req.params.id) || !ROLES.includes(role)) throw new HttpError(400, "invalid_role");
    const m = await one(c, "UPDATE family_memberships SET role=$2 WHERE id=$1 AND status='active' RETURNING id, role", [req.params.id, role]);
    if (!m) throw new HttpError(404, "member_not_found");
    await familyAudit(c, req, "change_role", "family_membership", m.id, `role=${role}`);
    return { id: m.id, role: m.role };
  }));

  app.post("/api/homeschool/members/:id/revoke", limiter, requireSession, requireCsrf, family(async (c, req) => {
    ownerOnly(req);
    const reason = req.body?.reason;
    if (!validId(req.params.id) || !cleanText(reason, 500, 3)) throw new HttpError(400, "reason_required");
    const m = await one(c, "UPDATE family_memberships SET status='revoked', revoked_by=$2, revoked_at=now(), revoke_reason=$3 WHERE id=$1 AND status='active' RETURNING id, user_id",
      [req.params.id, req.actor.userId, reason.trim()]);
    if (!m) throw new HttpError(404, "member_not_found");
    const rel = await c.query("UPDATE family_learner_relationships SET revoked_by=$2, revoked_at=now(), revoke_reason=$3 WHERE user_id=$1 AND revoked_at IS NULL", [m.user_id, req.actor.userId, "Membership revoked"]);
    // Their family sessions end now (district sessions are not this family's to end).
    const ended = (await c.query("UPDATE sessions SET revoked_at=now() WHERE family_membership_id=$1 AND revoked_at IS NULL", [m.id])).rowCount;
    await familyAudit(c, req, "revoke", "family_membership", m.id, `relationships=${rel.rowCount};sessions=${ended}`);
    return { revoked: true, sessionsEnded: ended };
  }));

  app.get("/api/homeschool/learners", requireSession, family(async c =>
    (await rows(c, "SELECT l.*, eduos_family_authority(l.id) AS authority FROM family_learners l ORDER BY l.status, l.display_name")).map(learnerOut)));

  app.post("/api/homeschool/learners", limiter, requireSession, requireCsrf, family(async (c, req) => {
    ownerOnly(req);
    const b = req.body || {};
    if (!cleanText(b.displayName, 120) || (b.gradeBand != null && !GRADES.includes(b.gradeBand)) || (b.birthYear != null && !(Number.isInteger(b.birthYear) && b.birthYear >= 1900 && b.birthYear <= 2100)))
      throw new HttpError(400, "invalid_learner", { hint: "displayName, gradeBand (pre_k, k, 1-12, adult), birthYear (optional)" });
    const n = await one(c, "SELECT count(*)::int AS n FROM family_learners WHERE status='active'");
    if (n.n >= 30) throw new HttpError(409, "too_many_learners");
    const l = await one(c, "INSERT INTO family_learners(family_id, display_name, grade_band, birth_year, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [req.actor.familyId, b.displayName.trim(), b.gradeBand ?? null, b.birthYear ?? null, req.actor.userId]);
    await familyAudit(c, req, "create", "family_learner", l.id);
    return learnerOut({ ...l, authority: "full" });
  }, 201));

  app.patch("/api/homeschool/learners/:id", limiter, requireSession, requireCsrf, family(async (c, req) => {
    ownerOnly(req);
    const b = req.body || {};
    if (!validId(req.params.id) || (b.displayName !== undefined && !cleanText(b.displayName, 120)) || (b.gradeBand != null && !GRADES.includes(b.gradeBand))) throw new HttpError(400, "invalid_learner");
    const l = await one(c, `UPDATE family_learners SET display_name=coalesce($2, display_name), grade_band=CASE WHEN $4 THEN $3 ELSE grade_band END
        WHERE id=$1 AND status='active' RETURNING *`, [req.params.id, b.displayName?.trim() ?? null, b.gradeBand ?? null, "gradeBand" in b]);
    if (!l) throw new HttpError(404, "learner_not_found");
    await familyAudit(c, req, "update", "family_learner", l.id, Object.keys(b).join(","));
    return learnerOut({ ...l, authority: "full" });
  }));

  app.post("/api/homeschool/learners/:id/archive", limiter, requireSession, requireCsrf, family(async (c, req) => {
    ownerOnly(req);
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const l = await one(c, "UPDATE family_learners SET status='archived', archived_at=now() WHERE id=$1 AND status='active' RETURNING id", [req.params.id]);
    if (!l) throw new HttpError(404, "learner_not_found");
    await familyAudit(c, req, "archive", "family_learner", l.id);
    return { archived: true };
  }));

  app.post("/api/homeschool/learners/:id/relationships", limiter, requireSession, requireCsrf, family(async (c, req) => {
    ownerOnly(req);
    const b = req.body || {};
    if (!validId(req.params.id) || !validId(b.membershipId) || !RELATIONSHIPS.includes(b.relationship) || !AUTHORITY.includes(b.authority))
      throw new HttpError(400, "invalid_relationship", { hint: "membershipId, relationship (parent, legal_guardian, co_educator), authority (full, educational, view)" });
    const m = await one(c, "SELECT id, user_id, role FROM family_memberships WHERE id=$1 AND status='active'", [b.membershipId]);
    const l = await one(c, "SELECT id FROM family_learners WHERE id=$1 AND status='active'", [req.params.id]);
    if (!m || !l) throw new HttpError(404, "member_or_learner_not_found");
    if (m.role === "guardian_viewer" && b.authority !== "view") throw new HttpError(400, "viewer_authority_is_view");
    if (m.role === "co_educator" && b.authority === "full") throw new HttpError(400, "full_authority_needs_an_owner_or_guardian");
    const r = await one(c, `INSERT INTO family_learner_relationships(family_id, learner_id, user_id, relationship, authority, verification, created_by)
      VALUES ($1,$2,$3,$4,$5,'verified_by_owner',$6) ON CONFLICT DO NOTHING RETURNING id`, [req.actor.familyId, l.id, m.user_id, b.relationship, b.authority, req.actor.userId]);
    if (!r) throw new HttpError(409, "relationship_exists");
    await familyAudit(c, req, "relate", "family_learner_relationship", r.id, `learner=${l.id};authority=${b.authority}`);
    return { id: r.id };
  }, 201));

  app.post("/api/homeschool/relationships/:id/revoke", limiter, requireSession, requireCsrf, family(async (c, req) => {
    ownerOnly(req);
    const reason = req.body?.reason;
    if (!validId(req.params.id) || !cleanText(reason, 500, 3)) throw new HttpError(400, "reason_required");
    const r = await one(c, "UPDATE family_learner_relationships SET revoked_by=$2, revoked_at=now(), revoke_reason=$3 WHERE id=$1 AND revoked_at IS NULL RETURNING id", [req.params.id, req.actor.userId, reason.trim()]);
    if (!r) throw new HttpError(404, "relationship_not_found");
    await familyAudit(c, req, "unrelate", "family_learner_relationship", r.id, reason.trim());
    return { revoked: true };
  }));

  app.get("/api/homeschool/calendar", requireSession, family(async (c, req) => {
    const from = isTime(req.query.from) ? req.query.from : new Date(Date.now() - 86400_000).toISOString();
    const to = isTime(req.query.to) ? req.query.to : new Date(Date.now() + 31 * 86400_000).toISOString();
    if (Date.parse(to) - Date.parse(from) > 120 * 86400_000) throw new HttpError(400, "range_too_long");
    return (await rows(c, `SELECT e.*, u.display_name AS created_by_name FROM family_calendar_events e JOIN users u ON u.id=e.created_by
        WHERE e.starts_at < $2 AND e.ends_at >= $1 ORDER BY e.starts_at`, [from, to])).map(eventOut);
  }));

  const eventFields = (b, partial) => {
    if (b.learnerId != null && !validId(b.learnerId)) return null;
    if (!partial || b.title !== undefined) if (!cleanText(b.title, 200)) return null;
    if (b.kind !== undefined && !KINDS.includes(b.kind)) return null;
    if (!partial || b.startsAt !== undefined || b.endsAt !== undefined) if (!isTime(b.startsAt) || !isTime(b.endsAt) || Date.parse(b.endsAt) < Date.parse(b.startsAt)) return null;
    if (b.notes != null && (typeof b.notes !== "string" || b.notes.length > 2000)) return null;
    return true;
  };
  app.post("/api/homeschool/calendar", limiter, requireSession, requireCsrf, family(async (c, req) => {
    const b = req.body || {};
    if (!eventFields(b, false)) throw new HttpError(400, "invalid_event", { hint: "title, startsAt, endsAt (ISO times), kind, learnerId (optional), notes" });
    if (b.learnerId && !(await one(c, "SELECT id FROM family_learners WHERE id=$1 AND status='active'", [b.learnerId]))) throw new HttpError(404, "learner_not_found");
    try {
      const e = await one(c, `INSERT INTO family_calendar_events(family_id, learner_id, title, kind, starts_at, ends_at, all_day, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [req.actor.familyId, b.learnerId ?? null, b.title.trim(), b.kind || "lesson", b.startsAt, b.endsAt, b.allDay === true, b.notes ?? null, req.actor.userId]);
      await familyAudit(c, req, "create", "family_event", e.id, e.learner_id ? `learner=${e.learner_id}` : "family");
      return eventOut(e);
    } catch (err) { if (err.code === "42501") throw new HttpError(403, "not_allowed_for_this_learner"); throw err; }
  }, 201));

  app.patch("/api/homeschool/calendar/:id", limiter, requireSession, requireCsrf, family(async (c, req) => {
    const b = req.body || {};
    if (!validId(req.params.id) || !eventFields(b, true) || "learnerId" in b) throw new HttpError(400, "invalid_event");
    const e = await one(c, `UPDATE family_calendar_events SET title=coalesce($2, title), kind=coalesce($3, kind), starts_at=coalesce($4, starts_at), ends_at=coalesce($5, ends_at),
        all_day=coalesce($6, all_day), notes=CASE WHEN $8 THEN $7 ELSE notes END WHERE id=$1 AND cancelled_at IS NULL RETURNING *`,
      [req.params.id, b.title?.trim() ?? null, b.kind ?? null, b.startsAt ?? null, b.endsAt ?? null, typeof b.allDay === "boolean" ? b.allDay : null, b.notes ?? null, "notes" in b]);
    if (!e) throw new HttpError(404, "event_not_found");
    await familyAudit(c, req, "update", "family_event", e.id, Object.keys(b).join(","));
    return eventOut(e);
  }));

  app.post("/api/homeschool/calendar/:id/cancel", limiter, requireSession, requireCsrf, family(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const e = await one(c, "UPDATE family_calendar_events SET cancelled_by=$2, cancelled_at=now() WHERE id=$1 AND cancelled_at IS NULL RETURNING id", [req.params.id, req.actor.userId]);
    if (!e) throw new HttpError(404, "event_not_found");
    await familyAudit(c, req, "cancel", "family_event", e.id);
    return { cancelled: true };
  }));

  app.get("/api/homeschool/audit", requireSession, family(async c =>
    (await rows(c, `SELECT a.action, a.resource_type, a.resource_id, a.detail, a.occurred_at, a.actor_role, u.display_name FROM family_audit_events a JOIN users u ON u.id=a.actor_user_id
        ORDER BY a.occurred_at DESC, a.id DESC LIMIT 200`)).map(a => ({ action: a.action, resourceType: a.resource_type, resourceId: a.resource_id, detail: a.detail, at: a.occurred_at, by: a.display_name, role: a.actor_role }))));
}
