// TEACH-04: today's classroom material (db/104, src/class-plan.js).
//
// GET  /api/class-plans?date=YYYY-MM-DD           your classes (courses) that day, with their plans
// GET  /api/class-plans/:courseId/:date           one plan, blocks resolved (lesson text, assignment)
// PUT  /api/class-plans/:courseId/:date           save { blocks, title?, status?, baseVersion }
// POST /api/class-plans/:courseId/:date/copy-from { fromDate }: start from another day's plan
//
// Only whoever manages the course (its teacher, the school's principal) reads
// or edits its plans; lessons and assignments in a plan must be from that
// course. Saves carry the version they started from, so two people editing the
// same plan can't overwrite each other.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { cleanBlocks, totalMinutes } from "./class-plan.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = d => typeof d === "string" && DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
const PLANNERS = ["teacher", "principal"];
const only = (req, res, next) => PLANNERS.includes(req.actor?.role) ? next() : res.status(403).json({ error: "teachers_and_principals_only" });

async function managedCourse(client, id) {
  return one(client, `SELECT id,title,subject,grade_level FROM courses WHERE id=$1 AND status<>'archived' AND eduos_can_manage_course(id)`, [id]);
}

/** Blocks with what they point at (only this course's lessons and assignments). */
async function resolve(client, courseId, blocks) {
  const lessonIds = blocks.filter(b => b.kind === "lesson").map(b => b.lessonId);
  const assignmentIds = blocks.filter(b => b.kind === "assignment").map(b => b.assignmentId);
  const lessons = lessonIds.length ? await rows(client, `SELECT id,title,objective,content,status,approved_at IS NOT NULL AS approved FROM lessons WHERE course_id=$1 AND id=ANY($2::uuid[])`, [courseId, lessonIds]) : [];
  const work = assignmentIds.length ? await rows(client, `SELECT id,title,kind,instructions,due_at,status FROM assignments WHERE course_id=$1 AND id=ANY($2::uuid[])`, [courseId, assignmentIds]) : [];
  const L = new Map(lessons.map(l => [l.id, l])), A = new Map(work.map(a => [a.id, a]));
  return blocks.map(b => b.kind === "lesson" ? { ...b, lesson: L.get(b.lessonId) || null } : b.kind === "assignment" ? { ...b, assignment: A.get(b.assignmentId) || null } : b);
}

async function checkRefs(client, courseId, blocks) {
  const r = await resolve(client, courseId, blocks);
  const bad = r.findIndex(b => (b.kind === "lesson" && !b.lesson) || (b.kind === "assignment" && !b.assignment));
  if (bad >= 0) throw new HttpError(400, "not_from_this_course", { index: bad });
}

