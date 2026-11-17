// EduOS 37.6.0 Leo: lesson drafts through the staff AI gateway.
//   GET  /api/leo/options?courseId=  what Leo may build from (curriculum only)
//   POST /api/leo/drafts             build a draft and save it as a DRAFT lesson
// The gateway decides (superintendent's leo_lesson switch, role, budgets,
// redaction for an external model, usage and audit: src/ai/invoke.js). The
// saved lesson carries provenance (generated_by / generated_from) and the
// database refuses to publish it until a school leader approves it through the
// existing lesson approval (db/059_leo_edison.sql). No student data is read.
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import { requireSession, requireCsrf } from "../auth.js";
import { withTenantTransaction } from "../db.js";
import { HttpError, audit, rows, one, validId, sendError } from "../role-app-util.js";
import { USECASES, policyOf } from "./gateway.js";
import { createProvider } from "./providers.js";
import { invokeAi } from "./invoke.js";
import { MINUTES, LEO_HEADER, leoBrief, leoTitleObjective, clip } from "./leo-template.js";
import { findStudentIdentifiers } from "../student-identifiers.js";

const USECASE = "leo_lesson";
const ROLES = USECASES[USECASE].roles;
const ids = (v, max) => v === undefined ? [] : (Array.isArray(v) && v.length <= max && v.every(validId) && new Set(v).size === v.length ? v : null);

async function manageableCourse(c, courseId) {
  if (!validId(courseId)) throw new HttpError(400, "invalid_course_id");
  const course = await one(c, `SELECT id,school_id,title,subject,grade_level FROM courses WHERE id=$1 AND eduos_can_manage_course(id)`, [courseId]);
  if (!course) throw new HttpError(404, "course_not_found");
  return course;
}

/** Everything Leo is given, read in the caller's own scope (RLS applies). */
export async function leoInputs(c, b) {
  const course = await manageableCourse(c, b.courseId);
  const standardIds = ids(b.standardIds, 4), lessonIds = ids(b.lessonIds, 3), sourceIds = ids(b.sourceIds, 2);
  if (!standardIds || !standardIds.length || !lessonIds || !sourceIds) throw new HttpError(400, "invalid_leo_request");
  if (!validId(b.unitId)) throw new HttpError(400, "invalid_leo_request");
  if (b.focus !== undefined && b.focus !== null && (typeof b.focus !== "string" || b.focus.trim().length > 100)) throw new HttpError(400, "invalid_leo_request");
  if (b.minutes !== undefined && !MINUTES.includes(Number(b.minutes))) throw new HttpError(400, "invalid_leo_request");
  const unit = await one(c, `SELECT id FROM course_units WHERE id=$1 AND course_id=$2`, [b.unitId, course.id]);
  if (!unit) throw new HttpError(400, "unit_not_in_course");
  const standards = await rows(c, `SELECT id,code,description FROM learning_standards WHERE id=ANY($1::uuid[])`, [standardIds]);
  if (standards.length !== standardIds.length) throw new HttpError(400, "standard_not_found");
  // Only lessons in this course that a school leader approved.
  const lessons = await rows(c, `SELECT id,title,objective FROM lessons WHERE id=ANY($1::uuid[]) AND course_id=$2 AND approved_at IS NOT NULL`, [lessonIds, course.id]);
  if (lessons.length !== lessonIds.length) throw new HttpError(400, "lesson_not_approved");
  const sources = await rows(c, `SELECT id,title,creator,created_date AS "createdDate",archive,archive_url AS "archiveUrl",description
      FROM primary_sources WHERE id=ANY($1::uuid[]) AND status='approved'`, [sourceIds]);
  if (sources.length !== sourceIds.length) throw new HttpError(400, "source_not_approved");
  return { course, unitId: unit.id, leo: { course: { title: course.title, subject: course.subject, grade: course.grade_level },
    focus: typeof b.focus === "string" && b.focus.trim() ? b.focus.trim() : undefined, minutes: b.minutes ? Number(b.minutes) : 45, standards, lessons, sources } };
}

