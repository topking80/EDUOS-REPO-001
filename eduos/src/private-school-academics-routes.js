// HSP-04: private school admissions and academics, in a private-school session (db/163).
//
// Admissions (school admin, registrar, campus admin for their campus; verified schools):
//   GET  /api/private-school/admissions                ?schoolYear&status
//   POST /api/private-school/admissions                {campusId, applicantName, gradeLevel?, schoolYear, guardianName?, guardianEmail?, documents?: [label], notes?}
//                                                     or {learnerId, schoolYear}: re-enrollment of a current learner
//   GET  /api/private-school/admissions/:id            with its history
//   PATCH /api/private-school/admissions/:id           {documents?: [{label, received}], notes?, guardianName?, guardianEmail?, gradeLevel?}
//   POST /api/private-school/admissions/:id/status     {status, note?, waitlistPosition?}: one step of the lifecycle
//   POST /api/private-school/admissions/:id/enroll     {enrolledOn?, localNumber?}: an accepted applicant becomes a learner
// Classes and schedule:
//   GET/POST /api/private-school/classes, GET/PATCH /api/private-school/classes/:id
//   PUT  /api/private-school/classes/:id/meetings      [{weekday 1-7, starts "HH:MM", ends, room?}]
//   POST /api/private-school/classes/:id/roster        {learnerId}; POST .../roster/:learnerId/remove
//   GET  /api/private-school/schedule                  this week's meetings you can see
// Attendance:
//   GET  /api/private-school/attendance                ?day&classId: the class roster (or campus learners) with marks
//   POST /api/private-school/attendance                {day, classId?, marks: [{learnerId, status, note?}]}
//   GET  /api/private-school/learners/:id/attendance   ?from&to: marks and totals
// Report cards:
//   GET/POST /api/private-school/report-cards          ?schoolYear&term / {learnerId, schoolYear, term}
//   GET  /api/private-school/report-cards/:id
//   PUT  /api/private-school/report-cards/:id/lines/:classId   {grade?, comment?}: the class's teacher, while a draft
//   POST /api/private-school/report-cards/:id/publish  {comment?}: then guardians see it
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { rows, one, validId, cleanText, HttpError } from "./role-app-util.js";
import { school, psAudit } from "./private-school-routes.js";