export function registerClassPlanRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const read = [requireSession, requirePermission("learning", "read"), only];
  const write = [limiter, requireSession, requireCsrf, requirePermission("learning", "teach"), only];

  app.get("/api/class-plans", ...read, async (req, res, next) => {
    const date = req.query.date;
    if (!validDate(date)) return res.status(400).json({ error: "invalid_date" });
    try {
      const data = await withTenantTransaction(req.actor, client => rows(client, `SELECT c.id AS course_id,c.title,c.subject,c.grade_level,
            p.id AS plan_id,p.status,p.version,p.title AS plan_title,coalesce(jsonb_array_length(p.blocks),0) AS blocks,
            (SELECT coalesce(sum((b->>'minutes')::int),0) FROM jsonb_array_elements(coalesce(p.blocks,'[]'::jsonb)) b WHERE b->>'minutes' IS NOT NULL)::int AS minutes,
            p.updated_at
          FROM courses c LEFT JOIN class_day_plans p ON p.course_id=c.id AND p.plan_date=$2
         WHERE eduos_can_manage_course(c.id) AND c.status='active' AND ($3<>'teacher' OR c.teacher_user_id=$1)
         ORDER BY c.title`, [req.actor.userId, date, req.actor.role]));
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.get("/api/class-plans/:courseId/:date", ...read, async (req, res, next) => {
    if (!validId(req.params.courseId) || !validDate(req.params.date)) return res.status(400).json({ error: "invalid_plan" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const c = await managedCourse(client, req.params.courseId);
        if (!c) return null;
        const p = await one(client, `SELECT p.*,u.display_name AS updated_by_name FROM class_day_plans p JOIN users u ON u.id=p.updated_by WHERE p.course_id=$1 AND p.plan_date=$2`, [c.id, req.params.date]);
        const lessons = await rows(client, `SELECT l.id,l.title,u.seq AS unit_seq,l.seq FROM lessons l JOIN course_units u ON u.id=l.unit_id WHERE l.course_id=$1 ORDER BY u.seq,l.seq`, [c.id]);
        const assignments = await rows(client, `SELECT id,title,kind,status FROM assignments WHERE course_id=$1 AND status<>'closed' ORDER BY coalesce(due_at,created_at) DESC LIMIT 100`, [c.id]);
        const blocks = p ? await resolve(client, c.id, p.blocks) : [];
        return { course: c, date: req.params.date, plan: p ? { id: p.id, title: p.title, status: p.status, version: p.version, blocks, minutes: totalMinutes(p.blocks),
          updatedAt: p.updated_at, updatedBy: p.updated_by_name } : null, choices: { lessons, assignments } };
      });
      if (!data) return res.status(404).json({ error: "course_not_found" });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.put("/api/class-plans/:courseId/:date", ...write, async (req, res, next) => {
    const { blocks: raw, title = null, status = "draft", baseVersion = null } = req.body || {};
    if (!validId(req.params.courseId) || !validDate(req.params.date) || !["draft", "ready"].includes(status) || (title !== null && title !== "" && !cleanText(title, 120))
        || (baseVersion !== null && (!Number.isInteger(baseVersion) || baseVersion < 1))) return res.status(400).json({ error: "invalid_plan" });
    const cleaned = cleanBlocks(raw);
    if (cleaned.error) return res.status(400).json({ error: cleaned.error, index: cleaned.index });
    if (status === "ready" && !cleaned.blocks.length) return res.status(400).json({ error: "empty_plan" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const a = req.actor;
        const c = await managedCourse(client, req.params.courseId);
        if (!c) throw new HttpError(404, "course_not_found");
        await checkRefs(client, c.id, cleaned.blocks);
        const cur = await one(client, `SELECT id,version FROM class_day_plans WHERE course_id=$1 AND plan_date=$2 FOR UPDATE`, [c.id, req.params.date]);
        if (cur && baseVersion !== cur.version) {
          const by = await one(client, `SELECT u.display_name FROM class_day_plans p JOIN users u ON u.id=p.updated_by WHERE p.id=$1`, [cur.id]);
          return { status: 409, body: { error: "plan_changed", version: cur.version, updatedBy: by?.display_name } };
        }
        const t = title?.trim() || null;
        const p = cur
          ? await one(client, `UPDATE class_day_plans SET title=$2,blocks=$3,status=$4,version=version+1,updated_by=$5,updated_at=now() WHERE id=$1 RETURNING id,version,status`,
              [cur.id, t, JSON.stringify(cleaned.blocks), status, a.userId])
          : await one(client, `INSERT INTO class_day_plans(district_id,course_id,plan_date,title,blocks,status,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id,version,status`,
              [a.districtId, c.id, req.params.date, t, JSON.stringify(cleaned.blocks), status, a.userId]);
        await audit(client, req, cur ? "update" : "create", "class_day_plan", p.id, `blocks=${cleaned.blocks.length};status=${status}`);
        return { status: cur ? 200 : 201, body: { data: { ...p, minutes: totalMinutes(cleaned.blocks) } } };
      });
      res.status(out.status).json(out.body);
    } catch (e) { sendError(res, next, e); }
  });

  // Start from another day's plan for the same course (it becomes a draft).
  app.post("/api/class-plans/:courseId/:date/copy-from", ...write, async (req, res, next) => {
    const { fromDate } = req.body || {};
    if (!validId(req.params.courseId) || !validDate(req.params.date) || !validDate(fromDate) || fromDate === req.params.date) return res.status(400).json({ error: "invalid_copy" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const a = req.actor;
        const c = await managedCourse(client, req.params.courseId);
        if (!c) throw new HttpError(404, "course_not_found");
        const from = await one(client, `SELECT title,blocks FROM class_day_plans WHERE course_id=$1 AND plan_date=$2`, [c.id, fromDate]);
        if (!from) throw new HttpError(404, "plan_not_found");
        if (await one(client, `SELECT 1 FROM class_day_plans WHERE course_id=$1 AND plan_date=$2`, [c.id, req.params.date])) throw new HttpError(409, "plan_exists");
        const p = await one(client, `INSERT INTO class_day_plans(district_id,course_id,plan_date,title,blocks,status,created_by,updated_by) VALUES($1,$2,$3,$4,$5,'draft',$6,$6) RETURNING id,version,status`,
          [a.districtId, c.id, req.params.date, from.title, JSON.stringify(from.blocks), a.userId]);
        await audit(client, req, "copy", "class_day_plan", p.id, `from=${fromDate}`);
        return p;
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });
}
