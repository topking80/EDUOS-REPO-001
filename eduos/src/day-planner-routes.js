// Student app Phase B: the day planner (db/172, docs/STUDENT-DAY-PLANNER.md).
//
// Learners and their families:
//   GET  /api/learning/schedule?from=YYYY-MM-DD&days=1..42&studentId=   the learner's classes and club or sport events
// A course's teacher, or the school's principal or vice principal:
//   GET  /api/courses/:id/meetings                                       class times, upcoming changes (with staff notes), rooms
//   POST /api/courses/:id/meetings {weekdays[1-7], starts, ends, periodLabel?, roomId?, effectiveFrom, effectiveUntil?}
//   POST /api/course-meetings/:id/end
//   POST /api/courses/:id/changes {day, kind: cancelled|moved|retimed, roomId?, starts?, ends?, studentNote?, staffNote?}
//   POST /api/course-meeting-changes/:id/withdraw
// School staff read the school calendar; the principal or vice principal changes it:
//   GET  /api/school-calendar?from&to
//   POST /api/school-calendar {day, kind: no_school|early_release|late_start|modified, label, bellScheduleId?}
//   POST /api/school-calendar/:id/remove
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { resolveLearner } from "./learning-service.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";

const isDay = v => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number), t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const isTime = v => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const ymd = v => v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}` : v;
const hm = v => typeof v === "string" ? v.slice(0, 5) : v;
const CHANGE_KINDS = ["cancelled", "moved", "retimed"], DAY_KINDS = ["no_school", "early_release", "late_start", "modified"];

export function registerDayPlannerRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `dp:${req.actor?.userId}` });
  const run = (fn, code = 200) => async (req, res, next) => {
    try {
      if (req.actor?.tenantKind && req.actor.tenantKind !== "district") throw new HttpError(403, "district_context_required");
      const data = await withTenantTransaction(req.actor, c => fn(c, req));
      res.setHeader("Cache-Control", "no-store"); res.status(code).json({ data });
    } catch (e) {
      if (e.code === "42501") return sendError(res, next, new HttpError(403, "not_allowed"));
      if (e.code === "23514") return sendError(res, next, new HttpError(409, "not_at_this_school"));
      if (e.code === "23505") return sendError(res, next, new HttpError(409, "already_set_for_that_day"));
      sendError(res, next, e);
    }
  };
  const course = async (c, id) => {
    if (!validId(id)) throw new HttpError(400, "invalid_id");
    const k = await one(c, "SELECT id, school_id, title, eduos_can_manage_course(id) AS can FROM courses WHERE id=$1", [id]);
    if (!k || !k.can) throw new HttpError(404, "course_not_found");
    return k;
  };
  const lead = req => { if (!["principal", "vice_principal"].includes(req.actor.role) || !req.actor.schoolId) throw new HttpError(403, "principal_or_vice_principal_only"); };

  // ---------- the learner's schedule ----------
  app.get("/api/learning/schedule", requireSession, run(async (c, req) => {
    if (!["pupil", "parent"].includes(req.actor.role)) throw new HttpError(403, "learners_and_families_only");
    const learner = await resolveLearner(c, req.actor, req.query.studentId);
    const from = req.query.from === undefined ? null : req.query.from;
    if (from !== null && !isDay(from)) throw new HttpError(400, "invalid_from");
    const days = req.query.days === undefined ? 7 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 1 || days > 42) throw new HttpError(400, "days_1_to_42");
    const r = await one(c, "SELECT eduos_learner_schedule($1, $2::date, $3) AS s", [learner.id, from, days]);
    if (!r?.s) throw new HttpError(403, "no_linked_learner");
    return { student: { id: learner.id, name: learner.display_name }, generatedAt: new Date().toISOString(), ...r.s };
  }));

  // ---------- class times ----------
  app.get("/api/courses/:id/meetings", requireSession, run(async (c, req) => {
    const k = await course(c, req.params.id);
    const meetings = await rows(c, `SELECT m.*, r.name AS room FROM course_meetings m LEFT JOIN classroom_rooms r ON r.id=m.room_id
      WHERE m.course_id=$1 AND m.ended_at IS NULL ORDER BY m.effective_from, m.starts`, [k.id]);
    const changes = await rows(c, `SELECT ch.*, r.name AS room FROM course_meeting_changes ch LEFT JOIN classroom_rooms r ON r.id=ch.room_id
      WHERE ch.course_id=$1 AND ch.withdrawn_at IS NULL AND ch.day >= (now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=$2))::date - 1 ORDER BY ch.day`, [k.id, k.school_id]);
    const rooms = await rows(c, "SELECT id, name FROM classroom_rooms WHERE school_id=$1 AND archived_at IS NULL ORDER BY name", [k.school_id]);
    return { course: { id: k.id, title: k.title }, rooms,
      meetings: meetings.map(m => ({ id: m.id, weekdays: m.weekdays, starts: hm(m.starts), ends: hm(m.ends), periodLabel: m.period_label, roomId: m.room_id, room: m.room,
        effectiveFrom: ymd(m.effective_from), effectiveUntil: ymd(m.effective_until) })),
      changes: changes.map(x => ({ id: x.id, day: ymd(x.day), kind: x.kind, roomId: x.room_id, room: x.room, starts: hm(x.starts), ends: hm(x.ends), studentNote: x.student_note, staffNote: x.staff_note })) };
  }));
  app.post("/api/courses/:id/meetings", limiter, requireSession, requireCsrf, run(async (c, req) => {
    const k = await course(c, req.params.id), b = req.body || {};
    const bad = [];
    if (!Array.isArray(b.weekdays) || !b.weekdays.length || b.weekdays.length > 7 || !b.weekdays.every(d => Number.isInteger(d) && d >= 1 && d <= 7) || new Set(b.weekdays).size !== b.weekdays.length) bad.push("weekdays");
    if (!isTime(b.starts) || !isTime(b.ends) || b.ends <= b.starts) bad.push("starts/ends");
    if (b.periodLabel != null && !cleanText(b.periodLabel, 60)) bad.push("periodLabel");
    if (b.roomId != null && !validId(b.roomId)) bad.push("roomId");
    if (!isDay(b.effectiveFrom)) bad.push("effectiveFrom");
    if (b.effectiveUntil != null && (!isDay(b.effectiveUntil) || b.effectiveUntil < b.effectiveFrom)) bad.push("effectiveUntil");
    if (bad.length) throw new HttpError(400, "invalid_meeting", { fields: bad });
    const m = await one(c, `INSERT INTO course_meetings(district_id, school_id, course_id, weekdays, starts, ends, period_label, room_id, effective_from, effective_until, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [req.actor.districtId, k.school_id, k.id, [...b.weekdays].sort(), b.starts, b.ends, b.periodLabel?.trim() || null, b.roomId || null, b.effectiveFrom, b.effectiveUntil || null, req.actor.userId]);
    await audit(c, req, "create", "course_meeting", m.id, `course=${k.id};days=${b.weekdays.join("")};${b.starts}-${b.ends}`);
    return { id: m.id };
  }, 201));
  app.post("/api/course-meetings/:id/end", limiter, requireSession, requireCsrf, run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const r = await c.query("UPDATE course_meetings SET ended_by=$2, ended_at=now(), updated_at=now() WHERE id=$1 AND ended_at IS NULL RETURNING course_id", [req.params.id, req.actor.userId]);
    if (!r.rowCount) throw new HttpError(404, "meeting_not_found");
    await audit(c, req, "end", "course_meeting", req.params.id, `course=${r.rows[0].course_id}`);
    return { ended: true };
  }));
  app.post("/api/courses/:id/changes", limiter, requireSession, requireCsrf, run(async (c, req) => {
    const k = await course(c, req.params.id), b = req.body || {};
    const bad = [];
    if (!isDay(b.day)) bad.push("day");
    if (!CHANGE_KINDS.includes(b.kind)) bad.push("kind");
    if (b.kind === "moved" && !validId(b.roomId)) bad.push("roomId");
    if (b.kind === "retimed" && (!isTime(b.starts) || !isTime(b.ends) || b.ends <= b.starts)) bad.push("starts/ends");
    if (b.studentNote != null && !cleanText(b.studentNote, 300)) bad.push("studentNote");
    if (b.staffNote != null && !cleanText(b.staffNote, 1000)) bad.push("staffNote");
    if (bad.length) throw new HttpError(400, "invalid_change", { fields: bad });
    const x = await one(c, `INSERT INTO course_meeting_changes(district_id, school_id, course_id, day, kind, room_id, starts, ends, student_note, staff_note, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [req.actor.districtId, k.school_id, k.id, b.day, b.kind, b.kind === "moved" ? b.roomId : null, b.kind === "retimed" ? b.starts : null, b.kind === "retimed" ? b.ends : null,
        b.studentNote?.trim() || null, b.staffNote?.trim() || null, req.actor.userId]);
    await audit(c, req, b.kind, "course_meeting_change", x.id, `course=${k.id};day=${b.day}`);
    return { id: x.id };
  }, 201));
  app.post("/api/course-meeting-changes/:id/withdraw", limiter, requireSession, requireCsrf, run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const r = await c.query("UPDATE course_meeting_changes SET withdrawn_by=$2, withdrawn_at=now() WHERE id=$1 AND withdrawn_at IS NULL RETURNING course_id, day", [req.params.id, req.actor.userId]);
    if (!r.rowCount) throw new HttpError(404, "change_not_found");
    await audit(c, req, "withdraw", "course_meeting_change", req.params.id, `course=${r.rows[0].course_id}`);
    return { withdrawn: true };
  }));

  // ---------- the school calendar ----------
  app.get("/api/school-calendar", requireSession, run(async (c, req) => {
    if (["pupil", "parent"].includes(req.actor.role) || !req.actor.schoolId) throw new HttpError(403, "school_staff_only");
    const from = isDay(req.query.from) ? req.query.from : null, to = isDay(req.query.to) ? req.query.to : null;
    const list = await rows(c, `SELECT k.*, b.name AS bell_schedule FROM school_calendar_days k LEFT JOIN school_bell_schedules b ON b.id=k.bell_schedule_id
      WHERE k.school_id=$1 AND k.removed_at IS NULL AND k.day >= coalesce($2::date, (now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=$1))::date)
        AND ($3::date IS NULL OR k.day <= $3::date) ORDER BY k.day LIMIT 200`, [req.actor.schoolId, from, to]);
    return list.map(k => ({ id: k.id, day: ymd(k.day), kind: k.kind, label: k.label, bellScheduleId: k.bell_schedule_id, bellSchedule: k.bell_schedule }));
  }));
  app.post("/api/school-calendar", limiter, requireSession, requireCsrf, run(async (c, req) => {
    lead(req);
    const b = req.body || {};
    if (!isDay(b.day) || !DAY_KINDS.includes(b.kind) || !cleanText(b.label, 120, 2) || (b.bellScheduleId != null && (!validId(b.bellScheduleId) || b.kind === "no_school")))
      throw new HttpError(400, "invalid_calendar_day");
    const k = await one(c, "INSERT INTO school_calendar_days(district_id, school_id, day, kind, label, bell_schedule_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [req.actor.districtId, req.actor.schoolId, b.day, b.kind, b.label.trim(), b.bellScheduleId || null, req.actor.userId]);
    await audit(c, req, "create", "school_calendar_day", k.id, `${b.day};${b.kind}`);
    return { id: k.id };
  }, 201));
  app.post("/api/school-calendar/:id/remove", limiter, requireSession, requireCsrf, run(async (c, req) => {
    lead(req);
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const r = await c.query("UPDATE school_calendar_days SET removed_by=$2, removed_at=now() WHERE id=$1 AND school_id=$3 AND removed_at IS NULL", [req.params.id, req.actor.userId, req.actor.schoolId]);
    if (!r.rowCount) throw new HttpError(404, "calendar_day_not_found");
    await audit(c, req, "remove", "school_calendar_day", req.params.id);
    return { removed: true };
  }));
}
