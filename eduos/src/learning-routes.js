// EduOS 32.6.0 learning core API: courses, units, lessons with standards,
// curated primary sources (PSLN), assignments with rubrics, quizzes with
// auto-scoring, accommodations and retakes, the gradebook, per-standard
// mastery, final grades and credentials (both recorded on the EDAL ledger),
// and the family "Grades & progress" view. Row-level security is the final
// word on every read and write; these routes add role and shape checks.
import { randomUUID } from "node:crypto";
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError, roleIn } from "./role-app-util.js";
import { validRubric, rubricTotals, letterFor } from "./gradebook.js";
import { scoreItem, validKey, deadlineFor } from "./quiz-scoring.js";
import { appendEntry } from "./edal.js";
import { resolveLearner, linkedChildren, addEvidence, masteryExplanation, courseGradeData, courseStandards,
  learnerStandardMastery, courseMastery, postFinalGrade } from "./learning-service.js";

const STAFF = ["superintendent", "principal", "teacher"];
const LEADS = ["superintendent", "principal"];
const GRACE_MS = 60_000;
const isStaff = a => STAFF.includes(a.role);
const wrap = fn => async (req, res, next) => {
  try {
    const out = await withTenantTransaction(req.actor, client => fn(client, req));
    res.setHeader("Cache-Control", "no-store");
    res.status(out?.__status || 200).json({ data: out?.__status ? out.data : out });
  } catch (e) {
    if (e?.code === "23505") return res.status(409).json({ error: "already_exists" });
    if (e?.code === "23514" || e?.code === "22P02") return res.status(400).json({ error: "invalid_value" });
    sendError(res, next, e);
  }
};
const created = data => ({ __status: 201, data });
const sourceView = s => ({ id: s.id, title: s.title, creator: s.creator, date: s.created_date, kind: s.media_kind, archive: s.archive,
  url: s.archive_url, rights: s.rights, excerpt: s.excerpt, description: s.description, status: s.status, prompts: s.prompts || undefined });
const numberOr = (v, d = null) => (v === null || v === undefined || v === "" ? d : Number(v));

async function courseFor(client, id, { manage = false } = {}) {
  if (!validId(id)) throw new HttpError(400, "invalid_course_id");
  const c = await one(client, `SELECT c.*,u.display_name AS teacher_name,eduos_can_manage_course(c.id) AS can_manage FROM courses c
      JOIN users u ON u.id=c.teacher_user_id WHERE c.id=$1 AND eduos_can_see_course(c.id)`, [id]);
  if (!c) throw new HttpError(404, "course_not_found");
  if (manage && !c.can_manage) throw new HttpError(403, "not_your_course");
  return c;
}
async function assignmentFor(client, id) {
  if (!validId(id)) throw new HttpError(400, "invalid_assignment_id");
  const a = await one(client, `SELECT a.*,eduos_can_manage_assignment(a.id) AS can_manage FROM assignments a WHERE a.id=$1 AND eduos_can_see_assignment(a.id)`, [id]);
  if (!a) throw new HttpError(404, "assignment_not_found");
  return a;
}
async function enrolledLearner(client, actor, courseId) {
  const learner = await resolveLearner(client, actor);
  const e = await one(client, `SELECT 1 FROM course_enrollments WHERE course_id=$1 AND student_id=$2 AND status='active'`, [courseId, learner.id]);
  if (!e) throw new HttpError(403, "not_enrolled");
  return learner;
}
async function standardsById(client, ids) {
  if (!Array.isArray(ids) || ids.length > 12 || !ids.every(validId)) throw new HttpError(400, "invalid_standard_ids");
  const found = await rows(client, `SELECT id FROM learning_standards WHERE id=ANY($1::uuid[])`, [ids]);
  if (found.length !== new Set(ids).size) throw new HttpError(400, "unknown_standard");
  return ids;
}

/** Item view for learners: never includes the key. */
const itemView = i => ({ id: i.id, seq: i.seq, kind: i.kind, prompt: i.prompt, choices: i.choices, points: Number(i.points),
  standardId: i.standard_id, standardCode: i.standard_code || null, source: i.source_id ? { id: i.source_id, title: i.source_title, url: i.source_url, archive: i.source_archive, excerpt: i.source_excerpt } : null });
async function quizItems(client, assignmentId) {
  return rows(client, `SELECT i.*,ls.code AS standard_code,ps.title AS source_title,ps.archive_url AS source_url,ps.archive AS source_archive,ps.excerpt AS source_excerpt
      FROM quiz_items i LEFT JOIN learning_standards ls ON ls.id=i.standard_id LEFT JOIN primary_sources ps ON ps.id=i.source_id
      WHERE i.assignment_id=$1 ORDER BY i.seq`, [assignmentId]);
}

/** Mastery evidence from a scored attempt: one piece per standard, from the points scored so far. */
async function evidenceFromAttempt(client, actor, attempt, assignment, onlyItems = null) {
  const items = await rows(client, `SELECT i.id,i.standard_id,i.points::float8 AS points,r.auto_points::float8 AS auto_points,r.teacher_points::float8 AS teacher_points
      FROM quiz_items i LEFT JOIN quiz_responses r ON r.item_id=i.id AND r.attempt_id=$2 WHERE i.assignment_id=$1 AND i.standard_id IS NOT NULL`,
    [assignment.id, attempt.id]);
  const per = new Map();
  for (const it of items) {
    if (onlyItems && !onlyItems.has(it.id)) continue;
    const got = it.teacher_points ?? it.auto_points;
    if (got == null) continue;
    const p = per.get(it.standard_id) || { got: 0, max: 0 };
    p.got += got; p.max += it.points; per.set(it.standard_id, p);
  }
  const out = [];
  for (const [standardId, p] of per) {
    if (!p.max) continue;
    const r = await addEvidence(client, actor, { schoolId: attempt.school_id, studentId: attempt.student_id, standardId, source: "quiz",
      sourceRef: attempt.id, label: `${assignment.title} (attempt ${attempt.attempt_no})`, score: p.got / p.max });
    out.push({ standardId, mastery: r.mastery, level: r.level, milestone: Boolean(r.milestone) });
  }
  return out;
}

async function attemptView(client, actor, attemptId) {
  const a = await one(client, `SELECT q.*,x.title,x.max_attempts,x.retake_policy,x.time_limit_minutes,x.course_id FROM quiz_attempts q JOIN assignments x ON x.id=q.assignment_id WHERE q.id=$1`, [attemptId]);
  if (!a) throw new HttpError(404, "attempt_not_found");
  const items = await quizItems(client, a.assignment_id);
  const resp = new Map((await rows(client, `SELECT * FROM quiz_responses WHERE attempt_id=$1`, [a.id])).map(r => [r.item_id, r]));
  const used = (await one(client, `SELECT count(*)::int AS n FROM quiz_attempts WHERE assignment_id=$1 AND student_id=$2`, [a.assignment_id, a.student_id])).n;
  const finished = a.status !== "in_progress";
  const reveal = isStaff(actor) || (["scored", "returned"].includes(a.status) && used >= a.max_attempts);
  const keys = finished && reveal ? new Map((await rows(client, `SELECT item_id,answer_key FROM eduos_quiz_keys($1)`, [a.id])).map(k => [k.item_id, k.answer_key])) : new Map();
  const showComments = isStaff(actor) || a.status === "returned";
  const now = Date.now();
  return {
    id: a.id, assignmentId: a.assignment_id, title: a.title, attemptNo: a.attempt_no, maxAttempts: a.max_attempts, attemptsUsed: used,
    retakePolicy: a.retake_policy, status: a.status, startedAt: a.started_at, deadlineAt: a.deadline_at, submittedAt: a.submitted_at, late: a.late,
    secondsLeft: a.deadline_at && !finished ? Math.max(0, Math.round((new Date(a.deadline_at) - now) / 1000)) : null,
    extraTimePct: a.extra_time_pct, readAloud: a.read_aloud,
    totalPoints: numberOr(a.total_points), autoPoints: numberOr(a.auto_points), possiblePoints: numberOr(a.possible_points),
    canRetake: actor.role === "pupil" && finished && used < a.max_attempts,
    answersShown: keys.size > 0,
    items: items.map(i => {
      const r = resp.get(i.id);
      const v = { ...itemView(i), response: r?.response ?? "" };
      if (finished) Object.assign(v, { autoCorrect: r?.auto_correct ?? null, points: Number(i.points), earned: numberOr(r?.teacher_points ?? r?.auto_points),
        needsTeacher: (r?.auto_correct ?? null) === null && r?.teacher_points == null });
      if (showComments && r?.teacher_comment) v.teacherComment = r.teacher_comment;
      if (keys.has(i.id)) v.answerKey = keys.get(i.id);
      return v;
    })
  };
}