const GRADES = ["pre_k", "k", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
const YEAR = v => typeof v === "string" && /^(\d{4})-(\d{4})$/.test(v) && Number(v.slice(5)) === Number(v.slice(0, 4)) + 1;
const DAY = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const TIME = v => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const MARKS = ["present", "tardy", "absent", "excused"];
const emailOk = v => typeof v === "string" && v.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const today = () => new Date().toISOString().slice(0, 10);
const ymd = v => v instanceof Date ? v.toISOString().slice(0, 10) : v;
const hhmm = v => String(v).slice(0, 5);

// The admissions lifecycle: where each status may go next.
export const NEXT = {
  inquiry: ["applied", "withdrawn"],
  applied: ["under_review", "withdrawn"],
  under_review: ["offered", "waitlisted", "not_offered", "withdrawn"],
  waitlisted: ["offered", "not_offered", "withdrawn", "waitlisted"],
  offered: ["accepted", "declined", "withdrawn"],
  accepted: ["withdrawn"],          // enrolled only through /enroll
  declined: [], withdrawn: [], not_offered: [], enrolled: [],
};
const DECISIONS = ["offered", "waitlisted", "not_offered"];
const appOut = a => ({ id: a.id, campusId: a.campus_id, kind: a.kind, learnerId: a.learner_id, applicantName: a.applicant_name, gradeLevel: a.grade_level, schoolYear: a.school_year,
  guardianName: a.guardian_name, guardianEmail: a.guardian_email, status: a.status, waitlistPosition: a.waitlist_position, documents: a.documents, notes: a.notes,
  decidedAt: a.decided_at, createdAt: a.created_at, next: NEXT[a.status] });
const classOut = k => ({ id: k.id, campusId: k.campus_id, name: k.name, subject: k.subject, gradeLevel: k.grade_level, schoolYear: k.school_year, term: k.term,
  teacherMembershipId: k.teacher_membership_id, teacher: k.teacher_name ?? undefined, status: k.status });
const docsFrom = list => list.map(x => typeof x === "string" ? { label: x.trim(), received: false } : { label: String(x.label).trim(), received: x.received === true });
const docsOk = list => Array.isArray(list) && list.length <= 30 && list.every(x => (typeof x === "string" && cleanText(x, 120)) || (x && typeof x === "object" && cleanText(x.label, 120) && (x.received === undefined || typeof x.received === "boolean")));

async function application(c, id) {
  if (!validId(id)) throw new HttpError(400, "invalid_id");
  const a = await one(c, "SELECT * FROM ps_applications WHERE id=$1", [id]);
  if (!a) throw new HttpError(404, "application_not_found");
  return a;
}
async function klass(c, id) {
  if (!validId(id)) throw new HttpError(400, "invalid_id");
  const k = await one(c, "SELECT k.*, u.display_name AS teacher_name FROM ps_classes k LEFT JOIN private_school_memberships m ON m.id=k.teacher_membership_id LEFT JOIN users u ON u.id=m.user_id WHERE k.id=$1", [id]);
  if (!k) throw new HttpError(404, "class_not_found");
  return k;
}
const runsCampus = async (c, campusId) => (await one(c, "SELECT eduos_ps_runs_campus($1) AS ok", [campusId])).ok;
const mustRun = async (c, campusId) => { if (!(await runsCampus(c, campusId))) throw new HttpError(403, "not_allowed"); };
const mustBeActive = async c => { if (!(await one(c, "SELECT eduos_ps_active() AS ok")).ok) throw new HttpError(409, "school_not_verified"); };

export function registerPrivateSchoolAcademicsRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `psa:${req.actor?.userId}` });

  // ---------- admissions ----------
  app.get("/api/private-school/admissions", requireSession, school(async (c, req) => {
    const year = YEAR(req.query.schoolYear) ? req.query.schoolYear : null, status = NEXT[req.query.status] ? req.query.status : null;
    return (await rows(c, `SELECT * FROM ps_applications WHERE ($1::text IS NULL OR school_year=$1) AND ($2::text IS NULL OR status=$2)
        ORDER BY CASE status WHEN 'waitlisted' THEN 0 ELSE 1 END, waitlist_position NULLS LAST, updated_at DESC LIMIT 500`, [year, status])).map(appOut);
  }));

  app.post("/api/private-school/admissions", limiter, requireSession, requireCsrf, school(async (c, req) => {
    await mustBeActive(c);
    const b = req.body || {};
    if (!YEAR(b.schoolYear) || (b.documents !== undefined && !docsOk(b.documents)) || (b.notes != null && (typeof b.notes !== "string" || b.notes.length > 4000)))
      throw new HttpError(400, "invalid_application", { hint: "schoolYear like 2027-2028, documents, notes" });
    let campusId = b.campusId, learnerId = null, name = b.applicantName, grade = b.gradeLevel ?? null;
    if (b.learnerId !== undefined) {
      if (!validId(b.learnerId)) throw new HttpError(400, "invalid_learner_id");
      const l = await one(c, "SELECT id, campus_id, display_name, grade_level FROM private_school_learners WHERE id=$1", [b.learnerId]);
      if (!l) throw new HttpError(404, "learner_not_found");
      ({ campus_id: campusId, id: learnerId, display_name: name } = l); grade = b.gradeLevel ?? l.grade_level;
      if (await one(c, "SELECT id FROM ps_applications WHERE learner_id=$1 AND school_year=$2 AND status NOT IN ('withdrawn','declined','not_offered')", [l.id, b.schoolYear]))
        throw new HttpError(409, "already_applied_for_that_year");
    } else if (!validId(campusId) || !cleanText(name, 120) || (grade != null && !GRADES.includes(grade)) || (b.guardianName != null && !cleanText(b.guardianName, 120)) || (b.guardianEmail != null && !emailOk(b.guardianEmail)))
      throw new HttpError(400, "invalid_application", { hint: "campusId, applicantName, gradeLevel, guardianName, guardianEmail" });
    if (!(await one(c, "SELECT id FROM private_school_campuses WHERE id=$1 AND status='active'", [campusId]))) throw new HttpError(404, "campus_not_found");
    await mustRun(c, campusId);
    const a = await one(c, `INSERT INTO ps_applications(school_id, campus_id, kind, learner_id, applicant_name, grade_level, school_year, guardian_name, guardian_email, status, documents, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [req.actor.privateSchoolId, campusId, learnerId ? "re_enrollment" : "new", learnerId, name.trim(), grade, b.schoolYear,
      learnerId ? null : b.guardianName?.trim() ?? null, learnerId ? null : b.guardianEmail?.trim().toLowerCase() ?? null, learnerId ? "applied" : "inquiry",
      JSON.stringify(docsFrom(b.documents || [])), b.notes ?? null, req.actor.userId]);
    await c.query("INSERT INTO ps_application_events(school_id, application_id, to_status, actor_user_id) VALUES ($1,$2,$3,$4)", [req.actor.privateSchoolId, a.id, a.status, req.actor.userId]);
    await psAudit(c, req, "create", "ps_application", a.id, `kind=${a.kind};year=${a.school_year}`);
    return appOut(a);
  }, 201));

  app.get("/api/private-school/admissions/:id", requireSession, school(async (c, req) => {
    const a = await application(c, req.params.id);
    const events = await rows(c, `SELECT e.from_status, e.to_status, e.note, e.occurred_at, u.display_name FROM ps_application_events e JOIN users u ON u.id=e.actor_user_id
        WHERE e.application_id=$1 ORDER BY e.id`, [a.id]);
    return { ...appOut(a), history: events.map(e => ({ from: e.from_status, to: e.to_status, note: e.note, at: e.occurred_at, by: e.display_name })) };
  }));

  app.patch("/api/private-school/admissions/:id", limiter, requireSession, requireCsrf, school(async (c, req) => {
    const a0 = await application(c, req.params.id), b = req.body || {};
    if (["enrolled", "withdrawn", "declined", "not_offered"].includes(a0.status)) throw new HttpError(409, "application_closed");
    if ((b.documents !== undefined && !docsOk(b.documents)) || (b.notes != null && (typeof b.notes !== "string" || b.notes.length > 4000)) || (b.guardianName != null && !cleanText(b.guardianName, 120))
      || (b.guardianEmail != null && !emailOk(b.guardianEmail)) || (b.gradeLevel != null && !GRADES.includes(b.gradeLevel)))
      throw new HttpError(400, "invalid_application");
    const a = await one(c, `UPDATE ps_applications SET documents=coalesce($2::jsonb, documents), notes=CASE WHEN $7 THEN $3 ELSE notes END, guardian_name=coalesce($4, guardian_name),
        guardian_email=coalesce($5, guardian_email), grade_level=coalesce($6, grade_level), updated_at=now() WHERE id=$1 RETURNING *`,
      [a0.id, b.documents ? JSON.stringify(docsFrom(b.documents)) : null, b.notes ?? null, b.guardianName?.trim() ?? null, b.guardianEmail?.trim().toLowerCase() ?? null, b.gradeLevel ?? null, "notes" in b]);
    if (!a) throw new HttpError(403, "not_allowed");
    await psAudit(c, req, "update", "ps_application", a.id, Object.keys(b).join(","));
    return appOut(a);
  }));

  app.post("/api/private-school/admissions/:id/status", limiter, requireSession, requireCsrf, school(async (c, req) => {
    const a0 = await application(c, req.params.id), b = req.body || {};
    if (!NEXT[b.status] || (b.note != null && (typeof b.note !== "string" || b.note.length > 1000))) throw new HttpError(400, "invalid_status");
    if (!NEXT[a0.status].includes(b.status)) throw new HttpError(409, "not_a_next_step", { allowed: NEXT[a0.status] });
    let position = null;
    if (b.status === "waitlisted") {
      position = Number.isInteger(b.waitlistPosition) && b.waitlistPosition >= 1 ? b.waitlistPosition
        : ((await one(c, "SELECT coalesce(max(waitlist_position), 0)::int AS n FROM ps_applications WHERE status='waitlisted' AND school_year=$1 AND campus_id=$2", [a0.school_year, a0.campus_id])).n + 1);
    }
    const decision = DECISIONS.includes(b.status);
    const a = await one(c, `UPDATE ps_applications SET status=$2, waitlist_position=$3, decided_by=CASE WHEN $4 THEN $5::uuid ELSE decided_by END,
        decided_at=CASE WHEN $4 THEN now() ELSE decided_at END, updated_at=now() WHERE id=$1 RETURNING *`, [a0.id, b.status, position, decision, req.actor.userId]);
    if (!a) throw new HttpError(403, "not_allowed");
    await c.query("INSERT INTO ps_application_events(school_id, application_id, from_status, to_status, note, actor_user_id) VALUES ($1,$2,$3,$4,$5,$6)",
      [req.actor.privateSchoolId, a.id, a0.status, b.status, b.note ?? null, req.actor.userId]);
    await psAudit(c, req, "status", "ps_application", a.id, `${a0.status}->${b.status}`);
    return appOut(a);
  }));

  app.post("/api/private-school/admissions/:id/enroll", limiter, requireSession, requireCsrf, school(async (c, req) => {
    const a0 = await application(c, req.params.id), b = req.body || {};
    if (a0.status !== "accepted") throw new HttpError(409, "not_accepted");
    if ((b.enrolledOn != null && !DAY(b.enrolledOn)) || (b.localNumber != null && !cleanText(b.localNumber, 40))) throw new HttpError(400, "invalid_enrollment");
    await mustRun(c, a0.campus_id);
    let learnerId = a0.learner_id;
    try {
      if (a0.kind === "new") {
        learnerId = (await one(c, `INSERT INTO private_school_learners(school_id, campus_id, display_name, grade_level, local_number, enrolled_on, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [req.actor.privateSchoolId, a0.campus_id, a0.applicant_name, a0.grade_level, b.localNumber?.trim() ?? null, b.enrolledOn ?? today(), req.actor.userId])).id;
      } else {
        await c.query(`UPDATE private_school_learners SET enrollment_status='enrolled', withdrawn_on=NULL, withdraw_reason=NULL, grade_level=coalesce($2, grade_level) WHERE id=$1`, [learnerId, a0.grade_level]);
      }
    } catch (e) { if (e.code === "23505") throw new HttpError(409, "local_number_in_use"); throw e; }
    const a = await one(c, "UPDATE ps_applications SET status='enrolled', learner_id=$2, updated_at=now() WHERE id=$1 RETURNING *", [a0.id, learnerId]);
    await c.query("INSERT INTO ps_application_events(school_id, application_id, from_status, to_status, actor_user_id) VALUES ($1,$2,'accepted','enrolled',$3)", [req.actor.privateSchoolId, a.id, req.actor.userId]);
    await psAudit(c, req, "enroll", "ps_application", a.id, `learner=${learnerId}`);
    return { ...appOut(a), note: a.guardian_email ? `Invite the guardian (${a.guardian_email}) to link them to the new learner.` : undefined };
  }));

  // ---------- classes and schedule ----------
  app.get("/api/private-school/classes", requireSession, school(async (c, req) => {
    const year = YEAR(req.query.schoolYear) ? req.query.schoolYear : null;
    return (await rows(c, `SELECT k.*, u.display_name AS teacher_name, (SELECT count(*)::int FROM ps_class_rosters r WHERE r.class_id=k.id AND r.removed_on IS NULL) AS size
        FROM ps_classes k LEFT JOIN private_school_memberships m ON m.id=k.teacher_membership_id LEFT JOIN users u ON u.id=m.user_id
        WHERE ($1::text IS NULL OR k.school_year=$1) ORDER BY k.status, k.school_year DESC, k.name`, [year])).map(k => ({ ...classOut(k), size: k.size }));
  }));

  const teacherOk = async (c, campusId, membershipId) => {
    if (membershipId == null) return null;
    if (!validId(membershipId)) throw new HttpError(400, "invalid_teacher");
    const m = await one(c, "SELECT id FROM private_school_memberships WHERE id=$1 AND role='teacher' AND status='active' AND campus_id=$2", [membershipId, campusId]);
    if (!m) throw new HttpError(400, "teacher_not_on_campus");
    return m.id;
  };
  app.post("/api/private-school/classes", limiter, requireSession, requireCsrf, school(async (c, req) => {
    const b = req.body || {};
    if (!validId(b.campusId) || !cleanText(b.name, 120) || !YEAR(b.schoolYear) || (b.subject != null && !cleanText(b.subject, 80)) || (b.gradeLevel != null && !GRADES.includes(b.gradeLevel))
      || (b.term != null && !cleanText(b.term, 40))) throw new HttpError(400, "invalid_class", { hint: "campusId, name, schoolYear, subject, gradeLevel, term, teacherMembershipId" });
    await mustRun(c, b.campusId);
    const teacher = await teacherOk(c, b.campusId, b.teacherMembershipId);
    const k = await one(c, `INSERT INTO ps_classes(school_id, campus_id, name, subject, grade_level, school_year, term, teacher_membership_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.actor.privateSchoolId, b.campusId, b.name.trim(), b.subject?.trim() ?? null, b.gradeLevel ?? null, b.schoolYear, b.term?.trim() || "year", teacher, req.actor.userId]);
    await psAudit(c, req, "create", "ps_class", k.id);
    return classOut(k);
  }, 201));

  app.get("/api/private-school/classes/:id", requireSession, school(async (c, req) => {
    const k = await klass(c, req.params.id);
    const meetings = await rows(c, "SELECT weekday, starts, ends, room FROM ps_class_meetings WHERE class_id=$1 ORDER BY weekday, starts", [k.id]);
    const roster = await rows(c, `SELECT l.id, l.display_name, l.grade_level FROM ps_class_rosters r JOIN private_school_learners l ON l.id=r.learner_id
        WHERE r.class_id=$1 AND r.removed_on IS NULL ORDER BY l.display_name`, [k.id]);
    const teaches = (await one(c, "SELECT eduos_ps_teaches($1) AS ok", [k.id])).ok;
    return { ...classOut(k), youTeach: teaches, canRun: await runsCampus(c, k.campus_id), meetings: meetings.map(m => ({ weekday: m.weekday, starts: hhmm(m.starts), ends: hhmm(m.ends), room: m.room })),
      roster: roster.map(l => ({ id: l.id, displayName: l.display_name, gradeLevel: l.grade_level })) };
  }));

  app.patch("/api/private-school/classes/:id", limiter, requireSession, requireCsrf, school(async (c, req) => {
    const k0 = await klass(c, req.params.id), b = req.body || {};
    await mustRun(c, k0.campus_id);
    if ((b.name !== undefined && !cleanText(b.name, 120)) || (b.status !== undefined && !["active", "ended"].includes(b.status)) || (b.term !== undefined && !cleanText(b.term, 40))) throw new HttpError(400, "invalid_class");
    const teacher = "teacherMembershipId" in b ? await teacherOk(c, k0.campus_id, b.teacherMembershipId) : k0.teacher_membership_id;
    const k = await one(c, "UPDATE ps_classes SET name=coalesce($2, name), term=coalesce($3, term), status=coalesce($4, status), teacher_membership_id=$5 WHERE id=$1 RETURNING *",
      [k0.id, b.name?.trim() ?? null, b.term?.trim() ?? null, b.status ?? null, teacher]);
    await psAudit(c, req, "update", "ps_class", k.id, Object.keys(b).join(","));
    return classOut(k);
  }));

  app.put("/api/private-school/classes/:id/meetings", limiter, requireSession, requireCsrf, school(async (c, req) => {
    const k = await klass(c, req.params.id), list = req.body;
    await mustRun(c, k.campus_id);
    if (!Array.isArray(list) || list.length > 20 || list.some(m => !m || !Number.isInteger(m.weekday) || m.weekday < 1 || m.weekday > 7 || !TIME(m.starts) || !TIME(m.ends) || m.ends <= m.starts
      || (m.room != null && !cleanText(m.room, 40)))) throw new HttpError(400, "invalid_meetings", { hint: "[{weekday 1-7 (Monday is 1), starts HH:MM, ends HH:MM, room}]" });
    await c.query("DELETE FROM ps_class_meetings WHERE class_id=$1", [k.id]);
    for (const m of list) await c.query("INSERT INTO ps_class_meetings(school_id, class_id, weekday, starts, ends, room) VALUES ($1,$2,$3,$4,$5,$6)", [req.actor.privateSchoolId, k.id, m.weekday, m.starts, m.ends, m.room?.trim() ?? null]);
    await psAudit(c, req, "schedule", "ps_class", k.id, `meetings=${list.length}`);
    return { meetings: list.length };
  }));

  app.post("/api/private-school/classes/:id/roster", limiter, requireSession, requireCsrf, school(async (c, req) => {
    const k = await klass(c, req.params.id), learnerId = req.body?.learnerId;
    await mustRun(c, k.campus_id);
    if (!validId(learnerId)) throw new HttpError(400, "invalid_learner_id");
    const l = await one(c, "SELECT id, campus_id FROM private_school_learners WHERE id=$1 AND enrollment_status='enrolled'", [learnerId]);
    if (!l) throw new HttpError(404, "learner_not_found");
    if (l.campus_id !== k.campus_id) throw new HttpError(400, "learner_on_another_campus");
    const r = await one(c, "INSERT INTO ps_class_rosters(school_id, class_id, learner_id, added_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id", [req.actor.privateSchoolId, k.id, l.id, req.actor.userId]);
    if (!r) throw new HttpError(409, "already_on_roster");
    await psAudit(c, req, "roster_add", "ps_class", k.id, `learner=${l.id}`);
    return { added: true };
  }, 201));

  app.post("/api/private-school/classes/:id/roster/:learnerId/remove", limiter, requireSession, requireCsrf, school(async (c, req) => {
    const k = await klass(c, req.params.id);
    await mustRun(c, k.campus_id);
    if (!validId(req.params.learnerId)) throw new HttpError(400, "invalid_learner_id");
    const r = await one(c, "UPDATE ps_class_rosters SET removed_by=$3, removed_on=CURRENT_DATE WHERE class_id=$1 AND learner_id=$2 AND removed_on IS NULL RETURNING id", [k.id, req.params.learnerId, req.actor.userId]);
    if (!r) throw new HttpError(404, "not_on_roster");
    await psAudit(c, req, "roster_remove", "ps_class", k.id, `learner=${req.params.learnerId}`);
    return { removed: true };
  }));

  app.get("/api/private-school/schedule", requireSession, school(async (c, req) => {
    const teacher = req.actor.privateSchoolRole === "teacher";
    const list = await rows(c, `SELECT k.id, k.name, k.subject, m.weekday, m.starts, m.ends, m.room FROM ps_class_meetings m JOIN ps_classes k ON k.id=m.class_id
        WHERE k.status='active' AND ($1 = false OR eduos_ps_teaches(k.id)) ORDER BY m.weekday, m.starts, k.name`, [teacher]);
    return list.map(x => ({ classId: x.id, name: x.name, subject: x.subject, weekday: x.weekday, starts: hhmm(x.starts), ends: hhmm(x.ends), room: x.room }));
  }));

  // ---------- attendance ----------
  app.get("/api/private-school/attendance", requireSession, school(async (c, req) => {
    const day = DAY(req.query.day) ? req.query.day : today();
    let learners, classId = null;
    if (req.query.classId) {
      const k = await klass(c, req.query.classId); classId = k.id;
      learners = await rows(c, `SELECT l.id, l.display_name FROM ps_class_rosters r JOIN private_school_learners l ON l.id=r.learner_id WHERE r.class_id=$1 AND r.removed_on IS NULL ORDER BY l.display_name`, [k.id]);
    } else learners = await rows(c, "SELECT id, display_name FROM private_school_learners WHERE enrollment_status='enrolled' ORDER BY display_name");
    const marks = await rows(c, "SELECT learner_id, status, note FROM ps_attendance WHERE day=$1 AND class_id IS NOT DISTINCT FROM $2 AND voided_at IS NULL", [day, classId]);
    return { day, classId, learners: learners.map(l => ({ id: l.id, displayName: l.display_name, status: marks.find(m => m.learner_id === l.id)?.status || null, note: marks.find(m => m.learner_id === l.id)?.note || null })) };
  }));

  app.post("/api/private-school/attendance", limiter, requireSession, requireCsrf, school(async (c, req) => {
    const b = req.body || {};
    if (!DAY(b.day) || b.day > today() || !Array.isArray(b.marks) || !b.marks.length || b.marks.length > 200 || b.marks.some(m => !m || !validId(m.learnerId) || !MARKS.includes(m.status)
      || (m.note != null && (typeof m.note !== "string" || m.note.length > 300))) || (b.classId != null && !validId(b.classId)))
      throw new HttpError(400, "invalid_attendance", { hint: "day (not in the future), classId (or none for the daily mark), marks: [{learnerId, status: present|tardy|absent|excused, note}]" });
    let rosterIds = null;
    if (b.classId) {
      const k = await klass(c, b.classId);
      if (!(await one(c, "SELECT eduos_ps_teaches($1) OR eduos_ps_runs_campus($2) AS ok", [k.id, k.campus_id])).ok) throw new HttpError(403, "not_your_class");
      rosterIds = new Set((await rows(c, "SELECT learner_id FROM ps_class_rosters WHERE class_id=$1 AND removed_on IS NULL", [k.id])).map(r => r.learner_id));
    }
    let recorded = 0, changed = 0;
    for (const m of b.marks) {
      if (rosterIds && !rosterIds.has(m.learnerId)) throw new HttpError(400, "learner_not_on_roster");
      const cur = await one(c, "SELECT id, status FROM ps_attendance WHERE learner_id=$1 AND day=$2 AND class_id IS NOT DISTINCT FROM $3 AND voided_at IS NULL", [m.learnerId, b.day, b.classId ?? null]);
      if (cur?.status === m.status) continue;
      if (cur) { await c.query("UPDATE ps_attendance SET voided_by=$2, voided_at=now(), void_reason='Changed' WHERE id=$1", [cur.id, req.actor.userId]); changed++; }
      await c.query("INSERT INTO ps_attendance(school_id, learner_id, class_id, day, status, note, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [req.actor.privateSchoolId, m.learnerId, b.classId ?? null, b.day, m.status, m.note ?? null, req.actor.userId]);
      recorded++;
    }
    await psAudit(c, req, "attendance", "ps_attendance", b.classId ?? null, `day=${b.day};recorded=${recorded};changed=${changed}`);
    return { recorded, changed };
  }));

  app.get("/api/private-school/learners/:id/attendance", requireSession, school(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    if (!(await one(c, "SELECT id FROM private_school_learners WHERE id=$1", [req.params.id]))) throw new HttpError(404, "learner_not_found");
    const from = DAY(req.query.from) ? req.query.from : null, to = DAY(req.query.to) ? req.query.to : null;
    const list = await rows(c, `SELECT a.day, a.status, a.note, a.class_id, k.name FROM ps_attendance a LEFT JOIN ps_classes k ON k.id=a.class_id
        WHERE a.learner_id=$1 AND a.voided_at IS NULL AND ($2::date IS NULL OR a.day >= $2) AND ($3::date IS NULL OR a.day <= $3) ORDER BY a.day DESC LIMIT 1000`, [req.params.id, from, to]);
    const daily = list.filter(a => !a.class_id), totals = Object.fromEntries(MARKS.map(s => [s, daily.filter(a => a.status === s).length]));
    return { totals, marks: list.map(a => ({ day: ymd(a.day), status: a.status, note: a.note, classId: a.class_id, class: a.name })) };
  }));

  // ---------- report cards ----------
  const cardOut = (r, lines = []) => ({ id: r.id, learnerId: r.learner_id, learner: r.display_name ?? undefined, schoolYear: r.school_year, term: r.term, status: r.status, comment: r.comment,
    publishedAt: r.published_at, lines: lines.map(l => ({ classId: l.class_id, class: l.name, grade: l.grade, comment: l.comment, by: l.by })) });
  app.get("/api/private-school/report-cards", requireSession, school(async (c, req) => {
    const year = YEAR(req.query.schoolYear) ? req.query.schoolYear : null, term = cleanText(req.query.term, 40) ? req.query.term : null;
    return (await rows(c, `SELECT r.*, l.display_name FROM ps_report_cards r JOIN private_school_learners l ON l.id=r.learner_id
        WHERE ($1::text IS NULL OR r.school_year=$1) AND ($2::text IS NULL OR r.term=$2) ORDER BY r.school_year DESC, r.term, l.display_name`, [year, term])).map(r => cardOut(r));
  }));

  app.post("/api/private-school/report-cards", limiter, requireSession, requireCsrf, school(async (c, req) => {
    const b = req.body || {};
    if (!validId(b.learnerId) || !YEAR(b.schoolYear) || !cleanText(b.term, 40)) throw new HttpError(400, "invalid_report_card", { hint: "learnerId, schoolYear, term" });
    const l = await one(c, "SELECT id, campus_id FROM private_school_learners WHERE id=$1", [b.learnerId]);
    if (!l) throw new HttpError(404, "learner_not_found");
    await mustRun(c, l.campus_id);
    try {
      const r = await one(c, "INSERT INTO ps_report_cards(school_id, learner_id, school_year, term, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *", [req.actor.privateSchoolId, l.id, b.schoolYear, b.term.trim(), req.actor.userId]);
      await psAudit(c, req, "create", "ps_report_card", r.id);
      return cardOut(r);
    } catch (e) { if (e.code === "23505") throw new HttpError(409, "report_card_exists"); throw e; }
  }, 201));

  app.get("/api/private-school/report-cards/:id", requireSession, school(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const r = await one(c, "SELECT r.*, l.display_name FROM ps_report_cards r JOIN private_school_learners l ON l.id=r.learner_id WHERE r.id=$1", [req.params.id]);
    if (!r) throw new HttpError(404, "report_card_not_found");
    const lines = await rows(c, `SELECT x.class_id, x.grade, x.comment, k.name, u.display_name AS by FROM ps_report_card_lines x JOIN ps_classes k ON k.id=x.class_id JOIN users u ON u.id=x.written_by
        WHERE x.report_card_id=$1 ORDER BY k.name`, [r.id]);
    // Classes the learner is on that have no line yet (for the people writing them).
    const missing = r.status === "draft" ? await rows(c, `SELECT k.id, k.name FROM ps_class_rosters ro JOIN ps_classes k ON k.id=ro.class_id
        WHERE ro.learner_id=$1 AND ro.removed_on IS NULL AND k.school_year=$2 AND NOT EXISTS (SELECT 1 FROM ps_report_card_lines x WHERE x.report_card_id=$3 AND x.class_id=k.id) ORDER BY k.name`,
      [r.learner_id, r.school_year, r.id]) : [];
    return { ...cardOut(r, lines), missing: missing.map(m => ({ classId: m.id, class: m.name })) };
  }));

  app.put("/api/private-school/report-cards/:id/lines/:classId", limiter, requireSession, requireCsrf, school(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const b = req.body || {};
    if ((b.grade != null && !cleanText(b.grade, 20)) || (b.comment != null && (typeof b.comment !== "string" || b.comment.length > 1000)) || (b.grade == null && b.comment == null)) throw new HttpError(400, "invalid_line");
    const r = await one(c, "SELECT id, learner_id, status FROM ps_report_cards WHERE id=$1", [req.params.id]);
    if (!r) throw new HttpError(404, "report_card_not_found");
    if (r.status !== "draft") throw new HttpError(409, "report_card_published");
    const k = await klass(c, req.params.classId);
    if (!(await one(c, "SELECT eduos_ps_teaches($1) OR eduos_ps_runs_campus($2) AS ok", [k.id, k.campus_id])).ok) throw new HttpError(403, "not_your_class");
    if (!(await one(c, "SELECT 1 AS ok FROM ps_class_rosters WHERE class_id=$1 AND learner_id=$2 AND removed_on IS NULL", [k.id, r.learner_id]))) throw new HttpError(400, "learner_not_on_roster");
    await c.query(`INSERT INTO ps_report_card_lines(school_id, report_card_id, class_id, grade, comment, written_by) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (report_card_id, class_id) DO UPDATE SET grade=EXCLUDED.grade, comment=EXCLUDED.comment, written_by=EXCLUDED.written_by, written_at=now()`,
      [req.actor.privateSchoolId, r.id, k.id, b.grade?.trim() ?? null, b.comment ?? null, req.actor.userId]);
    await psAudit(c, req, "write_line", "ps_report_card", r.id, `class=${k.id}`);
    return { saved: true };
  }));

  app.post("/api/private-school/report-cards/:id/publish", limiter, requireSession, requireCsrf, school(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const comment = req.body?.comment;
    if (comment != null && (typeof comment !== "string" || comment.length > 2000)) throw new HttpError(400, "invalid_comment");
    const r0 = await one(c, "SELECT r.id, r.status, l.campus_id FROM ps_report_cards r JOIN private_school_learners l ON l.id=r.learner_id WHERE r.id=$1", [req.params.id]);
    if (!r0) throw new HttpError(404, "report_card_not_found");
    if (r0.status !== "draft") throw new HttpError(409, "report_card_published");
    if (!["school_admin", "registrar", "campus_admin"].includes(req.actor.privateSchoolRole)) throw new HttpError(403, "not_allowed");
    await mustRun(c, r0.campus_id);
    const r = await one(c, "UPDATE ps_report_cards SET status='published', published_by=$2, published_at=now(), comment=coalesce($3, comment) WHERE id=$1 RETURNING *", [r0.id, req.actor.userId, comment ?? null]);
    await psAudit(c, req, "publish", "ps_report_card", r.id);
    return cardOut(r);
  }));
}
