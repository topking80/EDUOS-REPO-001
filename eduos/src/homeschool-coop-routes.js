// HSP-07: homeschool co-ops, from a family session (db/166). Owners act for
// their family; co-educators read. Learners never reach a co-op.
//
//   GET  /api/homeschool/coops                         the family's co-ops
//   POST /api/homeschool/coops {name, description?}    start one (the family becomes its organizer)
//   POST /api/homeschool/coops/join {code}             join with an organizer's one-time code
//   GET  /api/homeschool/coops/:id                     members, sessions, posts (and, for managers, pending posts, flags, invitations)
//   POST /api/homeschool/coops/:id/invitations {label} organizer: a code to give one family (shown once, 14 days)
//   POST /api/homeschool/coops/:id/invitations/:inv/revoke
//   POST /api/homeschool/coops/:id/members/:mid/role {role}       organizer
//   POST /api/homeschool/coops/:id/members/:mid/remove {reason}   organizer
//   POST /api/homeschool/coops/:id/leave | /close
//   POST /api/homeschool/coops/:id/sessions {title, startsAt, endsAt, location?, description?, leaderFamilyId?, capacity?}   organizer or moderator
//   POST /api/homeschool/coop-sessions/:id/cancel {reason}
//   GET  /api/homeschool/coop-sessions/:id/roster      organizers, moderators and the leading family: first names
//   POST /api/homeschool/coop-sessions/:id/signups {learnerId}; POST /api/homeschool/coop-signups/:id/withdraw
//   POST /api/homeschool/coop-sessions/:id/attendance {marks: [{signupId, present}]}
//   GET  /api/homeschool/coop-attendance; POST /api/homeschool/coop-attendance/:id/log   add it to the family's own attendance
//   POST /api/homeschool/coops/:id/posts {kind, title, body?, url?}   members' posts wait for approval
//   POST /api/homeschool/coop-posts/:id/decide {publish, reason?} | /remove {reason} (organizers, moderators) | /flag {reason} (any member family)
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { rows, one, validId, cleanText, HttpError } from "./role-app-util.js";
import { family } from "./homeschool-routes.js";

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const CODE = /^[A-Za-z0-9_-]{30,100}$/;
const isTime = v => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
const httpsUrl = v => { try { const u = new URL(v); return u.protocol === "https:" && v.length <= 500 && !/[\s<>"]/.test(v); } catch { return false; } };
const ERR = { family_owner_only: 403, invitation_not_valid: 404, already_a_member: 409, coop_limit_reached: 409, coop_not_found: 404 };
const check = out => { if (!out.ok) throw new HttpError(ERR[out.error] ?? 400, out.error); return out; };
const owner = req => { if (req.actor.familyRole !== "owner") throw new HttpError(403, "family_owner_only"); };
const audit = (c, coop, action, type, id, detail = null) => c.query("SELECT eduos_coop_audit($1,$2,$3,$4,$5)", [coop, action, type, id == null ? null : String(id), detail]);
const reason = v => { if (!cleanText(v, 300, 3)) throw new HttpError(400, "reason_required"); return v.trim(); };

async function coopOf(c, id) {
  if (!validId(id)) throw new HttpError(400, "invalid_id");
  const k = await one(c, "SELECT c.*, eduos_coop_role(c.id) AS role FROM coops c WHERE c.id=$1", [id]);
  if (!k || !k.role) throw new HttpError(404, "coop_not_found");
  return k;
}
async function sessionOf(c, id) {
  if (!validId(id)) throw new HttpError(400, "invalid_id");
  const s = await one(c, "SELECT s.*, eduos_coop_role(s.coop_id) AS role, eduos_coop_leads(s.id) AS leads FROM coop_sessions s WHERE s.id=$1", [id]);
  if (!s || !s.role) throw new HttpError(404, "session_not_found");
  return s;
}
const manages = role => ["organizer", "moderator"].includes(role);
const needManager = role => { if (!manages(role)) throw new HttpError(403, "organizer_or_moderator_only"); };
const needOrganizer = role => { if (role !== "organizer") throw new HttpError(403, "organizer_only"); };
// The last organizer can't step down or leave while the co-op is open (the table enforces it too).
const keepsOrganizer = async (c, coopId, memberId) => {
  if (!(await one(c, "SELECT 1 FROM coop_members WHERE coop_id=$1 AND id<>$2 AND role='organizer' AND status='active'", [coopId, memberId]))) throw new HttpError(409, "make_another_organizer_first");
};

export function registerHomeschoolCoopRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `coop:${req.actor?.userId}` });
  const H = "/api/homeschool";

  app.get(`${H}/coops`, requireSession, family(async c => (await rows(c, `SELECT c.id, c.name, c.status, eduos_coop_role(c.id) AS role,
      (SELECT count(*)::int FROM coop_members m WHERE m.coop_id=c.id AND m.status='active') AS families FROM coops c ORDER BY c.name`)).map(k => ({ id: k.id, name: k.name, role: k.role, families: k.families }))));
  app.post(`${H}/coops`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    const b = req.body || {};
    if (!cleanText(b.name, 120, 2) || (b.description != null && (typeof b.description !== "string" || b.description.length > 2000))) throw new HttpError(400, "invalid_coop");
    return { id: check((await one(c, "SELECT eduos_coop_create($1,$2) AS out", [b.name, b.description ?? null])).out).id };
  }, 201));
  app.post(`${H}/coops/join`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    const code = req.body?.code;
    if (typeof code !== "string" || !CODE.test(code.trim())) throw new HttpError(400, "invalid_code");
    return { coopId: check((await one(c, "SELECT eduos_coop_join($1) AS out", [sha256(code.trim())])).out).coopId };
  }));

  app.get(`${H}/coops/:id`, requireSession, family(async (c, req) => {
    const k = await coopOf(c, req.params.id), mgr = manages(k.role);
    const members = await rows(c, "SELECT id, family_id, family_label, role, joined_at FROM coop_members WHERE coop_id=$1 AND status='active' ORDER BY role, family_label", [k.id]);
    const counts = new Map((await rows(c, "SELECT * FROM eduos_coop_session_counts($1)", [k.id])).map(r => [r.session_id, r.signed_up]));
    const sessions = await rows(c, `SELECT s.*, eduos_coop_leads(s.id) AS leads FROM coop_sessions s WHERE s.coop_id=$1 AND s.ends_at > now() - interval '14 days' ORDER BY s.starts_at LIMIT 100`, [k.id]);
    const mine = await rows(c, "SELECT id, session_id, learner_id, learner_label FROM coop_signups WHERE coop_id=$1 AND family_id=$2 AND status='signed_up'", [k.id, req.actor.familyId]);
    const posts = await rows(c, "SELECT * FROM coop_posts WHERE coop_id=$1 AND status IN ('published','pending') ORDER BY created_at DESC LIMIT 100", [k.id]);
    const flags = mgr ? await rows(c, "SELECT post_id, count(*)::int AS n, array_agg(reason) AS reasons FROM coop_post_flags WHERE coop_id=$1 GROUP BY post_id", [k.id]) : [];
    const invitations = k.role === "organizer" ? await rows(c, "SELECT id, label, expires_at FROM coop_invitations WHERE coop_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY invited_at DESC", [k.id]) : [];
    const flagOf = new Map(flags.map(f => [f.post_id, f]));
    return { id: k.id, name: k.name, description: k.description, status: k.status, yourRole: k.role, canAct: req.actor.familyRole === "owner",
      members: members.map(m => ({ id: m.id, familyId: m.family_id, family: m.family_label, role: m.role, you: m.family_id === req.actor.familyId })),
      sessions: sessions.map(s => ({ id: s.id, title: s.title, description: s.description, location: s.location, startsAt: s.starts_at, endsAt: s.ends_at, status: s.status, cancelReason: s.cancel_reason,
        leader: members.find(m => m.family_id === s.leader_family_id)?.family_label ?? null, capacity: s.capacity, signedUp: counts.get(s.id) ?? 0, canSeeRoster: mgr || s.leads,
        yours: mine.filter(g => g.session_id === s.id).map(g => ({ signupId: g.id, learnerId: g.learner_id, name: g.learner_label })) })),
      posts: posts.map(p => ({ id: p.id, kind: p.kind, title: p.title, body: p.body, url: p.url, by: p.author_label, status: p.status, createdAt: p.created_at, yours: p.author_family === req.actor.familyId,
        flags: flagOf.get(p.id)?.n, flagReasons: flagOf.get(p.id)?.reasons })),
      invitations: invitations.map(i => ({ id: i.id, label: i.label, expiresAt: i.expires_at })) };
  }));

  // ---------- membership ----------
  app.post(`${H}/coops/:id/invitations`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    owner(req); const k = await coopOf(c, req.params.id); needOrganizer(k.role);
    if (!cleanText(req.body?.label, 120, 2)) throw new HttpError(400, "label_required", { hint: "Who it's for, e.g. the family's name" });
    const token = crypto.randomBytes(32).toString("base64url");
    const i = await one(c, `INSERT INTO coop_invitations(coop_id, label, token_hash, invited_by_family, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '14 days') RETURNING id, expires_at`,
      [k.id, req.body.label.trim(), sha256(token), req.actor.familyId, req.actor.userId]);
    await audit(c, k.id, "invite", "coop_invitation", i.id, req.body.label.trim());
    return { id: i.id, code: token, expiresAt: i.expires_at, note: "Shown once. Give it to that family's owner yourself; they enter it under Co-ops." };
  }, 201));
  app.post(`${H}/coops/:id/invitations/:inv/revoke`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    owner(req); const k = await coopOf(c, req.params.id); needOrganizer(k.role);
    if (!validId(req.params.inv)) throw new HttpError(400, "invalid_id");
    const r = await c.query("UPDATE coop_invitations SET revoked_at=now() WHERE id=$1 AND coop_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL", [req.params.inv, k.id]);
    if (!r.rowCount) throw new HttpError(404, "invitation_not_found");
    await audit(c, k.id, "revoke", "coop_invitation", req.params.inv);
    return { revoked: true };
  }));
  const member = async (c, k, mid) => {
    if (!validId(mid)) throw new HttpError(400, "invalid_id");
    const m = await one(c, "SELECT * FROM coop_members WHERE id=$1 AND coop_id=$2 AND status='active'", [mid, k.id]);
    if (!m) throw new HttpError(404, "member_not_found");
    return m;
  };
  app.post(`${H}/coops/:id/members/:mid/role`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    owner(req); const k = await coopOf(c, req.params.id); needOrganizer(k.role);
    if (!["organizer", "moderator", "member"].includes(req.body?.role)) throw new HttpError(400, "invalid_role");
    const m = await member(c, k, req.params.mid);
    if (m.role === "organizer" && req.body.role !== "organizer") await keepsOrganizer(c, k.id, m.id);
    await c.query("UPDATE coop_members SET role=$2 WHERE id=$1", [m.id, req.body.role]);
    await audit(c, k.id, "set_role", "coop_member", m.id, `${m.family_label};${req.body.role}`);
    return { role: req.body.role };
  }));
  app.post(`${H}/coops/:id/members/:mid/remove`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    owner(req); const k = await coopOf(c, req.params.id); needOrganizer(k.role);
    const why = reason(req.body?.reason), m = await member(c, k, req.params.mid);
    if (m.family_id === req.actor.familyId) throw new HttpError(409, "leave_instead");
    await c.query("UPDATE coop_members SET status='removed', ended_by=$2, ended_at=now(), end_reason=$3 WHERE id=$1", [m.id, req.actor.userId, why]);
    await audit(c, k.id, "remove", "coop_member", m.id, `${m.family_label};${why}`);
    return { removed: true };
  }));
  app.post(`${H}/coops/:id/leave`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    owner(req); const k = await coopOf(c, req.params.id);
    if (k.role === "organizer") await keepsOrganizer(c, k.id, (await one(c, "SELECT id FROM coop_members WHERE coop_id=$1 AND family_id=$2 AND status='active'", [k.id, req.actor.familyId])).id);
    check((await one(c, "SELECT eduos_coop_leave($1) AS out", [req.params.id])).out);
    return { left: true };
  }));
  app.post(`${H}/coops/:id/close`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    owner(req); const k = await coopOf(c, req.params.id); needOrganizer(k.role);
    await audit(c, k.id, "close", "coop", k.id);
    await c.query("UPDATE coops SET status='closed', closed_at=now() WHERE id=$1", [k.id]);
    return { closed: true };
  }));

  // ---------- sessions, signups, attendance ----------
  app.post(`${H}/coops/:id/sessions`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    owner(req); const k = await coopOf(c, req.params.id); needManager(k.role);
    const b = req.body || {};
    if (!cleanText(b.title, 160) || !isTime(b.startsAt) || !isTime(b.endsAt) || (b.location != null && !cleanText(b.location, 200)) || (b.description != null && (typeof b.description !== "string" || b.description.length > 2000))
      || (b.capacity != null && (!Number.isInteger(b.capacity) || b.capacity < 1 || b.capacity > 500)) || (b.leaderFamilyId != null && !validId(b.leaderFamilyId)))
      throw new HttpError(400, "invalid_session", { hint: "title, startsAt, endsAt (up to 12 hours later), location, description, leaderFamilyId (a member family), capacity" });
    const start = new Date(b.startsAt), end = new Date(b.endsAt);
    if (start <= new Date() || end <= start || end - start > 12 * 3600_000) throw new HttpError(400, "invalid_session_time");
    if (b.leaderFamilyId && !(await one(c, "SELECT 1 FROM coop_members WHERE coop_id=$1 AND family_id=$2 AND status='active'", [k.id, b.leaderFamilyId]))) throw new HttpError(400, "leader_must_be_a_member_family");
    const s = await one(c, `INSERT INTO coop_sessions(coop_id, title, description, location, starts_at, ends_at, leader_family_id, capacity, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [k.id, b.title.trim(), b.description ?? null, b.location?.trim() ?? null, start.toISOString(), end.toISOString(), b.leaderFamilyId ?? null, b.capacity ?? null, req.actor.userId]);
    await audit(c, k.id, "schedule", "coop_session", s.id, b.title.trim());
    return { id: s.id };
  }, 201));
  app.post(`${H}/coop-sessions/:id/cancel`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    owner(req); const s = await sessionOf(c, req.params.id); needManager(s.role);
    const why = reason(req.body?.reason);
    if (s.status === "cancelled") throw new HttpError(409, "already_cancelled");
    await c.query("UPDATE coop_sessions SET status='cancelled', cancel_reason=$2 WHERE id=$1", [s.id, why]);
    await audit(c, s.coop_id, "cancel", "coop_session", s.id, why);
    return { cancelled: true };
  }));
  app.get(`${H}/coop-sessions/:id/roster`, requireSession, family(async (c, req) => {
    const s = await sessionOf(c, req.params.id);
    if (!manages(s.role) && !s.leads) throw new HttpError(403, "organizers_and_session_leaders_only");
    return (await rows(c, `SELECT g.id, g.learner_label, m.family_label, a.present FROM coop_signups g JOIN coop_members m ON m.coop_id=g.coop_id AND m.family_id=g.family_id AND m.status='active'
        LEFT JOIN coop_session_attendance a ON a.signup_id=g.id WHERE g.session_id=$1 AND g.status='signed_up' ORDER BY m.family_label, g.learner_label`, [s.id]))
      .map(r => ({ signupId: r.id, name: r.learner_label, family: r.family_label, present: r.present }));
  }));
  app.post(`${H}/coop-sessions/:id/signups`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    owner(req); const s = await sessionOf(c, req.params.id);
    if (!validId(req.body?.learnerId)) throw new HttpError(400, "invalid_learner");
    if (s.status !== "scheduled" || new Date(s.starts_at) <= new Date()) throw new HttpError(409, "session_not_open");
    const l = await one(c, "SELECT id, display_name FROM family_learners WHERE id=$1 AND status='active'", [req.body.learnerId]);
    if (!l) throw new HttpError(404, "learner_not_found");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`coop-session:${s.id}`]);
    if (s.capacity && (await one(c, "SELECT signed_up FROM eduos_coop_session_counts($1) WHERE session_id=$2", [s.coop_id, s.id])).signed_up >= s.capacity) throw new HttpError(409, "session_full");
    if (await one(c, "SELECT 1 FROM coop_signups WHERE session_id=$1 AND learner_id=$2 AND status='signed_up'", [s.id, l.id])) throw new HttpError(409, "already_signed_up");
    const first = l.display_name.trim().split(/\s+/)[0].slice(0, 60);
    const g = await one(c, "INSERT INTO coop_signups(coop_id, session_id, family_id, learner_id, learner_label, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [s.coop_id, s.id, req.actor.familyId, l.id, first, req.actor.userId]);
    await audit(c, s.coop_id, "sign_up", "coop_signup", g.id);
    return { signupId: g.id, name: first };
  }, 201));
  app.post(`${H}/coop-signups/:id/withdraw`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    owner(req);
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const g = await one(c, "SELECT * FROM coop_signups WHERE id=$1 AND family_id=$2 AND status='signed_up'", [req.params.id, req.actor.familyId]);
    if (!g) throw new HttpError(404, "signup_not_found");
    await c.query("UPDATE coop_signups SET status='withdrawn', withdrawn_at=now() WHERE id=$1", [g.id]);
    await audit(c, g.coop_id, "withdraw", "coop_signup", g.id);
    return { withdrawn: true };
  }));
  app.post(`${H}/coop-sessions/:id/attendance`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    owner(req); const s = await sessionOf(c, req.params.id);
    if (!manages(s.role) && !s.leads) throw new HttpError(403, "organizers_and_session_leaders_only");
    if (s.status !== "scheduled" || new Date(s.starts_at) > new Date()) throw new HttpError(409, "session_not_started");
    const marks = req.body?.marks;
    if (!Array.isArray(marks) || !marks.length || marks.length > 500 || marks.some(m => !m || !validId(m.signupId) || typeof m.present !== "boolean")) throw new HttpError(400, "invalid_marks");
    const live = new Set((await rows(c, "SELECT id FROM coop_signups WHERE session_id=$1 AND status='signed_up'", [s.id])).map(r => r.id));
    if (marks.some(m => !live.has(m.signupId))) throw new HttpError(400, "not_signed_up_for_this_session");
    for (const m of marks) await c.query(`INSERT INTO coop_session_attendance(coop_id, signup_id, present, marked_by) VALUES ($1,$2,$3,$4)
      ON CONFLICT (signup_id) DO UPDATE SET present=EXCLUDED.present, marked_by=EXCLUDED.marked_by, marked_at=now()`, [s.coop_id, m.signupId, m.present, req.actor.userId]);
    await audit(c, s.coop_id, "mark_attendance", "coop_session", s.id, `marks=${marks.length}`);
    return { recorded: marks.length };
  }));
  app.get(`${H}/coop-attendance`, requireSession, family(async (c, req) =>
    (await rows(c, `SELECT a.id, a.present, g.learner_id, g.learner_label, s.title, s.starts_at, s.ends_at, k.name AS coop, f.id AS logged
        FROM coop_session_attendance a JOIN coop_signups g ON g.id=a.signup_id JOIN coop_sessions s ON s.id=g.session_id JOIN coops k ON k.id=g.coop_id
        LEFT JOIN family_attendance f ON f.coop_attendance_id=a.id WHERE g.family_id=$1 ORDER BY s.starts_at DESC LIMIT 200`, [req.actor.familyId]))
      .map(r => ({ id: r.id, present: r.present, learnerId: r.learner_id, name: r.learner_label, session: r.title, coop: r.coop, startsAt: r.starts_at,
        minutes: Math.round((new Date(r.ends_at) - new Date(r.starts_at)) / 60000), logged: !!r.logged }))));
  app.post(`${H}/coop-attendance/:id/log`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const a = await one(c, `SELECT a.id, a.present, g.learner_id, s.title, s.starts_at, s.ends_at, k.name AS coop, (s.starts_at AT TIME ZONE f.time_zone)::date AS day, k.id AS coop_id
        FROM coop_session_attendance a JOIN coop_signups g ON g.id=a.signup_id AND g.family_id=$2 JOIN coop_sessions s ON s.id=g.session_id JOIN coops k ON k.id=g.coop_id
        JOIN homeschool_families f ON f.id=$2 WHERE a.id=$1`, [req.params.id, req.actor.familyId]);
    if (!a) throw new HttpError(404, "attendance_not_found");
    if (!a.present) throw new HttpError(409, "not_marked_present");
    if (!(await one(c, "SELECT eduos_family_can_teach($1) AS ok", [a.learner_id])).ok) throw new HttpError(403, "not_allowed_for_this_learner");
    if (await one(c, "SELECT 1 FROM family_attendance WHERE coop_attendance_id=$1", [a.id])) throw new HttpError(409, "already_logged");
    const minutes = Math.min(1440, Math.round((new Date(a.ends_at) - new Date(a.starts_at)) / 60000));
    const f = await one(c, `INSERT INTO family_attendance(family_id, learner_id, day, minutes, kind, note, recorded_by, coop_attendance_id) VALUES ($1,$2,$3,$4,'co_op',$5,$6,$7) RETURNING id`,
      [req.actor.familyId, a.learner_id, a.day, minutes, `Co-op: ${a.coop} · ${a.title}`.slice(0, 500), req.actor.userId, a.id]);
    await c.query("INSERT INTO family_audit_events(family_id, actor_user_id, actor_role, action, resource_type, resource_id, detail) VALUES ($1,$2,$3,'record','family_attendance',$4,$5)",
      [req.actor.familyId, req.actor.userId, req.actor.familyRole, f.id, `co-op;minutes=${minutes}`]);
    return { attendanceId: f.id, minutes };
  }, 201));

  // ---------- posts and moderation ----------
  app.post(`${H}/coops/:id/posts`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    owner(req); const k = await coopOf(c, req.params.id);
    const b = req.body || {};
    if (!["announcement", "resource"].includes(b.kind) || !cleanText(b.title, 160) || (b.body != null && (typeof b.body !== "string" || b.body.length > 4000)) || (b.url != null && !httpsUrl(b.url))
      || (b.kind === "resource" && !b.url && !b.body)) throw new HttpError(400, "invalid_post", { hint: "kind (announcement, resource), title, body, url (https)" });
    const label = (await one(c, "SELECT display_name FROM homeschool_families WHERE id=$1", [req.actor.familyId])).display_name;
    const status = manages(k.role) ? "published" : "pending";
    const p = await one(c, "INSERT INTO coop_posts(coop_id, kind, title, body, url, author_family, author_label, author_user, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
      [k.id, b.kind, b.title.trim(), b.body ?? null, b.url ?? null, req.actor.familyId, label, req.actor.userId, status]);
    await audit(c, k.id, "post", "coop_post", p.id, `${b.kind};${status}`);
    return { id: p.id, status };
  }, 201));
  const postOf = async (c, id) => {
    if (!validId(id)) throw new HttpError(400, "invalid_id");
    const p = await one(c, "SELECT p.*, eduos_coop_role(p.coop_id) AS role FROM coop_posts p WHERE p.id=$1", [id]);
    if (!p || !p.role) throw new HttpError(404, "post_not_found");
    return p;
  };
  app.post(`${H}/coop-posts/:id/decide`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    owner(req); const p = await postOf(c, req.params.id); needManager(p.role);
    if (typeof req.body?.publish !== "boolean") throw new HttpError(400, "invalid_decision");
    if (p.status !== "pending") throw new HttpError(409, "already_decided");
    if (p.author_family === req.actor.familyId) throw new HttpError(409, "decide_another_familys_post");
    const status = req.body.publish ? "published" : "rejected", why = req.body.publish ? null : reason(req.body?.reason);
    await c.query("UPDATE coop_posts SET status=$2, decided_by=$3, decided_at=now(), decision_reason=$4 WHERE id=$1", [p.id, status, req.actor.userId, why]);
    await audit(c, p.coop_id, status === "published" ? "approve_post" : "reject_post", "coop_post", p.id, why);
    return { status };
  }));
  app.post(`${H}/coop-posts/:id/remove`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    owner(req); const p = await postOf(c, req.params.id); needManager(p.role);
    const why = reason(req.body?.reason);
    if (p.status === "removed") throw new HttpError(409, "already_removed");
    await c.query("UPDATE coop_posts SET status='removed', decided_by=$2, decided_at=now(), decision_reason=$3 WHERE id=$1", [p.id, req.actor.userId, why]);
    await audit(c, p.coop_id, "remove_post", "coop_post", p.id, why);
    return { removed: true };
  }));
  app.post(`${H}/coop-posts/:id/flag`, limiter, requireSession, requireCsrf, family(async (c, req) => {
    owner(req); const p = await postOf(c, req.params.id);
    const why = reason(req.body?.reason);
    if (p.status !== "published") throw new HttpError(409, "post_not_published");
    const r = await c.query("INSERT INTO coop_post_flags(coop_id, post_id, family_id, user_id, reason) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (post_id, family_id) DO NOTHING", [p.coop_id, p.id, req.actor.familyId, req.actor.userId, why]);
    if (r.rowCount) await audit(c, p.coop_id, "flag", "coop_post", p.id, why);
    return { flagged: true };
  }));
}