export function registerLearningRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false });
  const read = [requireSession, requirePermission("learning", "read")];
  const write = (action) => [limiter, requireSession, requireCsrf, requirePermission("learning", action)];

  // ---------- standards and primary sources ----------
  app.get("/api/learning/standards", ...read, wrap(async client =>
    rows(client, `SELECT id,framework,code,subject,grade_level,description,source_url FROM learning_standards ORDER BY subject,code`)));

  app.get("/api/learning/sources", ...read, wrap(async (client, req) => {
    const list = await rows(client, `SELECT * FROM primary_sources WHERE status<>'retired' ORDER BY status DESC,title`);
    await audit(client, req, "read", "primary_sources", null, `n=${list.length}`);
    return list.map(sourceView);
  }));
  // Curate a draft source. Only Library of Congress / National Archives links are accepted (also enforced by the database).
  app.post("/api/learning/sources", ...write("teach"), wrap(async (client, req) => {
    const b = req.body || {};
    if (!cleanText(b.title, 200) || !["Library of Congress", "National Archives"].includes(b.archive) || typeof b.url !== "string" ||
        !/^https:\/\/(www\.)?(loc\.gov|archives\.gov)\/\S{1,255}$/.test(b.url) || !cleanText(b.rights, 300) || !cleanText(b.description, 1000) ||
        !["document", "photograph", "telegram", "letter", "map", "speech", "other"].includes(b.kind) ||
        (b.excerpt != null && (typeof b.excerpt !== "string" || b.excerpt.length > 6000)))
      throw new HttpError(400, "invalid_source", { hint: "Link a real item at loc.gov or archives.gov and state its rights." });
    const s = await one(client, `INSERT INTO primary_sources(district_id,title,creator,created_date,media_kind,archive,archive_url,rights,excerpt,description,curated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.actor.districtId, b.title.trim(), b.creator || null, b.date || null, b.kind, b.archive, b.url, b.rights.trim(), b.excerpt || null, b.description.trim(), req.actor.userId]);
    await audit(client, req, "create", "primary_source", s.id);
    return created(sourceView(s));
  }));
  app.post("/api/learning/sources/:id/approve", ...write("approve"), wrap(async (client, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_source_id");
    const r = await client.query(`UPDATE primary_sources SET status='approved',approved_by=$2,approved_at=now() WHERE id=$1 AND status='draft'`, [req.params.id, req.actor.userId]);
    if (!r.rowCount) throw new HttpError(404, "draft_not_found");
    await audit(client, req, "approve", "primary_source", req.params.id);
    return { approved: true };
  }));

  // ---------- courses ----------
  app.get("/api/learning/courses", ...read, wrap(async (client, req) => {
    if (isStaff(req.actor)) {
      const list = await rows(client, `SELECT c.id,c.title,c.subject,c.grade_level,c.term,c.status,u.display_name AS teacher_name,
          (SELECT count(*)::int FROM course_enrollments e WHERE e.course_id=c.id AND e.status='active') AS students,
          (SELECT count(*)::int FROM lessons l WHERE l.course_id=c.id) AS lessons,
          (SELECT count(*)::int FROM quiz_attempts q JOIN assignments a ON a.id=q.assignment_id WHERE a.course_id=c.id AND q.status='needs_review') AS to_review,
          (SELECT count(*)::int FROM assignment_submissions s JOIN assignments a ON a.id=s.assignment_id WHERE a.course_id=c.id AND s.graded_at IS NULL) AS to_grade
          FROM courses c JOIN users u ON u.id=c.teacher_user_id WHERE eduos_can_manage_course(c.id) AND c.status<>'archived'
          ORDER BY (c.teacher_user_id=$1) DESC, c.title`, [req.actor.userId]);
      return { courses: list };
    }
    const learner = await resolveLearner(client, req.actor, req.query.studentId);
    const list = await rows(client, `SELECT c.id,c.title,c.subject,c.grade_level,c.term,u.display_name AS teacher_name FROM course_enrollments e
        JOIN courses c ON c.id=e.course_id JOIN users u ON u.id=c.teacher_user_id WHERE e.student_id=$1 AND e.status='active' AND c.status='active' ORDER BY c.title`, [learner.id]);
    for (const c of list) {
      const stds = await courseStandards(client, c.id);
      c.mastery = courseMastery(stds.map(s => s.id), await learnerStandardMastery(client, learner.id, stds.map(s => s.id)));
      const g = await courseGradeData(client, c.id, [learner.id]);
      c.grade = g.byStudent.get(learner.id).grade;
      const next = await one(client, `SELECT a.id,a.title,a.kind,a.due_at FROM assignments a WHERE a.course_id=$1 AND a.status='published'
          AND NOT EXISTS(SELECT 1 FROM assignment_submissions s WHERE s.assignment_id=a.id AND s.student_id=$2)
          AND NOT EXISTS(SELECT 1 FROM quiz_attempts q WHERE q.assignment_id=a.id AND q.student_id=$2 AND q.status<>'in_progress')
          ORDER BY a.due_at NULLS LAST LIMIT 1`, [c.id, learner.id]);
      c.next = next;
    }
    await audit(client, req, "read", "courses", learner.id, `n=${list.length}`);
    return { learner: { id: learner.id, name: learner.display_name }, courses: list };
  }));

  app.post("/api/learning/courses", ...write("teach"), wrap(async (client, req) => {
    const { title, subject, gradeLevel, term = "Year", gradeWeights } = req.body || {};
    if (!cleanText(title, 120) || !cleanText(subject, 40) || !cleanText(gradeLevel, 4) || !cleanText(term, 40) || !req.actor.schoolId ||
        (gradeWeights !== undefined && (typeof gradeWeights !== "object" || Array.isArray(gradeWeights) || !Object.values(gradeWeights).every(v => Number.isFinite(v) && v >= 0 && v <= 100))))
      throw new HttpError(400, "invalid_course");
    const c = await one(client, `INSERT INTO courses(district_id,school_id,teacher_user_id,title,subject,grade_level,term,grade_weights)
        VALUES($1,$2,$3,$4,$5,$6,$7,coalesce($8::jsonb,'{"Classwork":40,"Quizzes":60}'::jsonb)) RETURNING id,title`,
      [req.actor.districtId, req.actor.schoolId, req.actor.userId, title.trim(), subject.trim(), gradeLevel.trim(), term.trim(), gradeWeights ? JSON.stringify(gradeWeights) : null]);
    await audit(client, req, "create", "course", c.id);
    return created(c);
  }));

  app.get("/api/learning/courses/:id", ...read, wrap(async (client, req) => {
    const c = await courseFor(client, req.params.id);
    const manage = c.can_manage;
    const learner = manage ? null : await resolveLearner(client, req.actor, req.query.studentId);
    const units = await rows(client, `SELECT id,seq,title,summary FROM course_units WHERE course_id=$1 ORDER BY seq`, [c.id]);
    const lessons = await rows(client, `SELECT l.id,l.unit_id,l.seq,l.title,l.objective,l.status,l.approved_at IS NOT NULL AS approved,l.generated_by AS "generatedBy",
        coalesce((SELECT array_agg(ls.code ORDER BY ls.code) FROM lesson_standards x JOIN learning_standards ls ON ls.id=x.standard_id WHERE x.lesson_id=l.id), '{}') AS standards,
        (SELECT count(*)::int FROM lesson_sources s WHERE s.lesson_id=l.id) AS sources
        FROM lessons l WHERE l.course_id=$1 ORDER BY l.seq`, [c.id]);
    const work = await rows(client, `SELECT id,lesson_id,title,kind,category,points_possible::float8 AS points,due_at,status,max_attempts,time_limit_minutes FROM assignments
        WHERE course_id=$1 ${manage ? "" : "AND status IN ('published','closed')"} ORDER BY coalesce(due_at,created_at)`, [c.id]);
    const stds = await courseStandards(client, c.id);
    const out = { id: c.id, title: c.title, subject: c.subject, gradeLevel: c.grade_level, term: c.term, status: c.status, teacher: c.teacher_name,
      gradeWeights: c.grade_weights, canManage: manage, standards: stds, units: units.map(u => ({ ...u, lessons: lessons.filter(l => l.unit_id === u.id) })), assignments: work };
    if (learner) {
      const m = await learnerStandardMastery(client, learner.id, stds.map(s => s.id));
      out.learner = { id: learner.id, name: learner.display_name };
      out.standards = stds.map(s => ({ ...s, mastery: m.get(s.id)?.mastery ?? null, level: m.get(s.id)?.level ?? "not_started" }));
      out.mastery = courseMastery(stds.map(s => s.id), m);
      const g = await courseGradeData(client, c.id, [learner.id]);
      const mine = g.byStudent.get(learner.id);
      out.grade = mine.grade;
      out.assignments = work.map(w => ({ ...w, mine: mine.cells.find(x => x.assignmentId === w.id) || null }));
    } else out.students = await rows(client, `SELECT * FROM eduos_course_students($1)`, [c.id]);
    await audit(client, req, "read", "course", c.id);
    return out;
  }));

  app.post("/api/learning/courses/:id/enrollments", ...write("teach"), wrap(async (client, req) => {
    const c = await courseFor(client, req.params.id, { manage: true });
    const ids = req.body?.studentIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 60 || !ids.every(validId)) throw new HttpError(400, "invalid_student_ids");
    const ok = await rows(client, `SELECT id FROM students WHERE id=ANY($1::uuid[]) AND school_id=$2`, [ids, c.school_id]);
    if (ok.length !== new Set(ids).size) throw new HttpError(400, "student_not_at_school");
    for (const s of ok) await client.query(`INSERT INTO course_enrollments(course_id,district_id,student_id) VALUES($1,$2,$3)
        ON CONFLICT(course_id,student_id) DO UPDATE SET status='active'`, [c.id, req.actor.districtId, s.id]);
    await audit(client, req, "enroll", "course", c.id, `n=${ok.length}`);
    return { enrolled: ok.length };
  }));

  app.post("/api/learning/courses/:id/units", ...write("teach"), wrap(async (client, req) => {
    const c = await courseFor(client, req.params.id, { manage: true });
    const { title, summary = null } = req.body || {};
    if (!cleanText(title, 120) || (summary !== null && (typeof summary !== "string" || summary.length > 1000))) throw new HttpError(400, "invalid_unit");
    const seq = (await one(client, `SELECT coalesce(max(seq),0)+1 AS n FROM course_units WHERE course_id=$1`, [c.id])).n;
    const u = await one(client, `INSERT INTO course_units(district_id,course_id,seq,title,summary) VALUES($1,$2,$3,$4,$5) RETURNING id,seq,title`,
      [req.actor.districtId, c.id, seq, title.trim(), summary]);
    await audit(client, req, "create", "course_unit", u.id);
    return created(u);
  }));

  // ---------- lessons ----------
  app.post("/api/learning/lessons", ...write("teach"), wrap(async (client, req) => {
    const { courseId, unitId, title, objective, content, standardIds = [], sources = [], status = "draft" } = req.body || {};
    const c = await courseFor(client, courseId, { manage: true });
    if (!validId(unitId) || !cleanText(title, 120) || !cleanText(objective, 300) || !cleanText(content, 8000) || !["draft", "published"].includes(status) ||
        !Array.isArray(sources) || sources.length > 6 || !sources.every(s => validId(s?.sourceId) && Array.isArray(s.prompts) && s.prompts.length >= 1 && s.prompts.length <= 6 && s.prompts.every(p => cleanText(p, 300))))
      throw new HttpError(400, "invalid_lesson");
    await standardsById(client, standardIds);
    const unit = await one(client, `SELECT id FROM course_units WHERE id=$1 AND course_id=$2`, [unitId, c.id]);
    if (!unit) throw new HttpError(400, "unit_not_in_course");
    const seq = (await one(client, `SELECT coalesce(max(seq),0)+1 AS n FROM lessons WHERE unit_id=$1`, [unitId])).n;
    const l = await one(client, `INSERT INTO lessons(district_id,course_id,unit_id,seq,title,objective,content,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,status`,
      [req.actor.districtId, c.id, unitId, seq, title.trim(), objective.trim(), content.trim(), status, req.actor.userId]);
    for (const s of standardIds) await client.query(`INSERT INTO lesson_standards(lesson_id,standard_id,district_id) VALUES($1,$2,$3)`, [l.id, s, req.actor.districtId]);
    let n = 1;
    for (const s of sources) {
      const src = await one(client, `SELECT id FROM primary_sources WHERE id=$1 AND status='approved'`, [s.sourceId]);
      if (!src) throw new HttpError(400, "source_not_approved");
      await client.query(`INSERT INTO lesson_sources(lesson_id,source_id,district_id,seq,prompts) VALUES($1,$2,$3,$4,$5)`, [l.id, s.sourceId, req.actor.districtId, n++, s.prompts.map(p => p.trim())]);
    }
    await audit(client, req, "create", "lesson", l.id, `standards=${standardIds.length};sources=${sources.length}`);
    return created(l);
  }));
  app.patch("/api/learning/lessons/:id", ...write("teach"), wrap(async (client, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_lesson_id");
    const { title, objective, content, status } = req.body || {};
    if ((title !== undefined && !cleanText(title, 120)) || (objective !== undefined && !cleanText(objective, 300)) ||
        (content !== undefined && !cleanText(content, 8000)) || (status !== undefined && !["draft", "published"].includes(status)) ||
        [title, objective, content, status].every(v => v === undefined)) throw new HttpError(400, "invalid_lesson_update");
    // 37.6.0: a Leo draft is published only after a school leader approves it
    // (also enforced by the database: db/062_leo_edison.sql).
    if (status === "published" && await one(client, `SELECT 1 FROM lessons WHERE id=$1 AND generated_by IS NOT NULL AND approved_at IS NULL AND status='draft'
        AND eduos_can_manage_course(course_id)`, [req.params.id])) throw new HttpError(409, "leo_draft_needs_approval");
    const l = await one(client, `UPDATE lessons SET title=coalesce($2,title),objective=coalesce($3,objective),content=coalesce($4,content),status=coalesce($5,status)
        WHERE id=$1 AND eduos_can_manage_course(course_id) RETURNING id,status,approved_at IS NOT NULL AS approved`,
      [req.params.id, title?.trim() ?? null, objective?.trim() ?? null, content?.trim() ?? null, status ?? null]);
    if (!l) throw new HttpError(404, "lesson_not_found");
    await audit(client, req, "update", "lesson", l.id, `approved=${l.approved}`);
    return l;
  }));
  // A school leader approves lesson text before Christie may use it for hints.
  app.post("/api/learning/lessons/:id/approve", ...write("approve"), wrap(async (client, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_lesson_id");
    const r = await client.query(`UPDATE lessons SET approved_by=$2,approved_at=now() WHERE id=$1 AND approved_at IS NULL
        AND eduos_is_school_lead((SELECT c.school_id FROM courses c WHERE c.id=course_id))`, [req.params.id, req.actor.userId]);
    if (!r.rowCount) throw new HttpError(404, "lesson_not_pending");
    await audit(client, req, "approve", "lesson", req.params.id);
    return { approved: true };
  }));
  app.get("/api/learning/lessons/:id", ...read, wrap(async (client, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_lesson_id");
    const l = await one(client, `SELECT l.*,c.title AS course_title,u.title AS unit_title,eduos_can_manage_course(l.course_id) AS can_manage FROM lessons l
        JOIN courses c ON c.id=l.course_id JOIN course_units u ON u.id=l.unit_id WHERE l.id=$1 AND eduos_can_see_lesson(l.id)`, [req.params.id]);
    if (!l) throw new HttpError(404, "lesson_not_found");
    const standards = await rows(client, `SELECT ls.id,ls.framework,ls.code,ls.description,ls.source_url FROM lesson_standards x JOIN learning_standards ls ON ls.id=x.standard_id WHERE x.lesson_id=$1 ORDER BY ls.code`, [l.id]);
    const sources = await rows(client, `SELECT ps.*,x.prompts FROM lesson_sources x JOIN primary_sources ps ON ps.id=x.source_id WHERE x.lesson_id=$1 AND ps.status='approved' ORDER BY x.seq`, [l.id]);
    const skills = await rows(client, `SELECT id,title,code FROM christie_skills WHERE lesson_id=$1 AND status='approved' ORDER BY sequence`, [l.id]);
    const work = await rows(client, `SELECT id,title,kind,due_at,status FROM assignments WHERE lesson_id=$1 ${l.can_manage ? "" : "AND status IN ('published','closed')"} ORDER BY coalesce(due_at,created_at)`, [l.id]);
    let mastery = null;
    if (!l.can_manage && ["pupil", "parent"].includes(req.actor.role)) {
      const learner = await resolveLearner(client, req.actor, req.query.studentId);
      const m = await learnerStandardMastery(client, learner.id, standards.map(s => s.id));
      mastery = Object.fromEntries(standards.map(s => [s.id, m.get(s.id) ? { mastery: m.get(s.id).mastery, level: m.get(s.id).level } : null]));
    }
    // TEACH-02: "Adapted from" a colleague's shared material (for the people who manage the lesson).
    const adaptedFrom = l.can_manage && l.adapted_from ? (await one(client, `SELECT m.title,u.display_name AS author,s.name AS school FROM shared_materials m
        JOIN users u ON u.id=m.author_user_id JOIN schools s ON s.id=m.school_id WHERE m.id=$1`, [l.adapted_from])) || { withdrawn: true } : undefined;
    await audit(client, req, "read", "lesson", l.id);
    return { id: l.id, courseId: l.course_id, course: l.course_title, unit: l.unit_title, title: l.title, objective: l.objective, content: l.content,
      status: l.status, approved: Boolean(l.approved_at), canManage: l.can_manage, generatedBy: l.can_manage ? l.generated_by : undefined, adaptedFrom, standards, sources: sources.map(sourceView), christieSkills: skills, assignments: work, mastery };
  }));

  // ---------- assignments (work with rubric, or quiz) ----------
  app.post("/api/learning/assignments", ...write("teach"), wrap(async (client, req) => {
    const b = req.body || {};
    const c = await courseFor(client, b.courseId, { manage: true });
    const kind = b.kind === "quiz" ? "quiz" : "work";
    const items = kind === "quiz" ? b.items : [];
    if (!cleanText(b.title, 180) || (b.instructions != null && (typeof b.instructions !== "string" || b.instructions.length > 10000)) ||
        (b.lessonId != null && !validId(b.lessonId)) || (b.dueAt != null && Number.isNaN(Date.parse(b.dueAt))) ||
        !["draft", "published"].includes(b.status ?? "published") || (b.category != null && !cleanText(b.category, 40)) ||
        (b.rubric != null && (kind === "quiz" || !validRubric(b.rubric))) ||
        (b.maxAttempts != null && !(Number.isInteger(b.maxAttempts) && b.maxAttempts >= 1 && b.maxAttempts <= 10)) ||
        (b.retakePolicy != null && !["highest", "latest", "average"].includes(b.retakePolicy)) ||
        (b.timeLimitMinutes != null && !(Number.isInteger(b.timeLimitMinutes) && b.timeLimitMinutes >= 1 && b.timeLimitMinutes <= 240)) ||
        (kind === "quiz" && (!Array.isArray(items) || items.length < 1 || items.length > 50)) ||
        (kind === "work" && b.rubric == null && !(Number(b.pointsPossible) > 0)))
      throw new HttpError(400, "invalid_assignment");
    for (const it of items) {
      if (!["mc", "short", "numeric", "source"].includes(it?.kind) || !cleanText(it.prompt, 1000) || !(Number(it.points ?? 1) > 0 && Number(it.points ?? 1) <= 100) ||
          (it.kind === "mc" ? !(Array.isArray(it.choices) && it.choices.length >= 2 && it.choices.length <= 6 && it.choices.every(ch => cleanText(ch, 200))) : it.choices != null) ||
          (it.kind === "source" && !validId(it.sourceId)) || !validKey(it.kind, it.kind === "source" ? (it.key || {}) : it.key, it.choices) ||
          (it.standardId != null && !validId(it.standardId)))
        throw new HttpError(400, "invalid_quiz_item", { seq: items.indexOf(it) + 1 });
    }
    const standardIds = [...new Set([...(b.standardIds || []), ...items.map(i => i.standardId).filter(Boolean), ...(b.rubric || []).map(r => r.standardId).filter(Boolean)])];
    await standardsById(client, standardIds);
    if (b.lessonId && !(await one(client, `SELECT 1 FROM lessons WHERE id=$1 AND course_id=$2`, [b.lessonId, c.id]))) throw new HttpError(400, "lesson_not_in_course");
    const points = kind === "quiz" ? items.reduce((x, i) => x + Number(i.points ?? 1), 0)
      : b.rubric ? b.rubric.reduce((x, r) => x + Math.max(...r.levels.map(l => l.points)), 0) : Number(b.pointsPossible);
    const a = await one(client, `INSERT INTO assignments(district_id,school_id,created_by,title,instructions,due_at,status,course_id,lesson_id,kind,points_possible,category,rubric,max_attempts,retake_policy,time_limit_minutes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id,title,kind,points_possible::float8 AS points,status`,
      [req.actor.districtId, c.school_id, req.actor.userId, b.title.trim(), b.instructions || "", b.dueAt || null, b.status ?? "published", c.id, b.lessonId || null, kind, points,
       b.category || (kind === "quiz" ? "Quizzes" : "Classwork"), b.rubric ? JSON.stringify(b.rubric) : null, b.maxAttempts ?? 1, b.retakePolicy ?? "highest", b.timeLimitMinutes ?? null]);
    for (const s of standardIds) await client.query(`INSERT INTO assignment_standards(assignment_id,standard_id,district_id) VALUES($1,$2,$3)`, [a.id, s, req.actor.districtId]);
    let seq = 1;
    for (const it of items) {
      if (it.sourceId && !(await one(client, `SELECT 1 FROM primary_sources WHERE id=$1 AND status='approved'`, [it.sourceId]))) throw new HttpError(400, "source_not_approved");
      const row = await one(client, `INSERT INTO quiz_items(district_id,assignment_id,seq,kind,prompt,choices,points,standard_id,source_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [req.actor.districtId, a.id, seq++, it.kind, it.prompt.trim(), it.choices || null, Number(it.points ?? 1), it.standardId || null, it.sourceId || null]);
      await client.query(`INSERT INTO quiz_item_keys(item_id,district_id,answer_key) VALUES($1,$2,$3)`, [row.id, req.actor.districtId, JSON.stringify(it.key || {})]);
    }
    await audit(client, req, "create", "assignment", a.id, `kind=${kind};items=${items.length}`);
    return created(a);
  }));

  app.get("/api/learning/assignments/:id", ...read, wrap(async (client, req) => {
    const a = await assignmentFor(client, req.params.id);
    const standards = await rows(client, `SELECT ls.id,ls.code,ls.description FROM assignment_standards x JOIN learning_standards ls ON ls.id=x.standard_id WHERE x.assignment_id=$1 ORDER BY ls.code`, [a.id]);
    const out = { id: a.id, courseId: a.course_id, lessonId: a.lesson_id, title: a.title, instructions: a.instructions, kind: a.kind, category: a.category,
      points: Number(a.points_possible), dueAt: a.due_at, status: a.status, rubric: a.rubric, maxAttempts: a.max_attempts, retakePolicy: a.retake_policy,
      timeLimitMinutes: a.time_limit_minutes, standards, canManage: a.can_manage };
    if (a.kind === "quiz") {
      const items = await quizItems(client, a.id);
      out.itemCount = items.length;
      if (a.can_manage) {
        const keys = new Map((await rows(client, `SELECT item_id,answer_key FROM quiz_item_keys WHERE item_id=ANY($1::uuid[])`, [items.map(i => i.id)])).map(k => [k.item_id, k.answer_key]));
        out.items = items.map(i => ({ ...itemView(i), answerKey: keys.get(i.id) }));
      }
    }
    if (a.can_manage) {
      out.submissions = a.kind === "quiz"
        ? await rows(client, `SELECT q.id,q.student_id,s.display_name,q.attempt_no,q.status,q.total_points::float8 AS total,q.possible_points::float8 AS possible,q.late,q.submitted_at,q.extra_time_pct
            FROM quiz_attempts q JOIN students s ON s.id=q.student_id WHERE q.assignment_id=$1 ORDER BY s.display_name,q.attempt_no`, [a.id])
        : await rows(client, `SELECT x.id,x.student_id,s.display_name,x.response_text,x.submitted_at,x.score::float8 AS score,x.points_earned::float8 AS points_earned,x.rubric_scores,x.feedback,x.graded_at,x.returned_at
            FROM assignment_submissions x JOIN students s ON s.id=x.student_id WHERE x.assignment_id=$1 ORDER BY s.display_name`, [a.id]);
    } else {
      const learner = await resolveLearner(client, req.actor, req.query.studentId);
      if (a.kind === "quiz") {
        out.attempts = await rows(client, `SELECT id,attempt_no,status,total_points::float8 AS total,possible_points::float8 AS possible,submitted_at,late FROM quiz_attempts
            WHERE assignment_id=$1 AND student_id=$2 ORDER BY attempt_no`, [a.id, learner.id]);
        const acc = await one(client, `SELECT extra_time_pct,read_aloud FROM student_accommodations WHERE student_id=$1`, [learner.id]);
        out.accommodations = { extraTimePct: acc?.extra_time_pct || 0, readAloud: Boolean(acc?.read_aloud) };
        out.effectiveMinutes = a.time_limit_minutes ? Math.round(a.time_limit_minutes * (1 + (acc?.extra_time_pct || 0) / 100)) : null;
      } else {
        const s = await one(client, `SELECT id,response_text,submitted_at,score::float8 AS score,points_earned::float8 AS points_earned,rubric_scores,feedback,graded_at,returned_at
            FROM assignment_submissions WHERE assignment_id=$1 AND student_id=$2`, [a.id, learner.id]);
        // Feedback and rubric scores are shown once the teacher returns the work.
        out.submission = s && (s.returned_at ? s : { id: s.id, response_text: s.response_text, submitted_at: s.submitted_at, graded: Boolean(s.graded_at) });
      }
    }
    await audit(client, req, "read", "assignment", a.id);
    return out;
  }));

  // Rubric (or points) grading with feedback; returning makes it visible to the learner and family.
  app.post("/api/learning/assignments/:id/grade", ...write("grade"), wrap(async (client, req) => {
    const a = await assignmentFor(client, req.params.id);
    if (!a.can_manage || a.kind !== "work") throw new HttpError(403, "not_gradable_here");
    const { studentId, scores, points, feedback = "", returnToStudent = true } = req.body || {};
    if (!validId(studentId) || typeof feedback !== "string" || feedback.length > 4000) throw new HttpError(400, "invalid_grade");
    const learner = await resolveLearner(client, req.actor, studentId);
    let earned, rubricRows = null;
    if (a.rubric) {
      if (!Array.isArray(scores)) throw new HttpError(400, "rubric_scores_required");
      try { const t = rubricTotals(a.rubric, scores); earned = t.earned; rubricRows = t.rows; } catch (e) { throw new HttpError(400, "invalid_rubric_scores", { detail: e.message }); }
    } else {
      if (!(typeof points === "number" && points >= 0 && points <= Number(a.points_possible))) throw new HttpError(400, "invalid_points");
      earned = points;
    }
    const pct = Math.round((earned / Number(a.points_possible)) * 10000) / 100;
    const s = await one(client, `INSERT INTO assignment_submissions(district_id,assignment_id,student_id,response_text,submitted_at,score,points_earned,rubric_scores,feedback,graded_by,graded_at,returned_at,grade_source)
        VALUES($1,$2,$3,'(graded in class)',now(),$4,$5,$6,$7,$8,now(),CASE WHEN $9 THEN now() END,'teacher')
        ON CONFLICT(assignment_id,student_id) DO UPDATE SET score=$4,points_earned=$5,rubric_scores=$6,feedback=$7,graded_by=$8,graded_at=now(),grade_source='teacher',
          returned_at=CASE WHEN $9 THEN now() ELSE assignment_submissions.returned_at END RETURNING id`,
      [req.actor.districtId, a.id, learner.id, pct, earned, rubricRows ? JSON.stringify(rubricRows) : null, feedback, req.actor.userId, Boolean(returnToStudent)]);
    // Rubric rows tied to a standard become mastery evidence.
    const evidence = [];
    for (const r of rubricRows || []) if (r.standardId) {
      const m = await addEvidence(client, req.actor, { schoolId: a.school_id, studentId: learner.id, standardId: r.standardId, source: "rubric", sourceRef: s.id,
        label: `${a.title}: ${r.title}`, score: r.max ? r.points / r.max : 0 });
      evidence.push({ standardId: r.standardId, mastery: m.mastery, level: m.level, milestone: Boolean(m.milestone) });
    }
    await audit(client, req, "grade", "assignment_submission", s.id, `points=${earned};returned=${Boolean(returnToStudent)}`);
    return { submissionId: s.id, earned, possible: Number(a.points_possible), percent: pct, rubric: rubricRows, evidence };
  }));

  // ---------- quizzes ----------
  app.post("/api/learning/quizzes/:id/attempts", ...write("learn"), wrap(async (client, req) => {
    const a = await assignmentFor(client, req.params.id);
    if (a.kind !== "quiz" || a.status !== "published") throw new HttpError(409, "quiz_not_open");
    if (a.due_at && new Date(a.due_at) < Date.now()) throw new HttpError(409, "quiz_past_due");
    const learner = await enrolledLearner(client, req.actor, a.course_id);
    const open = await one(client, `SELECT id FROM quiz_attempts WHERE assignment_id=$1 AND student_id=$2 AND status='in_progress'`, [a.id, learner.id]);
    if (open) return { attempt: await attemptView(client, req.actor, open.id), resumed: true };
    const used = (await one(client, `SELECT count(*)::int AS n FROM quiz_attempts WHERE assignment_id=$1 AND student_id=$2`, [a.id, learner.id])).n;
    if (used >= a.max_attempts) throw new HttpError(409, "no_attempts_left", { maxAttempts: a.max_attempts });
    const acc = await one(client, `SELECT extra_time_pct,read_aloud FROM student_accommodations WHERE student_id=$1`, [learner.id]);
    const now = new Date();
    const deadline = deadlineFor(now, a.time_limit_minutes, acc?.extra_time_pct || 0);
    const at = await one(client, `INSERT INTO quiz_attempts(district_id,school_id,assignment_id,student_id,user_id,attempt_no,started_at,deadline_at,extra_time_pct,read_aloud)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [req.actor.districtId, a.school_id, a.id, learner.id, req.actor.userId, used + 1, now, deadline, acc?.extra_time_pct || 0, Boolean(acc?.read_aloud)]);
    await audit(client, req, "start", "quiz_attempt", at.id, `attempt=${used + 1}`);
    return created({ attempt: await attemptView(client, req.actor, at.id), resumed: false });
  }));

  app.get("/api/learning/attempts/:id", ...read, wrap(async (client, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_attempt_id");
    const v = await attemptView(client, req.actor, req.params.id);
    await audit(client, req, "read", "quiz_attempt", v.id);
    return v;
  }));

  app.put("/api/learning/attempts/:id/responses/:itemId", ...write("learn"), wrap(async (client, req) => {
    if (!validId(req.params.id) || !validId(req.params.itemId)) throw new HttpError(400, "invalid_id");
    const response = req.body?.response;
    if (typeof response !== "string" || response.length > 2000) throw new HttpError(400, "invalid_response");
    const at = await one(client, `SELECT q.id,q.assignment_id,q.deadline_at FROM quiz_attempts q WHERE q.id=$1 AND eduos_my_open_attempt(q.id)`, [req.params.id]);
    if (!at) throw new HttpError(409, "attempt_not_open");
    if (at.deadline_at && Date.now() > new Date(at.deadline_at).getTime() + GRACE_MS) throw new HttpError(409, "time_up");
    const item = await one(client, `SELECT id FROM quiz_items WHERE id=$1 AND assignment_id=$2`, [req.params.itemId, at.assignment_id]);
    if (!item) throw new HttpError(404, "item_not_in_quiz");
    await client.query(`INSERT INTO quiz_responses(attempt_id,item_id,district_id,response) VALUES($1,$2,$3,$4)
        ON CONFLICT(attempt_id,item_id) DO UPDATE SET response=$4,saved_at=now()`, [at.id, item.id, req.actor.districtId, response]);
    return { saved: true };
  }));

  app.post("/api/learning/attempts/:id/submit", ...write("learn"), wrap(async (client, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_attempt_id");
    const sub = await one(client, `SELECT * FROM eduos_quiz_submit($1)`, [req.params.id]);
    if (!sub) throw new HttpError(409, "attempt_not_open");
    const attempt = await one(client, `SELECT * FROM quiz_attempts WHERE id=$1`, [req.params.id]);
    const assignment = await one(client, `SELECT * FROM assignments WHERE id=$1`, [attempt.assignment_id]);
    const items = await rows(client, `SELECT id,kind,points FROM quiz_items WHERE assignment_id=$1 ORDER BY seq`, [assignment.id]);
    const keys = new Map((await rows(client, `SELECT item_id,answer_key FROM eduos_quiz_keys($1)`, [attempt.id])).map(k => [k.item_id, k.answer_key]));
    const resp = new Map((await rows(client, `SELECT item_id,response FROM quiz_responses WHERE attempt_id=$1`, [attempt.id])).map(r => [r.item_id, r.response]));
    const scores = items.map(i => { const s = scoreItem(i, keys.get(i.id), resp.get(i.id)); return { itemId: i.id, correct: s.correct, points: s.points }; });
    const possible = items.reduce((x, i) => x + Number(i.points), 0);
    const status = (await one(client, `SELECT eduos_quiz_record_auto($1,$2::jsonb,$3) AS s`, [attempt.id, JSON.stringify(scores), possible])).s;
    const evidence = await evidenceFromAttempt(client, req.actor, attempt, assignment, new Set(scores.filter(s => s.correct !== null).map(s => s.itemId)));
    await audit(client, req, "submit", "quiz_attempt", attempt.id, `status=${status};late=${sub.late}`);
    return { attempt: await attemptView(client, req.actor, attempt.id), evidence };
  }));

  // Teacher review: score the items that need a person, add comments, return.
  app.get("/api/learning/review", ...read, roleIn(...STAFF), wrap(async (client, req) => {
    const list = await rows(client, `SELECT q.id,q.attempt_no,q.status,q.submitted_at,q.late,q.extra_time_pct,a.id AS assignment_id,a.title,c.title AS course,s.display_name
        FROM quiz_attempts q JOIN assignments a ON a.id=q.assignment_id JOIN courses c ON c.id=a.course_id JOIN students s ON s.id=q.student_id
        WHERE q.status IN ('needs_review','scored') AND eduos_can_manage_course(c.id) ORDER BY (q.status='needs_review') DESC,q.submitted_at LIMIT 100`);
    const work = await rows(client, `SELECT x.id,x.submitted_at,a.id AS assignment_id,a.title,c.title AS course,s.display_name,x.student_id
        FROM assignment_submissions x JOIN assignments a ON a.id=x.assignment_id JOIN courses c ON c.id=a.course_id JOIN students s ON s.id=x.student_id
        WHERE x.graded_at IS NULL AND eduos_can_manage_course(c.id) ORDER BY x.submitted_at LIMIT 100`);
    return { attempts: list, work };
  }));
  app.post("/api/learning/attempts/:id/review", ...write("grade"), wrap(async (client, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_attempt_id");
    const { scores = [], returnToStudent = true } = req.body || {};
    if (!Array.isArray(scores) || scores.length > 50 || !scores.every(s => validId(s?.itemId) && (s.points === undefined || (typeof s.points === "number" && s.points >= 0)) &&
        (s.comment === undefined || (typeof s.comment === "string" && s.comment.length <= 1000)))) throw new HttpError(400, "invalid_review");
    const attempt = await one(client, `SELECT q.* FROM quiz_attempts q WHERE q.id=$1 AND eduos_learning_staff(q.school_id,q.student_id)`, [req.params.id]);
    if (!attempt) throw new HttpError(404, "attempt_not_found");
    const assignment = await one(client, `SELECT * FROM assignments WHERE id=$1 AND eduos_can_manage_assignment(id)`, [attempt.assignment_id]);
    if (!assignment) throw new HttpError(403, "not_your_quiz");
    if (attempt.status === "in_progress") throw new HttpError(409, "attempt_in_progress");
    const items = new Map((await rows(client, `SELECT id,points::float8 AS points FROM quiz_items WHERE assignment_id=$1`, [assignment.id])).map(i => [i.id, i]));
    const reviewed = new Set();
    for (const s of scores) {
      const it = items.get(s.itemId);
      if (!it || (s.points !== undefined && s.points > it.points)) throw new HttpError(400, "invalid_item_points");
      await client.query(`UPDATE quiz_responses SET teacher_points=coalesce($3,teacher_points),teacher_comment=coalesce($4,teacher_comment) WHERE attempt_id=$1 AND item_id=$2`,
        [attempt.id, s.itemId, s.points ?? null, s.comment ?? null]);
      if (s.points !== undefined) reviewed.add(s.itemId);
    }
    const t = await one(client, `SELECT count(*) FILTER (WHERE r.auto_correct IS NULL AND r.teacher_points IS NULL)::int AS pending,
        coalesce(sum(coalesce(r.teacher_points,r.auto_points)),0)::float8 AS total FROM quiz_items i LEFT JOIN quiz_responses r ON r.item_id=i.id AND r.attempt_id=$1
        WHERE i.assignment_id=$2`, [attempt.id, assignment.id]);
    const missingRows = (await one(client, `SELECT count(*)::int AS n FROM quiz_items i WHERE i.assignment_id=$1 AND i.kind IN ('short','source')
        AND NOT EXISTS(SELECT 1 FROM quiz_responses r WHERE r.attempt_id=$2 AND r.item_id=i.id)`, [assignment.id, attempt.id])).n;
    if (t.pending > 0 || missingRows > 0) throw new HttpError(409, "items_still_need_points", { pending: t.pending + missingRows });
    const status = returnToStudent ? "returned" : "scored";
    await client.query(`UPDATE quiz_attempts SET total_points=$2,status=$3,reviewed_by=$4,reviewed_at=now(),returned_at=CASE WHEN $3='returned' THEN now() END WHERE id=$1`,
      [attempt.id, t.total, status, req.actor.userId]);
    const evidence = reviewed.size ? await evidenceFromAttempt(client, req.actor, attempt, assignment, reviewed) : [];
    await audit(client, req, "review", "quiz_attempt", attempt.id, `status=${status};items=${reviewed.size}`);
    return { status, total: t.total, evidence };
  }));

  // ---------- accommodations ----------
  app.get("/api/learning/accommodations", ...read, roleIn(...STAFF), wrap(async (client, req) => {
    const c = await courseFor(client, req.query.courseId, { manage: true });
    return rows(client, `SELECT s.student_id,s.display_name,coalesce(a.extra_time_pct,0) AS extra_time_pct,coalesce(a.read_aloud,false) AS read_aloud,a.notes,a.updated_at
        FROM eduos_course_students($1) s LEFT JOIN student_accommodations a ON a.student_id=s.student_id ORDER BY s.display_name`, [c.id]);
  }));
  app.put("/api/learning/accommodations/:studentId", ...write("grade"), wrap(async (client, req) => {
    const { extraTimePct = 0, readAloud = false, notes = null } = req.body || {};
    if (!Number.isInteger(extraTimePct) || extraTimePct < 0 || extraTimePct > 200 || typeof readAloud !== "boolean" || (notes !== null && (typeof notes !== "string" || notes.length > 300)))
      throw new HttpError(400, "invalid_accommodation");
    const learner = await resolveLearner(client, req.actor, req.params.studentId);
    await client.query(`INSERT INTO student_accommodations(student_id,district_id,school_id,extra_time_pct,read_aloud,notes,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(student_id) DO UPDATE SET extra_time_pct=$4,read_aloud=$5,notes=$6,updated_by=$7,updated_at=now()`,
      [learner.id, req.actor.districtId, learner.school_id, extraTimePct, readAloud, notes, req.actor.userId]);
    await audit(client, req, "update", "student_accommodation", learner.id, `extra=${extraTimePct};read_aloud=${readAloud}`);
    return { studentId: learner.id, extraTimePct, readAloud };
  }));

  // ---------- gradebook and final grades ----------
  app.get("/api/learning/courses/:id/gradebook", ...read, roleIn(...STAFF), wrap(async (client, req) => {
    const c = await courseFor(client, req.params.id, { manage: true });
    const students = await rows(client, `SELECT * FROM eduos_course_students($1)`, [c.id]);
    const g = await courseGradeData(client, c.id, students.map(s => s.student_id));
    const finals = new Map((await rows(client, `SELECT DISTINCT ON (student_id) student_id,id,percent::float8 AS percent,letter,posted_at,edal_entry_id FROM course_final_grades
        WHERE course_id=$1 ORDER BY student_id,posted_at DESC`, [c.id])).map(f => [f.student_id, f]));
    const stds = await courseStandards(client, c.id);
    const m = stds.length ? await rows(client, `SELECT student_id,standard_id,mastery,level FROM standard_mastery WHERE standard_id=ANY($1::uuid[]) AND student_id=ANY($2::uuid[])`,
      [stds.map(s => s.id), students.map(s => s.student_id)]) : [];
    await audit(client, req, "read", "gradebook", c.id, `students=${students.length}`);
    return { course: { id: c.id, title: c.title, term: c.term, gradeWeights: c.grade_weights }, assignments: g.work, standards: stds,
      students: students.map(s => ({ id: s.student_id, name: s.display_name, ...g.byStudent.get(s.student_id), final: finals.get(s.student_id) || null,
        mastery: Object.fromEntries(m.filter(x => x.student_id === s.student_id).map(x => [x.standard_id, { mastery: x.mastery, level: x.level }])) })) };
  }));
  app.post("/api/learning/courses/:id/final-grades", ...write("grade"), wrap(async (client, req) => {
    const c = await courseFor(client, req.params.id, { manage: true });
    const { studentId, percent, reason = null } = req.body || {};
    if (!validId(studentId) || (percent !== undefined && !(typeof percent === "number" && percent >= 0 && percent <= 100)) ||
        (reason !== null && !cleanText(reason, 300, 10)) || (percent !== undefined && !reason)) throw new HttpError(400, "invalid_final_grade", { hint: "An override needs a reason of at least 10 characters." });
    const e = await one(client, `SELECT 1 FROM course_enrollments WHERE course_id=$1 AND student_id=$2`, [c.id, studentId]);
    if (!e) throw new HttpError(404, "student_not_in_course");
    let pct = percent;
    if (pct === undefined) {
      const g = (await courseGradeData(client, c.id, [studentId])).byStudent.get(studentId).grade;
      if (g.percent == null) throw new HttpError(409, "no_graded_work");
      pct = g.percent;
    }
    const posted = await postFinalGrade(client, req.actor, { course: c, student: { id: studentId }, percent: pct, letter: letterFor(pct), reason: reason?.trim() || null });
    await audit(client, req, "post", "final_grade", posted.id, `edal_seq=${posted.edal.seq}`);
    return created(posted);
  }));

  // ---------- credentials (school leaders) ----------
  app.get("/api/learning/credentials", ...read, roleIn(...LEADS), wrap(async client =>
    rows(client, `SELECT c.id,c.kind,c.title,c.issued_at,c.revoked_at,c.edal_entry_id,s.display_name,c.student_id FROM credentials c JOIN students s ON s.id=c.student_id ORDER BY c.issued_at DESC LIMIT 100`)));
  app.post("/api/learning/credentials", ...write("credential"), wrap(async (client, req) => {
    const { studentId, kind, title, description = null, courseId = null, standardId = null } = req.body || {};
    if (!["course_completion", "standard_mastery", "award"].includes(kind) || !cleanText(title, 160) || (description !== null && (typeof description !== "string" || description.length > 500)) ||
        (courseId !== null && !validId(courseId)) || (standardId !== null && !validId(standardId))) throw new HttpError(400, "invalid_credential");
    const learner = await resolveLearner(client, req.actor, studentId);
    if (kind === "standard_mastery") {
      const m = standardId && await one(client, `SELECT level FROM standard_mastery WHERE student_id=$1 AND standard_id=$2`, [learner.id, standardId]);
      if (m?.level !== "mastered") throw new HttpError(409, "standard_not_mastered");
    }
    const id = randomUUID();
    const entry = await appendEntry(client, req.actor, { kind: "credential", schoolId: learner.school_id, studentId: learner.id,
      payload: { recordId: id, studentId: learner.id, credential: kind, title: title.trim(), description, courseId, standardId, issuedByRole: req.actor.role } });
    await client.query(`INSERT INTO credentials(id,district_id,school_id,student_id,kind,title,description,course_id,standard_id,issued_by,edal_entry_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, req.actor.districtId, learner.school_id, learner.id, kind, title.trim(), description, courseId, standardId, req.actor.userId, entry.id]);
    await audit(client, req, "issue", "credential", id, `edal_seq=${entry.seq}`);
    return created({ id, edal: entry });
  }));
  app.post("/api/learning/credentials/:id/revoke", ...write("credential"), wrap(async (client, req) => {
    if (!validId(req.params.id) || !cleanText(req.body?.reason, 300, 10)) throw new HttpError(400, "invalid_revoke");
    const c = await one(client, `SELECT * FROM credentials WHERE id=$1 AND revoked_at IS NULL AND eduos_is_school_lead(school_id)`, [req.params.id]);
    if (!c) throw new HttpError(404, "credential_not_found");
    const entry = await appendEntry(client, req.actor, { kind: "credential_revoked", schoolId: c.school_id, studentId: c.student_id,
      payload: { recordId: c.id, studentId: c.student_id, revokes: c.edal_entry_id, reason: req.body.reason.trim() } });
    await client.query(`UPDATE credentials SET revoked_at=now(),revoked_by=$2,revoke_reason=$3 WHERE id=$1`, [c.id, req.actor.userId, req.body.reason.trim()]);
    await audit(client, req, "revoke", "credential", c.id, `edal_seq=${entry.seq}`);
    return { revoked: true, edal: entry };
  }));

  // ---------- approvals queue (school leaders) ----------
  app.get("/api/learning/approvals", ...read, roleIn(...LEADS), wrap(async client => ({
    sources: (await rows(client, `SELECT * FROM primary_sources WHERE status='draft' ORDER BY curated_at`)).map(sourceView),
    lessons: await rows(client, `SELECT l.id,l.title,l.objective,c.title AS course,u.display_name AS teacher FROM lessons l JOIN courses c ON c.id=l.course_id JOIN users u ON u.id=c.teacher_user_id
        WHERE l.approved_at IS NULL AND eduos_is_school_lead(c.school_id) ORDER BY l.created_at`)
  })));

  // ---------- learner / family: grades and progress ----------
  app.get("/api/learning/progress", ...read, wrap(async (client, req) => {
    if (req.actor.role === "parent" && !req.query.studentId) {
      const kids = await linkedChildren(client, req.actor);
      return { children: kids.map(k => ({ id: k.id, name: k.display_name, grade: k.grade_level })) };
    }
    const learner = await resolveLearner(client, req.actor, req.query.studentId);
    const courses = await rows(client, `SELECT c.id,c.title,c.subject,c.term,u.display_name AS teacher FROM course_enrollments e JOIN courses c ON c.id=e.course_id
        JOIN users u ON u.id=c.teacher_user_id WHERE e.student_id=$1 AND e.status='active' AND c.status='active' ORDER BY c.title`, [learner.id]);
    for (const c of courses) {
      const g = await courseGradeData(client, c.id, [learner.id]);
      const mine = g.byStudent.get(learner.id);
      c.grade = mine.grade; c.missing = mine.missing;
      c.recent = g.work.map((w, i) => ({ id: w.id, title: w.title, kind: w.kind, points: w.points, ...mine.cells[i] })).filter(x => x.status === "graded").slice(-4).reverse();
      const stds = await courseStandards(client, c.id);
      const m = await learnerStandardMastery(client, learner.id, stds.map(s => s.id));
      c.standards = stds.map(s => ({ id: s.id, code: s.code, description: s.description, mastery: m.get(s.id)?.mastery ?? null, level: m.get(s.id)?.level ?? "not_started" }));
      c.mastery = courseMastery(stds.map(s => s.id), m);
    }
    const finals = await rows(client, `SELECT f.id,f.course_id,c.title AS course,f.percent::float8 AS percent,f.letter,f.posted_at,f.reason,f.supersedes,f.edal_entry_id
        FROM course_final_grades f JOIN courses c ON c.id=f.course_id WHERE f.student_id=$1 ORDER BY f.posted_at DESC`, [learner.id]);
    const creds = await rows(client, `SELECT id,kind,title,description,issued_at,revoked_at,edal_entry_id FROM credentials WHERE student_id=$1 ORDER BY issued_at DESC`, [learner.id]);
    const acc = await one(client, `SELECT extra_time_pct,read_aloud FROM student_accommodations WHERE student_id=$1`, [learner.id]);
    // TC-12: the district preservation fund's totals as a grade-card footnote
    // (district decision 2026-11-24). Aggregate only, never donor names, only
    // once enough people have given; the district can turn it off (db/137).
    const fn = (await one(client, "SELECT eduos_preservation_fund_grade_card_footnote() AS r")).r;
    const fundFootnote = fn?.shown ? { fundName: fn.fundName, givenCents: Number(fn.givenCents), spentCents: Number(fn.spentCents) } : null;
    await audit(client, req, "read", "learning_progress", learner.id);
    return { learner: { id: learner.id, name: learner.display_name, grade: learner.grade_level }, courses, fundFootnote,
      finalGrades: finals.filter(f => !finals.some(n => n.supersedes === f.id)), corrections: finals.filter(f => f.supersedes).length,
      credentials: creds, accommodations: acc ? { extraTimePct: acc.extra_time_pct, readAloud: acc.read_aloud } : null };
  }));
  app.get("/api/learning/mastery/:standardId", ...read, wrap(async (client, req) => {
    if (!validId(req.params.standardId)) throw new HttpError(400, "invalid_standard_id");
    const learner = await resolveLearner(client, req.actor, req.query.studentId);
    const std = await one(client, `SELECT id,framework,code,description,source_url FROM learning_standards WHERE id=$1`, [req.params.standardId]);
    if (!std) throw new HttpError(404, "standard_not_found");
    const e = await masteryExplanation(client, learner.id, std.id);
    await audit(client, req, "read", "standard_mastery", learner.id, std.code);
    return { standard: std, learner: { id: learner.id, name: learner.display_name }, ...e,
      rules: { masteredAt: 80, developingAt: 50, minEvidence: 3, window: 8, decay: 0.8, weights: { quiz: 1, rubric: 1, christie: 0.5 } } };
  }));
}
