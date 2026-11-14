// EduOS 32.6.0 learning core: shared database steps used by the learning,
// Christie and EDAL routes. Everything runs inside the caller's tenant
// transaction, so row-level security decides what each role can touch.
import { randomUUID } from "node:crypto";
import { computeMastery, explainMastery, isNewMilestone, courseMastery } from "./mastery-model.js";
import { courseGrade, effectiveAttempt } from "./gradebook.js";
import { appendEntry } from "./edal.js";
import { rows, one, HttpError, validId } from "./role-app-util.js";

/** The learner a request is about. Pupils: themselves. Parents: a linked child. Staff: a learner in scope. */
export async function resolveLearner(client, actor, studentId) {
  if (actor.role === "pupil") {
    const s = await one(client, `SELECT s.id,s.display_name,s.grade_level,s.school_id FROM student_user_links l JOIN students s ON s.id=l.student_id
        WHERE l.user_id=$1 AND l.status='active' AND l.relationship='pupil' AND ($2::uuid IS NULL OR s.id=$2) ORDER BY s.display_name LIMIT 1`,
      [actor.userId, validId(studentId) ? studentId : null]);
    if (!s) throw new HttpError(403, "no_linked_learner");
    return s;
  }
  if (!validId(studentId)) throw new HttpError(400, "student_id_required");
  if (actor.role === "parent") {
    const s = await one(client, `SELECT s.id,s.display_name,s.grade_level,s.school_id FROM student_user_links l JOIN students s ON s.id=l.student_id
        WHERE l.user_id=$1 AND l.student_id=$2 AND l.status='active' AND l.relationship IN ('parent','guardian')`, [actor.userId, studentId]);
    if (!s) throw new HttpError(403, "not_your_child");
    return s;
  }
  const s = await one(client, `SELECT id,display_name,grade_level,school_id FROM students WHERE id=$1 AND eduos_can_see_learning(school_id,id)`, [studentId]);
  if (!s) throw new HttpError(404, "student_not_found");
  return s;
}

export async function linkedChildren(client, actor) {
  return rows(client, `SELECT s.id,s.display_name,s.grade_level,s.school_id FROM student_user_links l JOIN students s ON s.id=l.student_id
      WHERE l.user_id=$1 AND l.status='active' AND l.relationship IN ('parent','guardian') ORDER BY s.display_name`, [actor.userId]);
}

/** Recompute one learner's mastery of one standard from all their evidence. */
export async function recomputeMastery(client, actor, { schoolId, studentId, standardId }) {
  const ev = await rows(client, `SELECT source,label,score::float8 AS score,weight::float8 AS weight,observed_at FROM mastery_evidence
      WHERE student_id=$1 AND standard_id=$2 ORDER BY observed_at DESC, id`, [studentId, standardId]);
  const before = await one(client, `SELECT mastery,level,mastered_at FROM standard_mastery WHERE student_id=$1 AND standard_id=$2`, [studentId, standardId]);
  const r = computeMastery(ev);
  const saved = await one(client, `INSERT INTO standard_mastery(student_id,standard_id,district_id,school_id,mastery,level,evidence_count,assessed_count,mastered_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $6='mastered' THEN now() END)
      ON CONFLICT(student_id,standard_id) DO UPDATE SET mastery=$5,level=$6,evidence_count=$7,assessed_count=$8,
        mastered_at=CASE WHEN $6='mastered' THEN coalesce(standard_mastery.mastered_at,now()) ELSE standard_mastery.mastered_at END,updated_at=now()
      RETURNING mastered_at`, [studentId, standardId, actor.districtId, schoolId, r.mastery, r.level, r.evidenceCount, r.assessedCount]);
  let milestone = null;
  if (isNewMilestone(before, r)) {
    const std = await one(client, `SELECT code,framework FROM learning_standards WHERE id=$1`, [standardId]);
    milestone = await appendEntry(client, actor, { kind: "mastery_milestone", schoolId, studentId,
      payload: { studentId, standardId, standard: `${std.framework} ${std.code}`, mastery: r.mastery, evidenceCount: r.evidenceCount,
        assessedCount: r.assessedCount, model: "EduOS mastery v1 (32.6.0)", reachedAt: new Date(saved.mastered_at).toISOString() } });
  }
  return { ...r, before: before?.mastery ?? null, milestone };
}

