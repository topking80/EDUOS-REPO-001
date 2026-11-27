// HSP-07 part 2: private school message threads between a learner's
// guardians and the staff who work with that learner (db/167).
//
//   GET  /api/private-school/messages                       your threads (school admins: all, for oversight), with unread counts
//   GET  /api/private-school/messages/contacts?learnerId=   whom you may include for that learner
//   POST /api/private-school/messages {learnerId, subject, body, membershipIds}
//   GET  /api/private-school/messages/:id                   the thread (marks it read)
//   POST /api/private-school/messages/:id/reply {body}
//   POST /api/private-school/messages/:id/close             a participant or a school admin
//   POST /api/private-school/messages/:id/messages/:mid/hide {reason}   school admins
//
// No learner is ever in a thread (private schools have no learner accounts),
// and only the learner's linked guardians and the staff who work with them can
// be included. Messages are never edited or deleted.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { rows, one, validId, cleanText, HttpError } from "./role-app-util.js";
import { school, psAudit } from "./private-school-routes.js";

const bodyOk = v => typeof v === "string" && v.trim().length >= 1 && v.length <= 4000;
const admin = req => req.actor.privateSchoolRole === "school_admin";

async function threadOf(c, id) {
  if (!validId(id)) throw new HttpError(400, "invalid_id");
  const t = await one(c, `SELECT t.*, l.display_name AS learner, eduos_ps_in_thread(t.id) AS mine FROM ps_message_threads t
      LEFT JOIN private_school_learners l ON l.id=t.learner_id WHERE t.id=$1`, [id]);
  if (!t) throw new HttpError(404, "thread_not_found");
  return t;
}

export function registerPrivateSchoolMessageRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `psm:${req.actor?.userId}` });
  const M = "/api/private-school/messages";

  app.get(M, requireSession, school(async (c, req) => {
    const list = await rows(c, `SELECT t.id, t.subject, t.status, t.opened_at, t.learner_id, l.display_name AS learner, eduos_ps_in_thread(t.id) AS mine,
        (SELECT max(sent_at) FROM ps_messages m WHERE m.thread_id=t.id) AS last_at,
        (SELECT count(*)::int FROM ps_messages m WHERE m.thread_id=t.id AND m.sent_at > coalesce(p.last_read_at, '-infinity') AND m.author_membership <> $1) AS unread
      FROM ps_message_threads t LEFT JOIN private_school_learners l ON l.id=t.learner_id
      LEFT JOIN ps_message_participants p ON p.thread_id=t.id AND p.membership_id=$1
      ORDER BY last_at DESC NULLS LAST LIMIT 200`, [req.actor.privateSchoolMembershipId]);
    return list.map(t => ({ id: t.id, subject: t.subject, status: t.status, learner: t.learner, learnerId: t.learner_id, lastAt: t.last_at, unread: t.mine ? t.unread : 0, participant: t.mine }));
  }));
  app.get(`${M}/contacts`, requireSession, school(async (c, req) => {
    if (!validId(req.query.learnerId)) throw new HttpError(400, "invalid_learner");
    return (await rows(c, "SELECT * FROM eduos_ps_contacts($1) ORDER BY role, name", [req.query.learnerId])).map(x => ({ membershipId: x.membership_id, name: x.name, role: x.role }));
  }));
  app.post(M, limiter, requireSession, requireCsrf, school(async (c, req) => {
    const b = req.body || {}, ids = Array.isArray(b.membershipIds) ? [...new Set(b.membershipIds)] : [];
    if (!validId(b.learnerId) || !cleanText(b.subject, 160) || !bodyOk(b.body) || !ids.length || ids.length > 10 || ids.some(x => !validId(x)))
      throw new HttpError(400, "invalid_thread", { hint: "learnerId, subject, body, membershipIds (from /messages/contacts)" });
    const allowed = new Set((await rows(c, "SELECT membership_id FROM eduos_ps_contacts($1)", [b.learnerId])).map(x => x.membership_id));
    if (!allowed.size) throw new HttpError(403, "not_a_guardian_or_staff_for_this_learner");
    if (ids.some(x => !allowed.has(x))) throw new HttpError(403, "not_an_allowed_contact");
    const t = await one(c, "INSERT INTO ps_message_threads(school_id, learner_id, subject, opened_by, opened_by_membership) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [req.actor.privateSchoolId, b.learnerId, b.subject.trim(), req.actor.userId, req.actor.privateSchoolMembershipId]);
    for (const m of [req.actor.privateSchoolMembershipId, ...ids])
      await c.query("INSERT INTO ps_message_participants(school_id, thread_id, membership_id, last_read_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [req.actor.privateSchoolId, t.id, m, m === req.actor.privateSchoolMembershipId ? new Date() : null]);
    await c.query("INSERT INTO ps_messages(school_id, thread_id, author_membership, author_user, body) VALUES ($1,$2,$3,$4,$5)",
      [req.actor.privateSchoolId, t.id, req.actor.privateSchoolMembershipId, req.actor.userId, b.body.trim()]);
    await psAudit(c, req, "open", "ps_message_thread", t.id, `learner=${b.learnerId};people=${ids.length + 1}`);
    return { id: t.id };
  }, 201));
  app.get(`${M}/:id`, requireSession, school(async (c, req) => {
    const t = await threadOf(c, req.params.id);
    const people = await rows(c, "SELECT * FROM eduos_ps_thread_people($1) ORDER BY role, name", [t.id]);
    const who = new Map(people.map(p => [p.membership_id, p]));
    const msgs = await rows(c, "SELECT * FROM ps_messages WHERE thread_id=$1 ORDER BY sent_at, id", [t.id]);
    if (t.mine) await c.query("UPDATE ps_message_participants SET last_read_at=now() WHERE thread_id=$1 AND membership_id=$2", [t.id, req.actor.privateSchoolMembershipId]);
    return { id: t.id, subject: t.subject, status: t.status, learner: t.learner, participant: t.mine, canHide: admin(req),
      oversight: !t.mine ? "You're reading this as a school administrator." : null,
      people: people.map(p => ({ name: p.name, role: p.role, you: p.membership_id === req.actor.privateSchoolMembershipId })),
      messages: msgs.map(m => ({ id: m.id, from: who.get(m.author_membership)?.name ?? "Former member", role: who.get(m.author_membership)?.role, you: m.author_membership === req.actor.privateSchoolMembershipId, sentAt: m.sent_at,
        body: m.hidden_at && !admin(req) ? null : m.body, hidden: !!m.hidden_at, hideReason: m.hide_reason })) };
  }));
  app.post(`${M}/:id/reply`, limiter, requireSession, requireCsrf, school(async (c, req) => {
    const t = await threadOf(c, req.params.id);
    if (!bodyOk(req.body?.body)) throw new HttpError(400, "invalid_message");
    if (!t.mine) throw new HttpError(403, "not_in_this_thread");
    if (t.status !== "open") throw new HttpError(409, "thread_closed");
    const m = await one(c, "INSERT INTO ps_messages(school_id, thread_id, author_membership, author_user, body) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [req.actor.privateSchoolId, t.id, req.actor.privateSchoolMembershipId, req.actor.userId, req.body.body.trim()]);
    await c.query("UPDATE ps_message_participants SET last_read_at=now() WHERE thread_id=$1 AND membership_id=$2", [t.id, req.actor.privateSchoolMembershipId]);
    return { id: m.id };
  }, 201));
  app.post(`${M}/:id/close`, limiter, requireSession, requireCsrf, school(async (c, req) => {
    const t = await threadOf(c, req.params.id);
    if (!t.mine && !admin(req)) throw new HttpError(403, "not_in_this_thread");
    if (t.status !== "open") throw new HttpError(409, "thread_closed");
    await c.query("UPDATE ps_message_threads SET status='closed', closed_by=$2, closed_at=now() WHERE id=$1", [t.id, req.actor.userId]);
    await psAudit(c, req, "close", "ps_message_thread", t.id);
    return { closed: true };
  }));
  app.post(`${M}/:id/messages/:mid/hide`, limiter, requireSession, requireCsrf, school(async (c, req) => {
    if (!admin(req)) throw new HttpError(403, "school_admin_only");
    const t = await threadOf(c, req.params.id);
    if (!validId(req.params.mid) || !cleanText(req.body?.reason, 300, 3)) throw new HttpError(400, "reason_required");
    const r = await c.query("UPDATE ps_messages SET hidden_by=$3, hidden_at=now(), hide_reason=$4 WHERE id=$1 AND thread_id=$2 AND hidden_at IS NULL", [req.params.mid, t.id, req.actor.userId, req.body.reason.trim()]);
    if (!r.rowCount) throw new HttpError(404, "message_not_found");
    await psAudit(c, req, "hide_message", "ps_message", req.params.mid, req.body.reason.trim());
    return { hidden: true };
  }));
}
