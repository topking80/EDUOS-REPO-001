// 32.4.0 Comms Hub: school and class announcements, two-way threads with read
// receipts, reports and moderation, and in-app notifications.
//
// Messaging policy (API; RLS repeats the participant and school rules):
//  - family threads are about one learner and always include that learner's
//    guardian(s) and staff who work with the learner (roster teacher or the
//    school's principal);
//  - staff threads are between staff of one school (principal, teachers,
//    drivers); network threads (TEACH-01, teacher-network-routes.js) connect
//    teachers and principals across the district's schools;
//  - pupils read announcements only. There are no pupil-to-adult private
//    messages, and nobody can add a pupil to a thread;
//  - principals moderate their school (hide reported messages, lock threads,
//    remove announcements); the superintendent can moderate any school. Every
//    write and moderation step is audited.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { enqueueNotifications } from "./notify.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";

const AUDIENCE = ["principal", "teacher", "parent", "pupil", "driver", "sro"];
const STAFF = ["principal", "teacher", "driver", "sro"];

/** People the current user may start a thread with (and, for families, about whom). */
export async function contactsFor(client, a) {
  if (a.role === "parent") {
    return rows(client, `WITH kids AS (SELECT s.id,s.display_name,s.school_id FROM student_user_links l JOIN students s ON s.id=l.student_id
                           WHERE l.user_id=$1 AND l.status='active' AND l.relationship IN ('parent','guardian') AND s.school_id=$2)
      SELECT DISTINCT u.id AS user_id,u.display_name AS name,'teacher' AS role,k.id AS student_id,k.display_name AS student_name
        FROM kids k JOIN teacher_student_rosters tr ON tr.student_id=k.id JOIN users u ON u.id=tr.teacher_user_id AND u.status='active'
        JOIN memberships m ON m.user_id=u.id AND m.school_id=k.school_id AND m.role='teacher' AND m.status='active'
      UNION
      SELECT DISTINCT u.id,u.display_name,'principal',k.id,k.display_name FROM kids k
        JOIN memberships m ON m.school_id=k.school_id AND m.role='principal' AND m.status='active' JOIN users u ON u.id=m.user_id AND u.status='active'
      ORDER BY 5,3 DESC,2`, [a.userId, a.schoolId]);
  }
  const staff = STAFF.includes(a.role) ? await rows(client, `SELECT DISTINCT u.id AS user_id,u.display_name AS name,m.role,NULL::uuid AS student_id,NULL::text AS student_name
      FROM memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
     WHERE m.school_id=$1 AND m.status='active' AND m.role IN ('principal','teacher','driver') AND u.id<>$2 ORDER BY 3,2`, [a.schoolId, a.userId]) : [];
  if (a.role === "teacher" || a.role === "principal") {
    const guardians = await rows(client, `SELECT DISTINCT u.id AS user_id,u.display_name AS name,'parent' AS role,s.id AS student_id,s.display_name AS student_name
        FROM students s JOIN student_user_links l ON l.student_id=s.id AND l.status='active' AND l.relationship IN ('parent','guardian')
        JOIN users u ON u.id=l.user_id AND u.status='active'
       WHERE s.school_id=$1 AND ($3<>'teacher' OR EXISTS(SELECT 1 FROM teacher_student_rosters tr WHERE tr.student_id=s.id AND tr.teacher_user_id=$2))
       ORDER BY 5,2 LIMIT 500`, [a.schoolId, a.userId, a.role]);
    return [...guardians, ...staff];
  }
  return staff; // driver: school staff only
}

async function notifyThread(client, a, thread, title) {
  const others = await rows(client, `SELECT user_id FROM comms_participants WHERE thread_id=$1 AND user_id<>$2 AND left_at IS NULL`, [thread.id, a.userId]);
  await enqueueNotifications(client, { districtId: a.districtId, schoolId: thread.school_id, recipients: others.map(o => o.user_id), kind: "message",
    title, body: null, refType: "comms_thread", refId: thread.id });
}