export async function addEvidence(client, actor, { schoolId, studentId, standardId, source, sourceRef = null, label, score, weight }) {
  await client.query(`INSERT INTO mastery_evidence(district_id,school_id,student_id,standard_id,source,source_ref,label,score,weight,recorded_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [actor.districtId, schoolId, studentId, standardId, source, sourceRef, String(label).slice(0, 160),
     Math.max(0, Math.min(1, score)), weight ?? (source === "christie" ? 0.5 : 1), actor.userId]);
  return recomputeMastery(client, actor, { schoolId, studentId, standardId });
}

export async function masteryExplanation(client, studentId, standardId) {
  const ev = await rows(client, `SELECT source,label,score::float8 AS score,weight::float8 AS weight,observed_at FROM mastery_evidence
      WHERE student_id=$1 AND standard_id=$2 ORDER BY observed_at DESC, id`, [studentId, standardId]);
  const r = computeMastery(ev);
  return { ...r, explanation: explainMastery(r) };
}

/** Assignments of a course with each listed learner's points (null = not graded yet). */
export async function courseGradeData(client, courseId, studentIds) {
  const course = await one(client, `SELECT id,title,subject,grade_level,term,school_id,grade_weights,teacher_user_id FROM courses WHERE id=$1`, [courseId]);
  if (!course) throw new HttpError(404, "course_not_found");
  const work = await rows(client, `SELECT id,title,kind,category,points_possible::float8 AS points,due_at,max_attempts,retake_policy,rubric IS NOT NULL AS has_rubric
      FROM assignments WHERE course_id=$1 AND status IN ('published','closed') ORDER BY coalesce(due_at, created_at), title`, [courseId]);
  const ids = work.map(w => w.id);
  const subs = ids.length ? await rows(client, `SELECT assignment_id,student_id,points_earned::float8 AS points_earned,score::float8 AS score,graded_at,feedback,returned_at,submitted_at
      FROM assignment_submissions WHERE assignment_id=ANY($1::uuid[]) AND student_id=ANY($2::uuid[])`, [ids, studentIds]) : [];
  const atts = ids.length ? await rows(client, `SELECT assignment_id,student_id,attempt_no,status,total_points::float8 AS total,possible_points::float8 AS possible
      FROM quiz_attempts WHERE assignment_id=ANY($1::uuid[]) AND student_id=ANY($2::uuid[]) ORDER BY attempt_no`, [ids, studentIds]) : [];
  const now = Date.now();
  const byStudent = new Map();
  for (const sid of studentIds) {
    const cells = work.map(w => {
      let earned = null, status = "not_started";
      if (w.kind === "quiz") {
        const mine = atts.filter(a => a.assignment_id === w.id && a.student_id === sid);
        const eff = effectiveAttempt(mine.filter(a => ["scored", "returned"].includes(a.status)), w.retake_policy);
        if (eff != null) { earned = Math.round(eff * w.points * 100) / 100; status = "graded"; }
        else if (mine.some(a => a.status === "needs_review")) status = "needs_review";
        else if (mine.some(a => a.status === "in_progress")) status = "in_progress";
        return { assignmentId: w.id, earned, status, attempts: mine.length, missing: status === "not_started" && w.due_at && new Date(w.due_at) < now };
      }
      const s = subs.find(x => x.assignment_id === w.id && x.student_id === sid);
      if (s?.graded_at) { earned = s.points_earned ?? (s.score != null ? Math.round(s.score * w.points) / 100 : null); status = "graded"; }
      else if (s) status = "submitted";
      return { assignmentId: w.id, earned, status, feedback: s?.feedback || null, missing: !s && w.due_at && new Date(w.due_at) < now };
    });
    const grade = courseGrade(work.map((w, i) => ({ id: w.id, category: w.category, points: w.points, earned: cells[i].earned })), course.grade_weights);
    byStudent.set(sid, { cells, grade, missing: cells.filter(c => c.missing).length });
  }
  return { course, work, byStudent };
}

export async function courseStandards(client, courseId) {
  return rows(client, `SELECT DISTINCT ls.id,ls.framework,ls.code,ls.description,ls.subject FROM learning_standards ls
      WHERE ls.id IN (SELECT st.standard_id FROM lesson_standards st JOIN lessons l ON l.id=st.lesson_id WHERE l.course_id=$1
                      UNION SELECT a.standard_id FROM assignment_standards a JOIN assignments x ON x.id=a.assignment_id WHERE x.course_id=$1)
      ORDER BY ls.code`, [courseId]);
}
export async function learnerStandardMastery(client, studentId, standardIds) {
  if (!standardIds.length) return new Map();
  return new Map((await rows(client, `SELECT standard_id,mastery,level,evidence_count,assessed_count,mastered_at FROM standard_mastery
      WHERE student_id=$1 AND standard_id=ANY($2::uuid[])`, [studentId, standardIds])).map(r => [r.standard_id, r]));
}
export { courseMastery };

/** Post (or correct) a final course grade and record it on the EDAL ledger. */
export async function postFinalGrade(client, actor, { course, student, percent, letter, reason = null }) {
  const prev = await one(client, `SELECT id,percent::float8 AS percent,letter FROM course_final_grades f WHERE course_id=$1 AND student_id=$2
      AND NOT EXISTS(SELECT 1 FROM course_final_grades n WHERE n.supersedes=f.id) ORDER BY posted_at DESC LIMIT 1`, [course.id, student.id]);
  if (prev && !reason) throw new HttpError(409, "correction_needs_reason", { current: prev });
  const id = randomUUID();
  const entry = await appendEntry(client, actor, { kind: "final_grade", schoolId: course.school_id, studentId: student.id,
    payload: { recordId: id, courseId: course.id, course: course.title, term: course.term, studentId: student.id, percent, letter,
      supersedes: prev?.id || null, reason: reason || null } });
  await client.query(`INSERT INTO course_final_grades(id,district_id,school_id,course_id,student_id,percent,letter,reason,supersedes,posted_by,edal_entry_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, actor.districtId, course.school_id, course.id, student.id, percent, letter, reason, prev?.id || null, actor.userId, entry.id]);
  return { id, percent, letter, supersedes: prev?.id || null, edal: entry };
}