export function registerLeoRoutes(app, { provider = createProvider(config) } = {}) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `leo:${req.actor?.userId}` });
  const roleOk = (req, res, next) => ROLES.includes(req.actor?.role) ? next() : res.status(403).json({ error: "ai_usecase_not_for_your_role" });

  app.get("/api/leo/options", requireSession, roleOk, async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, async (c) => {
        const course = await manageableCourse(c, req.query.courseId);
        const p = await policyOf(c, req.actor.districtId);
        const units = await rows(c, `SELECT id,seq,title FROM course_units WHERE course_id=$1 ORDER BY seq`, [course.id]);
        const standards = await rows(c, `SELECT id,code,description FROM learning_standards
            WHERE (subject=$2 AND grade_level=$3) OR id IN (SELECT st.standard_id FROM lesson_standards st JOIN lessons l ON l.id=st.lesson_id WHERE l.course_id=$1)
            ORDER BY code LIMIT 200`, [course.id, course.subject, course.grade_level]);
        const lessons = await rows(c, `SELECT id,title FROM lessons WHERE course_id=$1 AND approved_at IS NOT NULL ORDER BY title LIMIT 100`, [course.id]);
        const sources = await rows(c, `SELECT id,title,archive FROM primary_sources WHERE status='approved' ORDER BY title LIMIT 100`);
        return { enabled: p.enabled_usecases.includes(USECASE), minutes: MINUTES, course: { id: course.id, title: course.title }, units, standards, lessons, sources,
          provider: provider.name === "local" ? "local" : "external" };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/leo/drafts", requireSession, requireCsrf, roleOk, limiter, async (req, res, next) => {
    const b = req.body || {};
    let built;
    try {
      const r = await invokeAi(req, { provider, usecase: USECASE,
        prepare: async (c, { external }) => {
          built = await leoInputs(c, b);
          const text = leoBrief(built.leo);
          // Curriculum text, but a teacher-written lesson or source could still
          // name a student: same redaction as any pasted text.
          const identifiers = external ? await findStudentIdentifiers(c, req.actor.districtId, text) : { names: [], numbers: [] };
          return { input: { text, leo: built.leo }, identifiers };
        },
        settle: async (c, out, { source, usageId }) => {
          const { title, objective } = leoTitleObjective(built.leo);
          const content = `${LEO_HEADER}\n\n${String(out.text || "").trim()}`.slice(0, 7900);
          const seq = (await one(c, `SELECT coalesce(max(seq),0)+1 AS n FROM lessons WHERE unit_id=$1`, [built.unitId])).n;
          const from = { usecase: USECASE, usageId: String(usageId), minutes: built.leo.minutes, focus: clip(built.leo.focus || "", 100) || null,
            standards: built.leo.standards.map(s => s.id), lessons: built.leo.lessons.map(l => l.id), sources: built.leo.sources.map(s => s.id) };
          const l = await one(c, `INSERT INTO lessons(district_id,course_id,unit_id,seq,title,objective,content,status,created_by,generated_by,generated_from)
              VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10) RETURNING id,status,seq`,
            [req.actor.districtId, built.course.id, built.unitId, seq, title, objective, content, req.actor.userId, `leo-${source}`, JSON.stringify(from)]);
          for (const s of built.leo.standards) await c.query(`INSERT INTO lesson_standards(lesson_id,standard_id,district_id) VALUES($1,$2,$3)`, [l.id, s.id, req.actor.districtId]);
          await audit(c, req, "leo_draft", "lesson", l.id, `standards=${from.standards.length};lessons=${from.lessons.length};sources=${from.sources.length};provider=${source}`);
          return { id: l.id, status: l.status, seq: l.seq, title, objective, content };
        } });
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json({ data: { lesson: { ...r.extra, approved: false, generatedBy: `leo-${r.source}` }, source: r.source, tokens: r.tokensIn + r.tokensOut,
        next: "A school leader approves this draft (Approve on the lesson) before it can be published." } });
    } catch (e) { sendError(res, next, e); }
  });
}