export function registerCommsRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: config.commsRateLimit, standardHeaders: true, legacyHeaders: false });

  // ---------------- announcements ----------------
  app.get("/api/comms/announcements", requireSession, requirePermission("comms", "read"), async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        // RLS returns only what this role may see (school, audience, class).
        const list = await rows(client, `SELECT a.id,a.scope,a.title,a.body,a.audience,a.status,a.created_at,a.author_user_id,u.display_name AS author_name,
              ct.display_name AS class_teacher_name, (r.read_at IS NOT NULL) AS read,
              CASE WHEN a.author_user_id=$1 OR $2 IN ('principal','superintendent') THEN (SELECT count(*)::int FROM comms_announcement_reads x WHERE x.announcement_id=a.id) END AS read_count,
              a.removed_reason
            FROM comms_announcements a JOIN users u ON u.id=a.author_user_id LEFT JOIN users ct ON ct.id=a.class_teacher_id
            LEFT JOIN comms_announcement_reads r ON r.announcement_id=a.id AND r.user_id=$1
           WHERE ($2='superintendent' OR a.school_id=$3) AND (a.status='published' OR a.author_user_id=$1 OR $2 IN ('principal','superintendent'))
           ORDER BY a.created_at DESC LIMIT 100`, [req.actor.userId, req.actor.role, req.actor.schoolId]);
        return list;
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/comms/announcements", limiter, requireSession, requireCsrf, requirePermission("comms", "announce"), async (req, res, next) => {
    const a = req.actor;
    const { scope, title, body, audience = ["teacher", "parent", "pupil"] } = req.body || {};
    if (!["school", "class"].includes(scope) || !cleanText(title, 120) || !cleanText(body, 4000) ||
        !Array.isArray(audience) || audience.length < 1 || audience.length > 5 || !audience.every(r => AUDIENCE.includes(r)) || new Set(audience).size !== audience.length)
      return res.status(400).json({ error: "invalid_announcement", audience: AUDIENCE });
    if (a.role === "teacher" && scope !== "class") return res.status(403).json({ error: "teachers_post_to_their_class" });
    if (scope === "class" && a.role !== "teacher") return res.status(400).json({ error: "class_scope_is_for_teachers" });
    if (!a.schoolId) return res.status(400).json({ error: "school_required" });
    try {
      const out = await withTenantTransaction(a, async client => {
        const row = await one(client, `INSERT INTO comms_announcements(district_id,school_id,scope,class_teacher_id,title,body,audience,author_user_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,created_at`,
          [a.districtId, a.schoolId, scope, scope === "class" ? a.userId : null, title.trim(), body.trim(), audience, a.userId]);
        // Recipients: school scope = active members of the school in the audience;
        // class scope = linked pupils/guardians of the teacher's roster.
        const recipients = scope === "school"
          ? await rows(client, `SELECT DISTINCT user_id FROM memberships WHERE school_id=$1 AND status='active' AND role=ANY($2) AND user_id<>$3`, [a.schoolId, audience, a.userId])
          : await rows(client, `SELECT DISTINCT l.user_id FROM teacher_student_rosters tr JOIN student_user_links l ON l.student_id=tr.student_id AND l.status='active'
               JOIN memberships m ON m.user_id=l.user_id AND m.school_id=$2 AND m.status='active'
              WHERE tr.teacher_user_id=$1 AND ((l.relationship IN ('parent','guardian') AND 'parent'=ANY($3) AND m.role='parent') OR (l.relationship='pupil' AND 'pupil'=ANY($3) AND m.role='pupil'))`,
              [a.userId, a.schoolId, audience]);
        await enqueueNotifications(client, { districtId: a.districtId, schoolId: a.schoolId, recipients: recipients.map(r => r.user_id), kind: "announcement",
          title: title.trim(), body: body.trim().slice(0, 200), refType: "comms_announcement", refId: row.id });
        await audit(client, req, "create", "comms_announcement", row.id, `scope=${scope};recipients=${recipients.length}`);
        return { ...row, recipients: recipients.length };
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/comms/announcements/:id/read", requireSession, requireCsrf, requirePermission("comms", "read"), async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    try {
      const ok = await withTenantTransaction(req.actor, async client => {
        const a = await one(client, `SELECT id FROM comms_announcements WHERE id=$1 AND status='published'`, [req.params.id]);
        if (!a) return false;
        await client.query(`INSERT INTO comms_announcement_reads(announcement_id,district_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [a.id, req.actor.districtId, req.actor.userId]);
        return true;
      });
      if (!ok) return res.status(404).json({ error: "announcement_not_found" });
      res.json({ data: { read: true } });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/comms/announcements/:id/remove", requireSession, requireCsrf, requirePermission("comms", "announce"), async (req, res, next) => {
    const { reason } = req.body || {};
    if (!validId(req.params.id) || !cleanText(reason, 500)) return res.status(400).json({ error: "reason_required" });
    try {
      const n = await withTenantTransaction(req.actor, async client => {
        const r = await client.query(`UPDATE comms_announcements SET status='removed',removed_by=$2,removed_at=now(),removed_reason=$3
            WHERE id=$1 AND status='published' AND (author_user_id=$2 OR $4='superintendent' OR ($4='principal' AND school_id=$5))`,
          [req.params.id, req.actor.userId, reason.trim(), req.actor.role, req.actor.schoolId]);
        if (r.rowCount) await audit(client, req, "moderate", "comms_announcement", req.params.id, "removed");
        return r.rowCount;
      });
      if (!n) return res.status(404).json({ error: "announcement_not_found" });
      res.json({ data: { removed: true } });
    } catch (e) { sendError(res, next, e); }
  });

  // ---------------- threads ----------------
  app.get("/api/comms/contacts", requireSession, requirePermission("comms", "message"), async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, client => contactsFor(client, req.actor));
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.get("/api/comms/threads", requireSession, requirePermission("comms", "read"), async (req, res, next) => {
    if (req.actor.role === "pupil") return res.json({ data: [], policy: "students_read_announcements_only" });
    try {
      const data = await withTenantTransaction(req.actor, client => rows(client, `SELECT t.id,t.kind,t.subject,t.status,t.last_message_at,t.student_id,st.display_name AS student_name,
            (SELECT string_agg(u.display_name, ', ' ORDER BY u.display_name) FROM comms_participants p JOIN users u ON u.id=p.user_id WHERE p.thread_id=t.id AND p.user_id<>$1 AND p.left_at IS NULL) AS with_names,
            (SELECT m.body FROM comms_messages m WHERE m.thread_id=t.id AND m.hidden_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS last_body,
            (SELECT count(*)::int FROM comms_messages m WHERE m.thread_id=t.id AND m.author_user_id<>$1
               AND NOT EXISTS(SELECT 1 FROM comms_message_reads r WHERE r.message_id=m.id AND r.user_id=$1)) AS unread
          FROM comms_threads t JOIN comms_participants me ON me.thread_id=t.id AND me.user_id=$1 AND me.left_at IS NULL
          LEFT JOIN students st ON st.id=t.student_id ORDER BY t.last_message_at DESC LIMIT 100`, [req.actor.userId]));
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/comms/threads", limiter, requireSession, requireCsrf, requirePermission("comms", "message"), async (req, res, next) => {
    const a = req.actor;
    const { kind, subject, studentId = null, participantIds, body } = req.body || {};
    if (!["family", "staff"].includes(kind) || !cleanText(subject, 160) || !cleanText(body, 4000) || !Array.isArray(participantIds) ||
        participantIds.length < 1 || participantIds.length > 10 || !participantIds.every(validId) || (kind === "family" && !validId(studentId)))
      return res.status(400).json({ error: "invalid_thread" });
    if (kind === "staff" && a.role === "parent") return res.status(403).json({ error: "families_use_family_threads" });
    if (kind === "family" && a.role === "driver") return res.status(403).json({ error: "drivers_use_staff_threads" });
    try {
      const out = await withTenantTransaction(a, async client => {
        const allowed = await contactsFor(client, a);
        const people = new Map();
        for (const id of new Set(participantIds)) {
          const c = allowed.find(x => x.user_id === id && (kind === "staff" ? STAFF.includes(x.role) && !x.student_id : x.student_id === studentId || (STAFF.includes(x.role) && !x.student_id && a.role !== "parent" && x.role !== "driver")));
          if (!c) throw new HttpError(403, "participant_not_allowed", { userId: id });
          people.set(id, c.role);
        }
        if (kind === "family") {
          const roles = [a.role, ...people.values()];
          if (!roles.includes("parent") || !roles.some(r => r === "teacher" || r === "principal")) throw new HttpError(400, "family_thread_needs_guardian_and_staff");
          if (a.role !== "parent") {
            const scoped = await one(client, `SELECT 1 FROM students s WHERE s.id=$1 AND s.school_id=$2 AND ($3<>'teacher' OR EXISTS(SELECT 1 FROM teacher_student_rosters tr WHERE tr.student_id=s.id AND tr.teacher_user_id=$4))`, [studentId, a.schoolId, a.role, a.userId]);
            if (!scoped) throw new HttpError(403, "student_not_in_scope");
          }
        }
        const t = await one(client, `INSERT INTO comms_threads(district_id,school_id,kind,subject,student_id,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,school_id`,
          [a.districtId, a.schoolId, kind, subject.trim(), kind === "family" ? studentId : null, a.userId]);
        await client.query(`INSERT INTO comms_participants(thread_id,district_id,user_id,role,added_by) VALUES($1,$2,$3,$4,$3)`, [t.id, a.districtId, a.userId, a.role]);
        for (const [id, role] of people)
          await client.query(`INSERT INTO comms_participants(thread_id,district_id,user_id,role,added_by) VALUES($1,$2,$3,$4,$5)`, [t.id, a.districtId, id, role, a.userId]);
        await client.query(`INSERT INTO comms_messages(district_id,school_id,thread_id,author_user_id,body) VALUES($1,$2,$3,$4,$5)`, [a.districtId, t.school_id, t.id, a.userId, body.trim()]);
        await notifyThread(client, a, t, `New message: ${subject.trim().slice(0, 120)}`);
        await audit(client, req, "create", "comms_thread", t.id, `kind=${kind};participants=${people.size + 1}`);
        return { id: t.id };
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  app.get("/api/comms/threads/:id", requireSession, requirePermission("comms", "message"), async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const t = await one(client, `SELECT t.id,t.kind,t.subject,t.status,t.lock_reason,t.student_id,st.display_name AS student_name,t.school_id,t.discoverable,t.description
            FROM comms_threads t JOIN comms_participants me ON me.thread_id=t.id AND me.user_id=$2 AND me.left_at IS NULL LEFT JOIN students st ON st.id=t.student_id WHERE t.id=$1`, [req.params.id, req.actor.userId]);
        if (!t) return null;
        const participants = await rows(client, `SELECT p.user_id,u.display_name AS name,p.role FROM comms_participants p JOIN users u ON u.id=p.user_id WHERE p.thread_id=$1 AND p.left_at IS NULL ORDER BY p.added_at`, [t.id]);
        const messages = await rows(client, `SELECT m.id,m.author_user_id,u.display_name AS author_name,
              CASE WHEN m.hidden_at IS NULL THEN m.body END AS body,(m.hidden_at IS NOT NULL) AS hidden,m.created_at,
              coalesce((SELECT json_agg(json_build_object('userId',r.user_id,'name',ru.display_name,'readAt',r.read_at) ORDER BY r.read_at)
                 FROM comms_message_reads r JOIN users ru ON ru.id=r.user_id WHERE r.message_id=m.id), '[]'::json) AS read_by
            FROM comms_messages m JOIN users u ON u.id=m.author_user_id WHERE m.thread_id=$1 ORDER BY m.created_at,m.id`, [t.id]);
        // Opening the thread marks others' messages read (read receipts).
        await client.query(`INSERT INTO comms_message_reads(message_id,district_id,user_id)
            SELECT m.id,$2,$3 FROM comms_messages m WHERE m.thread_id=$1 AND m.author_user_id<>$3 ON CONFLICT DO NOTHING`, [t.id, req.actor.districtId, req.actor.userId]);
        if (t.student_id) await audit(client, req, "read", "comms_thread", t.id, "family_thread");
        return { ...t, participants, messages };
      });
      if (!data) return res.status(404).json({ error: "thread_not_found" });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/comms/threads/:id/messages", limiter, requireSession, requireCsrf, requirePermission("comms", "message"), async (req, res, next) => {
    const { body } = req.body || {};
    if (!validId(req.params.id) || !cleanText(body, 4000)) return res.status(400).json({ error: "invalid_message" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const t = await one(client, `SELECT t.id,t.status,t.school_id,t.subject FROM comms_threads t JOIN comms_participants p ON p.thread_id=t.id AND p.user_id=$2 AND p.left_at IS NULL WHERE t.id=$1`, [req.params.id, req.actor.userId]);
        if (!t) throw new HttpError(404, "thread_not_found");
        if (t.status !== "open") throw new HttpError(409, "thread_locked");
        const m = await one(client, `INSERT INTO comms_messages(district_id,school_id,thread_id,author_user_id,body) VALUES($1,$2,$3,$4,$5) RETURNING id,created_at`,
          [req.actor.districtId, t.school_id, t.id, req.actor.userId, body.trim()]);
        await client.query(`UPDATE comms_threads SET last_message_at=now() WHERE id=$1`, [t.id]);
        await notifyThread(client, req.actor, t, `New reply: ${t.subject.slice(0, 120)}`);
        await audit(client, req, "create", "comms_message", m.id, `thread=${t.id}`);
        return m;
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  // ---------------- moderation ----------------
  app.post("/api/comms/messages/:id/report", limiter, requireSession, requireCsrf, requirePermission("comms", "message"), async (req, res, next) => {
    const { reason } = req.body || {};
    if (!validId(req.params.id) || !cleanText(reason, 500)) return res.status(400).json({ error: "reason_required" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const m = await one(client, `SELECT m.id,m.school_id FROM comms_messages m JOIN comms_participants p ON p.thread_id=m.thread_id AND p.user_id=$2 WHERE m.id=$1`, [req.params.id, req.actor.userId]);
        if (!m) throw new HttpError(404, "message_not_found");
        const r = await one(client, `INSERT INTO comms_reports(district_id,school_id,message_id,reported_by,reason) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT (message_id,reported_by) DO NOTHING RETURNING id`, [req.actor.districtId, m.school_id, m.id, req.actor.userId, reason.trim()]);
        if (r) {
          const mods = await rows(client, `SELECT user_id FROM memberships WHERE school_id=$1 AND role='principal' AND status='active'`, [m.school_id]);
          await enqueueNotifications(client, { districtId: req.actor.districtId, schoolId: m.school_id, recipients: mods.map(x => x.user_id), kind: "moderation",
            title: "A message was reported for review", body: null, refType: "comms_report", refId: r.id });
          await audit(client, req, "report", "comms_message", m.id);
        }
        return { reported: true };
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  app.get("/api/comms/reports", requireSession, requirePermission("comms", "moderate"), async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const list = await rows(client, `SELECT r.id,r.reason,r.status,r.resolution,r.created_at,ru.display_name AS reported_by_name,
              m.id AS message_id,m.body,(m.hidden_at IS NOT NULL) AS hidden,au.display_name AS author_name,t.id AS thread_id,t.subject,t.status AS thread_status
            FROM comms_reports r JOIN comms_messages m ON m.id=r.message_id JOIN comms_threads t ON t.id=m.thread_id
            JOIN users ru ON ru.id=r.reported_by JOIN users au ON au.id=m.author_user_id
           WHERE ($1='superintendent' OR r.school_id=$2) ORDER BY r.status='open' DESC, r.created_at DESC LIMIT 100`, [req.actor.role, req.actor.schoolId]);
        await audit(client, req, "read", "comms_reports", null, `reports=${list.length}`);
        return list;
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/comms/reports/:id/resolve", requireSession, requireCsrf, requirePermission("comms", "moderate"), async (req, res, next) => {
    const { action, reason } = req.body || {};
    if (!validId(req.params.id) || !["hide", "dismiss"].includes(action) || !cleanText(reason, 500)) return res.status(400).json({ error: "invalid_resolution" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const r = await one(client, `SELECT id,message_id,school_id,status FROM comms_reports WHERE id=$1 AND ($2='superintendent' OR school_id=$3)`, [req.params.id, req.actor.role, req.actor.schoolId]);
        if (!r) throw new HttpError(404, "report_not_found");
        if (r.status !== "open") throw new HttpError(409, "already_resolved");
        if (action === "hide")
          await client.query(`UPDATE comms_messages SET hidden_at=now(),hidden_by=$2,hidden_reason=$3 WHERE id=$1 AND hidden_at IS NULL`, [r.message_id, req.actor.userId, reason.trim()]);
        await client.query(`UPDATE comms_reports SET status='resolved',resolution=$2,resolved_by=$3,resolved_at=now() WHERE message_id=$1 AND status='open'`,
          [r.message_id, action === "hide" ? "hidden" : "dismissed", req.actor.userId]);
        await audit(client, req, "moderate", "comms_message", r.message_id, `${action}: ${reason.trim()}`);
        return { resolved: true, action };
      });
      res.json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/comms/threads/:id/lock", requireSession, requireCsrf, requirePermission("comms", "moderate"), async (req, res, next) => {
    const { reason } = req.body || {};
    if (!validId(req.params.id) || !cleanText(reason, 500)) return res.status(400).json({ error: "reason_required" });
    try {
      const n = await withTenantTransaction(req.actor, async client => {
        const r = await client.query(`UPDATE comms_threads SET status='locked',locked_by=$2,locked_at=now(),lock_reason=$3 WHERE id=$1 AND status='open'
            AND ($4='superintendent' OR school_id=$5)`, [req.params.id, req.actor.userId, reason.trim(), req.actor.role, req.actor.schoolId]);
        if (r.rowCount) await audit(client, req, "moderate", "comms_thread", req.params.id, `locked: ${reason.trim()}`);
        return r.rowCount;
      });
      if (!n) return res.status(404).json({ error: "thread_not_found" });
      res.json({ data: { locked: true } });
    } catch (e) { sendError(res, next, e); }
  });

  // ---------------- in-app notifications ----------------
  app.get("/api/notifications", requireSession, async (req, res, next) => {
    try {
      // ?summary=1: the unread count only. The role apps poll it every 30
      // seconds, and the latest 50 notifications (up to ~30 KB) aren't needed
      // for a badge.
      const summary = req.query.summary === "1";
      const data = await withTenantTransaction(req.actor, async client => ({
        ...(summary ? {} : { items: await rows(client, `SELECT id,kind,title,body,ref_type,ref_id,created_at,read_at FROM notification_outbox
            WHERE recipient_user_id=$1 AND channel='in_app' ORDER BY created_at DESC LIMIT 50`, [req.actor.userId]) }),
        unread: (await one(client, `SELECT count(*)::int AS n FROM notification_outbox WHERE recipient_user_id=$1 AND channel='in_app' AND read_at IS NULL`, [req.actor.userId])).n
      }));
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });
  app.post("/api/notifications/read", requireSession, requireCsrf, async (req, res, next) => {
    const ids = req.body?.ids;
    if (ids !== undefined && !(Array.isArray(ids) && ids.length <= 200 && ids.every(validId))) return res.status(400).json({ error: "invalid_ids" });
    try {
      const n = await withTenantTransaction(req.actor, async client => (await client.query(
        `UPDATE notification_outbox SET read_at=now() WHERE recipient_user_id=$1 AND channel='in_app' AND read_at IS NULL AND ($2::uuid[] IS NULL OR id=ANY($2))`,
        [req.actor.userId, ids || null])).rowCount);
      res.json({ data: { marked: n } });
    } catch (e) { sendError(res, next, e); }
  });
}
