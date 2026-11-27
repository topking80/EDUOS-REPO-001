// HSP-02: homeschool learning operations, in a family session (db/161).
//
//   GET   /api/homeschool/learners/:id/plan            courses and goals
//   POST  /api/homeschool/learners/:id/courses         {title, subject?, schoolYear, description?}
//   PATCH /api/homeschool/courses/:id                  {title?, subject?, description?, status?, finalGrade?, credits?, completedOn?}
//   POST  /api/homeschool/learners/:id/goals           {text, courseId?, targetOn?}
//   PATCH /api/homeschool/goals/:id                    {status: open|met|dropped, metOn?, text?, targetOn?}
//   GET   /api/homeschool/learners/:id/attendance      ?from&to: sessions and totals
//   POST  /api/homeschool/learners/:id/attendance      {day, minutes, kind, courseId?, note?}
//   POST  /api/homeschool/attendance/:id/void          {reason}
//   GET   /api/homeschool/learners/:id/work            ?from&to
//   POST  /api/homeschool/learners/:id/work            {title, kind, doneOn, courseId?, score?, maxScore?, gradeLabel?, notes?, source?}
//   POST  /api/homeschool/work/:id/void                {reason}
//   GET   /api/homeschool/learners/:id/progress        ?from&to: the progress report, not saved
//   POST  /api/homeschool/learners/:id/exports         {kind: progress_report|transcript|portfolio, from?, to?}: full authority; logged
//   GET   /api/homeschool/learners/:id/exports         the export log
//
// Anyone with authority over the learner reads. The owner, or a co-educator
// teaching the learner, writes. Exports need full authority. Records are
// corrected by voiding with a reason, never deleted. Row-level security
// (db/161) enforces the same.
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { rows, one, validId, cleanText, HttpError } from "./role-app-util.js";
import { family, familyAudit } from "./homeschool-routes.js";
import { attendanceTotals, builders, KINDS, sha256Of } from "./homeschool-reports.js";

const DAY = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const YEAR = v => typeof v === "string" && /^(\d{4})-(\d{4})$/.test(v) && Number(v.slice(5)) === Number(v.slice(0, 4)) + 1;
const ATT = ["instruction", "field_trip", "co_op", "independent", "absent"];
const WORK = ["assignment", "project", "test", "reading", "activity", "certificate"];
const ymd = v => v instanceof Date ? v.toISOString().slice(0, 10) : v;
const today = () => new Date().toISOString().slice(0, 10);
const range = q => ({ from: DAY(q.from) ? q.from : null, to: DAY(q.to) ? q.to : null });

// The learner, if the signed-in member has any authority over them (RLS hides the rest).
async function learner(c, id) {
  if (!validId(id)) throw new HttpError(400, "invalid_learner_id");
  const l = await one(c, "SELECT l.*, eduos_family_authority(l.id) AS authority FROM family_learners l WHERE l.id=$1", [id]);
  if (!l) throw new HttpError(404, "learner_not_found");
  return l;
}
const mustTeach = l => { if (!["full", "educational"].includes(l.authority) || l.status !== "active") throw new HttpError(403, "not_allowed_for_this_learner"); };
async function courseOf(c, l, courseId) {
  if (courseId == null) return null;
  if (!validId(courseId)) throw new HttpError(400, "invalid_course_id");
  const k = await one(c, "SELECT id FROM family_courses WHERE id=$1 AND learner_id=$2", [courseId, l.id]);
  if (!k) throw new HttpError(404, "course_not_found");
  return k.id;
}
const courseOut = k => ({ id: k.id, title: k.title, subject: k.subject, schoolYear: k.school_year, description: k.description, status: k.status,
  finalGrade: k.final_grade, credits: k.credits == null ? null : Number(k.credits), completedOn: ymd(k.completed_on) });
const goalOut = g => ({ id: g.id, courseId: g.course_id, text: g.text, targetOn: ymd(g.target_on), status: g.status, metOn: ymd(g.met_on) });
const attOut = a => ({ id: a.id, day: ymd(a.day), minutes: a.minutes, kind: a.kind, courseId: a.course_id, note: a.note, voided: !!a.voided_at, voidReason: a.void_reason });
const workOut = w => ({ id: w.id, courseId: w.course_id, title: w.title, kind: w.kind, doneOn: ymd(w.done_on), score: w.score == null ? null : Number(w.score),
  maxScore: w.max_score == null ? null : Number(w.max_score), gradeLabel: w.grade_label, notes: w.notes, provenance: w.provenance, source: w.source,
  voided: !!w.voided_at, voidReason: w.void_reason });

