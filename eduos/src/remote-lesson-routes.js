// ROOM-02: remote lessons on the teacher's daily schedule (db/112).
//
// The course's teacher:
//   PUT  /api/courses/:id/remote-lessons/:date   add or change the day's {starts, ends, joinUrl, lessonId?, note?}
//   POST /api/remote-lessons/:id/cancel
// The teacher and the school's leaders:
//   GET  /api/courses/:id/remote-lessons?from=&to=   with who joined
// Teachers (courses they teach) and students (courses they're enrolled in):
//   GET  /api/my/remote-lessons                    today and the next week
// Students:
//   POST /api/remote-lessons/:id/join              checks in as remote; returns the link
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { meetingProvider } from "./remote-lesson.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const validDate = d => typeof d === "string" && DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
const ymd = d => d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
const out = (s, extra = {}) => ({ id: s.id, courseId: s.course_id, course: s.course, date: ymd(s.lesson_date), starts: String(s.starts).slice(0, 5), ends: String(s.ends).slice(0, 5),
  joinUrl: s.join_url, provider: meetingProvider(s.join_url), lessonId: s.lesson_id, lesson: s.lesson ?? null, note: s.note, ...extra });

export function registerRemoteLessonRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const run = (fn, ok = 200) => async (req, res, next) => {
    try { const r = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(ok).json({ data: r }); }
    catch (e) { if (e.code === "23505") return res.status(409).json({ error: "already_scheduled" }); sendError(res, next, e); }
  };
  const only = roles => (req, res, next) => roles.includes(req.actor?.role) ? next() : res.status(403).json({ error: "forbidden" });

  app.put("/api/courses/:id/remote-lessons/:date", limiter, requireSession, requireCsrf, only(["teacher"]), run(async (c, req) => {
    const { starts, ends, joinUrl, lessonId = null, note = null } = req.body || {};
    if (!validId(req.params.id) || !validDate(req.params.date)) throw new HttpError(400, "invalid_remote_lesson");
    if (!TIME.test(starts || "") || !TIME.test(ends || "") || ends <= starts) throw new HttpError(400, "invalid_times");
    if (!meetingProvider(joinUrl)) throw new HttpError(400, "meeting_link_not_allowed");
    if (lessonId !== null && !validId(lessonId)) throw new HttpError(400, "invalid_remote_lesson");
    if (note !== null && note !== "" && !cleanText(note, 500)) throw new HttpError(400, "invalid_remote_lesson");
    const course = await one(c, `SELECT id,school_id FROM courses WHERE id=$1 AND teacher_user_id=$2 AND status<>'archived'`, [req.params.id, req.actor.userId]);
    if (!course) throw new HttpError(404, "course_not_found");
    // Remote students must be able to open the lesson: published, in this course.
    if (lessonId && !(await one(c, `SELECT 1 FROM lessons WHERE id=$1 AND course_id=$2 AND status='published'`, [lessonId, course.id]))) throw new HttpError(400, "lesson_must_be_published_in_this_course");
    const v = [starts, ends, new URL(joinUrl).href, lessonId, note?.trim() || null]; // the normalized link (lowercase host)
    let s = await one(c, `UPDATE class_remote_lessons SET starts=$3,ends=$4,join_url=$5,lesson_id=$6,note=$7,updated_at=now() WHERE course_id=$1 AND lesson_date=$2 AND cancelled_at IS NULL RETURNING *`,
      [course.id, req.params.date, ...v]);
    if (!s) s = await one(c, `INSERT INTO class_remote_lessons(district_id,school_id,course_id,lesson_date,starts,ends,join_url,lesson_id,note,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [req.actor.districtId, course.school_id, course.id, req.params.date, ...v, req.actor.userId]);
    await audit(c, req, "update", "remote_lesson", s.id, `${req.params.date} ${meetingProvider(joinUrl)}`);
    return out(s);
  }));

  app.post("/api/remote-lessons/:id/cancel", limiter, requireSession, requireCsrf, only(["teacher"]), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const s = await one(c, `UPDATE class_remote_lessons SET cancelled_at=now() WHERE id=$1 AND cancelled_at IS NULL AND eduos_teaches_course(course_id) RETURNING id`, [req.params.id]);
    if (!s) throw new HttpError(404, "remote_lesson_not_found");
    await audit(c, req, "cancel", "remote_lesson", s.id, null);
    return { cancelled: true };
  }));

  app.get("/api/courses/:id/remote-lessons", requireSession, only(["teacher", "principal", "vice_principal", "superintendent"]), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const from = validDate(req.query.from) ? req.query.from : null, to = validDate(req.query.to) ? req.query.to : null;
    const list = await rows(c, `SELECT s.*,co.title AS course,l.title AS lesson FROM class_remote_lessons s JOIN courses co ON co.id=s.course_id LEFT JOIN lessons l ON l.id=s.lesson_id
        WHERE s.course_id=$1 AND s.cancelled_at IS NULL AND ($2::date IS NULL OR s.lesson_date>=$2) AND ($3::date IS NULL OR s.lesson_date<=$3) ORDER BY s.lesson_date,s.starts LIMIT 200`, [req.params.id, from, to]);
    const joined = list.length ? await rows(c, `SELECT k.session_id,k.checked_in_at,st.display_name AS name FROM remote_lesson_checkins k JOIN students st ON st.id=k.student_id
        WHERE k.session_id = ANY($1) ORDER BY k.checked_in_at`, [list.map(s => s.id)]) : [];
    return list.map(s => out(s, { joined: joined.filter(j => j.session_id === s.id).map(j => ({ name: j.name, at: j.checked_in_at })) }));
  }));

  app.get("/api/my/remote-lessons", requireSession, only(["teacher", "pupil"]), run(async (c, req) => {
    const list = await rows(c, `SELECT s.*,co.title AS course,l.title AS lesson,
        (now() AT TIME ZONE sc.timezone)::date AS today,
        (now() AT TIME ZONE sc.timezone) >= s.lesson_date + s.starts - interval '10 minutes' AND (now() AT TIME ZONE sc.timezone) < s.lesson_date + s.ends AS open,
        EXISTS (SELECT 1 FROM remote_lesson_checkins k WHERE k.session_id=s.id AND k.user_id=$1) AS joined
        FROM class_remote_lessons s JOIN courses co ON co.id=s.course_id JOIN schools sc ON sc.id=s.school_id LEFT JOIN lessons l ON l.id=s.lesson_id
        WHERE s.cancelled_at IS NULL AND s.lesson_date BETWEEN (now() AT TIME ZONE sc.timezone)::date AND (now() AT TIME ZONE sc.timezone)::date + 7
          AND ($2 <> 'teacher' OR co.teacher_user_id=$1) ORDER BY s.lesson_date,s.starts LIMIT 50`, [req.actor.userId, req.actor.role]);
    return list.map(s => out(s, { today: ymd(s.lesson_date) === ymd(s.today), open: s.open, joined: s.joined,
      // Students get the link from Join (which checks them in), not from the list.
      joinUrl: req.actor.role === "teacher" ? s.join_url : undefined }));
  }));

  app.post("/api/remote-lessons/:id/join", limiter, requireSession, requireCsrf, only(["pupil"]), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const r = (await one(c, `SELECT eduos_remote_lesson_join($1) AS out`, [req.params.id])).out;
    if (r.error) throw new HttpError(r.error === "not_now" ? 409 : 404, r.error);
    await audit(c, req, "join", "remote_lesson", req.params.id, r.already ? "again" : "checked_in");
    return r;
  }, 201));
}