export function registerHomeschoolLearningRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `hsl:${req.actor?.userId}` });
  const exportLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `hsx:${req.actor?.userId}` });

  // ---------- plan ----------
  app.get("/api/homeschool/learners/:id/plan", requireSession, family(async (c, req) => {
    const l = await learner(c, req.params.id);
    const courses = await rows(c, "SELECT * FROM family_courses WHERE learner_id=$1 ORDER BY school_year DESC, status, title", [l.id]);
    const goals = await rows(c, "SELECT * FROM family_goals WHERE learner_id=$1 ORDER BY status, target_on NULLS LAST, created_at", [l.id]);
    return { learner: { id: l.id, displayName: l.display_name, gradeBand: l.grade_band, authority: l.authority }, canTeach: ["full", "educational"].includes(l.authority),
      courses: courses.map(courseOut), goals: goals.map(goalOut) };
  }));

  app.post("/api/homeschool/learners/:id/courses", limiter, requireSession, requireCsrf, family(async (c, req) => {
    const l = await learner(c, req.params.id); mustTeach(l);
    const b = req.body || {};
    if (!cleanText(b.title, 160) || !YEAR(b.schoolYear) || (b.subject != null && !cleanText(b.subject, 80)) || (b.description != null && (typeof b.description !== "string" || b.description.length > 2000)))
      throw new HttpError(400, "invalid_course", { hint: "title, schoolYear like 2026-2027, subject, description" });
    const k = await one(c, "INSERT INTO family_courses(family_id, learner_id, title, subject, school_year, description, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [req.actor.familyId, l.id, b.title.trim(), b.subject?.trim() ?? null, b.schoolYear, b.description ?? null, req.actor.userId]);
    await familyAudit(c, req, "create", "family_course", k.id, `learner=${l.id}`);
    return courseOut(k);
  }, 201));

  app.patch("/api/homeschool/courses/:id", limiter, requireSession, requireCsrf, family(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_course_id");
    const k0 = await one(c, "SELECT * FROM family_courses WHERE id=$1", [req.params.id]);
    if (!k0) throw new HttpError(404, "course_not_found");
    mustTeach(await learner(c, k0.learner_id));
    const b = req.body || {};
    const status = b.status ?? k0.status;
    if (!["active", "completed", "archived"].includes(status) || (b.title !== undefined && !cleanText(b.title, 160)) || (b.finalGrade != null && !cleanText(b.finalGrade, 20))
      || (b.credits != null && !(typeof b.credits === "number" && b.credits >= 0 && b.credits <= 10)) || (b.completedOn != null && !DAY(b.completedOn)))
      throw new HttpError(400, "invalid_course");
    const completedOn = status === "completed" ? (b.completedOn ?? ymd(k0.completed_on) ?? today()) : null;
    const k = await one(c, `UPDATE family_courses SET title=coalesce($2, title), subject=CASE WHEN $8 THEN $3 ELSE subject END, description=CASE WHEN $9 THEN $4 ELSE description END,
        status=$5, final_grade=CASE WHEN $10 THEN $6 ELSE final_grade END, credits=CASE WHEN $11 THEN $7 ELSE credits END, completed_on=$12 WHERE id=$1 RETURNING *`,
      [k0.id, b.title?.trim() ?? null, b.subject ?? null, b.description ?? null, status, b.finalGrade ?? null, b.credits ?? null,
        "subject" in b, "description" in b, "finalGrade" in b, "credits" in b, completedOn]);
    await familyAudit(c, req, "update", "family_course", k.id, Object.keys(b).join(","));
    return courseOut(k);
  }));

  app.post("/api/homeschool/learners/:id/goals", limiter, requireSession, requireCsrf, family(async (c, req) => {
    const l = await learner(c, req.params.id); mustTeach(l);
    const b = req.body || {};
    if (!cleanText(b.text, 500) || (b.targetOn != null && !DAY(b.targetOn))) throw new HttpError(400, "invalid_goal");
    const courseId = await courseOf(c, l, b.courseId);
    const g = await one(c, "INSERT INTO family_goals(family_id, learner_id, course_id, text, target_on, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [req.actor.familyId, l.id, courseId, b.text.trim(), b.targetOn ?? null, req.actor.userId]);
    await familyAudit(c, req, "create", "family_goal", g.id, `learner=${l.id}`);
    return goalOut(g);
  }, 201));

  app.patch("/api/homeschool/goals/:id", limiter, requireSession, requireCsrf, family(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_goal_id");
    const g0 = await one(c, "SELECT * FROM family_goals WHERE id=$1", [req.params.id]);
    if (!g0) throw new HttpError(404, "goal_not_found");
    mustTeach(await learner(c, g0.learner_id));
    const b = req.body || {}, status = b.status ?? g0.status;
    if (!["open", "met", "dropped"].includes(status) || (b.text !== undefined && !cleanText(b.text, 500)) || (b.metOn != null && !DAY(b.metOn)) || (b.targetOn != null && !DAY(b.targetOn)))
      throw new HttpError(400, "invalid_goal");
    const g = await one(c, `UPDATE family_goals SET text=coalesce($2, text), target_on=CASE WHEN $6 THEN $5 ELSE target_on END, status=$3, met_on=$4 WHERE id=$1 RETURNING *`,
      [g0.id, b.text?.trim() ?? null, status, status === "met" ? (b.metOn ?? ymd(g0.met_on) ?? today()) : null, b.targetOn ?? null, "targetOn" in b]);
    await familyAudit(c, req, "update", "family_goal", g.id, `status=${status}`);
    return goalOut(g);
  }));

  // ---------- attendance and instructional time ----------
  app.get("/api/homeschool/learners/:id/attendance", requireSession, family(async (c, req) => {
    const l = await learner(c, req.params.id), { from, to } = range(req.query);
    const list = await rows(c, `SELECT * FROM family_attendance WHERE learner_id=$1 AND ($2::date IS NULL OR day >= $2) AND ($3::date IS NULL OR day <= $3)
        ORDER BY day DESC, recorded_at DESC LIMIT 1000`, [l.id, from, to]);
    return { from, to, totals: attendanceTotals(list), sessions: list.map(attOut) };
  }));

  app.post("/api/homeschool/learners/:id/attendance", limiter, requireSession, requireCsrf, family(async (c, req) => {
    const l = await learner(c, req.params.id); mustTeach(l);
    const b = req.body || {}, kind = b.kind || "instruction";
    if (!DAY(b.day) || b.day > today() || !ATT.includes(kind) || !Number.isInteger(b.minutes) || b.minutes < 0 || b.minutes > 1440 || (kind === "absent" && b.minutes !== 0)
      || (b.note != null && (typeof b.note !== "string" || b.note.length > 500)))
      throw new HttpError(400, "invalid_attendance", { hint: "day (not in the future), minutes 0-1440 (0 when absent), kind, note" });
    const courseId = await courseOf(c, l, b.courseId);
    const a = await one(c, "INSERT INTO family_attendance(family_id, learner_id, day, minutes, kind, course_id, note, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [req.actor.familyId, l.id, b.day, b.minutes, kind, courseId, b.note ?? null, req.actor.userId]);
    await familyAudit(c, req, "record", "family_attendance", a.id, `learner=${l.id};day=${b.day};minutes=${b.minutes};kind=${kind}`);
    return attOut(a);
  }, 201));

  const voidRoute = (table, type) => family(async (c, req) => {
    const reason = req.body?.reason;
    if (!validId(req.params.id) || !cleanText(reason, 300, 3)) throw new HttpError(400, "reason_required");
    const r0 = await one(c, `SELECT id, learner_id FROM ${table} WHERE id=$1 AND voided_at IS NULL`, [req.params.id]);
    if (!r0) throw new HttpError(404, "record_not_found");
    mustTeach(await learner(c, r0.learner_id));
    await c.query(`UPDATE ${table} SET voided_by=$2, voided_at=now(), void_reason=$3 WHERE id=$1`, [r0.id, req.actor.userId, reason.trim()]);
    await familyAudit(c, req, "void", type, r0.id, reason.trim());
    return { voided: true };
  });
  app.post("/api/homeschool/attendance/:id/void", limiter, requireSession, requireCsrf, voidRoute("family_attendance", "family_attendance"));

  // ---------- work and evidence ----------
  app.get("/api/homeschool/learners/:id/work", requireSession, family(async (c, req) => {
    const l = await learner(c, req.params.id), { from, to } = range(req.query);
    return (await rows(c, `SELECT * FROM family_work WHERE learner_id=$1 AND ($2::date IS NULL OR done_on >= $2) AND ($3::date IS NULL OR done_on <= $3)
        ORDER BY done_on DESC, recorded_at DESC LIMIT 1000`, [l.id, from, to])).map(workOut);
  }));

  app.post("/api/homeschool/learners/:id/work", limiter, requireSession, requireCsrf, family(async (c, req) => {
    const l = await learner(c, req.params.id); mustTeach(l);
    const b = req.body || {}, kind = b.kind || "assignment";
    const scoreOk = (b.score == null && b.maxScore == null) || (typeof b.score === "number" && typeof b.maxScore === "number" && b.score >= 0 && b.maxScore > 0 && b.score <= b.maxScore * 2)
      || (b.score == null && typeof b.maxScore === "number" && b.maxScore > 0);
    if (!cleanText(b.title, 200) || !WORK.includes(kind) || !DAY(b.doneOn) || b.doneOn > today() || !scoreOk || (b.gradeLabel != null && !cleanText(b.gradeLabel, 20))
      || (b.notes != null && (typeof b.notes !== "string" || b.notes.length > 2000)) || (b.source != null && !cleanText(b.source, 200, 2)))
      throw new HttpError(400, "invalid_work", { hint: "title, kind, doneOn (not in the future), score with maxScore, gradeLabel, notes, source (for outside work)" });
    const courseId = await courseOf(c, l, b.courseId);
    const w = await one(c, `INSERT INTO family_work(family_id, learner_id, course_id, title, kind, done_on, score, max_score, grade_label, notes, provenance, source, recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [req.actor.familyId, l.id, courseId, b.title.trim(), kind, b.doneOn, b.score ?? null, b.maxScore ?? null,
      b.gradeLabel?.trim() ?? null, b.notes ?? null, b.source ? "external" : "parent_entered", b.source?.trim() ?? null, req.actor.userId]);
    await familyAudit(c, req, "record", "family_work", w.id, `learner=${l.id};kind=${kind}${b.source ? ";external" : ""}`);
    return workOut(w);
  }, 201));
  app.post("/api/homeschool/work/:id/void", limiter, requireSession, requireCsrf, voidRoute("family_work", "family_work"));

  // ---------- reports and exports ----------
  const gather = async (c, l) => ({
    family: await one(c, "SELECT display_name FROM homeschool_families"),
    courses: await rows(c, "SELECT * FROM family_courses WHERE learner_id=$1 ORDER BY school_year, title", [l.id]),
    goals: await rows(c, "SELECT * FROM family_goals WHERE learner_id=$1 ORDER BY created_at", [l.id]),
    attendance: await rows(c, "SELECT * FROM family_attendance WHERE learner_id=$1", [l.id]),
    work: await rows(c, "SELECT * FROM family_work WHERE learner_id=$1", [l.id]),
  });

  app.get("/api/homeschool/learners/:id/progress", requireSession, family(async (c, req) => {
    const l = await learner(c, req.params.id), { from, to } = range(req.query);
    return builders.progress_report({ ...(await gather(c, l)), id: null, learner: l, from, to, generatedOn: today(), generatedBy: req.actor.displayName });
  }));

  app.post("/api/homeschool/learners/:id/exports", exportLimiter, requireSession, requireCsrf, family(async (c, req) => {
    const l = await learner(c, req.params.id);
    if (l.authority !== "full") throw new HttpError(403, "export_needs_full_authority");
    const b = req.body || {};
    if (!KINDS.includes(b.kind) || (b.from != null && !DAY(b.from)) || (b.to != null && !DAY(b.to)) || (b.from && b.to && b.to < b.from)) throw new HttpError(400, "invalid_export");
    const id = crypto.randomUUID();
    const doc = builders[b.kind]({ ...(await gather(c, l)), id, learner: l, from: b.from ?? null, to: b.to ?? null, generatedOn: today(), generatedBy: req.actor.displayName });
    const sha = sha256Of(doc);
    await c.query("INSERT INTO family_exports(id, family_id, learner_id, kind, period_from, period_to, sha256, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, req.actor.familyId, l.id, b.kind, b.from ?? null, b.to ?? null, sha, req.actor.userId]);
    await familyAudit(c, req, "export", "family_record", id, `learner=${l.id};kind=${b.kind};sha256=${sha}`);
    return { ...doc, sha256: sha };
  }, 201));

  app.get("/api/homeschool/learners/:id/exports", requireSession, family(async (c, req) => {
    const l = await learner(c, req.params.id);
    return (await rows(c, `SELECT x.id, x.kind, x.period_from, x.period_to, x.sha256, x.created_at, u.display_name FROM family_exports x JOIN users u ON u.id=x.created_by
        WHERE x.learner_id=$1 ORDER BY x.created_at DESC LIMIT 100`, [l.id])).map(x => ({ id: x.id, kind: x.kind, from: ymd(x.period_from), to: ymd(x.period_to), sha256: x.sha256, at: x.created_at, by: x.display_name }));
  }));
}
