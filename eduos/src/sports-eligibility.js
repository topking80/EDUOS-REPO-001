// 37.6.0 sports eligibility. PURE: no I/O.
// Inputs come from eduos_sports_eligibility_inputs(), which only the team's
// coach or the school's athletic director may call. Output is rule-level:
// which district rule is not met, never a score, rank or prediction. Nothing
// here is stored; the route computes it on each read and audits the view.
import { courseGrade, effectiveAttempt } from "./gradebook.js";

export const RULES = {
  grades: "Passing every active course",
  attendance: "Attendance in the last window",
  records: "Enough records to decide"
};

function coursePercent(course, now) {
  const items = (course.work || []).map(w => {
    let earned = null, missing = false;
    if (w.kind === "quiz") {
      const eff = effectiveAttempt((w.attempts || []).filter(a => ["scored", "returned"].includes(a.status)), w.retakePolicy || "highest");
      if (eff != null) earned = Math.round(eff * w.points * 100) / 100;
      else if (!(w.attempts || []).length && w.dueAt && new Date(w.dueAt) < now) missing = true;
    } else {
      const s = w.submission;
      if (s?.gradedAt) earned = s.pointsEarned ?? (s.score != null ? Math.round(s.score * w.points) / 100 : null);
      else if (!s && w.dueAt && new Date(w.dueAt) < now) missing = true;
    }
    return { id: w.id, category: w.category, points: w.points, earned, missing };
  });
  return courseGrade(items, course.weights || {}).percent;
}

/** One learner -> {status: eligible|not_eligible|not_enough_records, reasons:[...]} */
export function evaluateStudent(st, policy, now = new Date()) {
  const reasons = [];
  const att = st.attendance || {};
  const records = Number(att.records || 0);
  const coursePcts = (st.courses || []).map(c => ({ title: c.title, percent: coursePercent(c, now) }));
  const graded = coursePcts.filter(c => c.percent != null);
  if (records < Number(policy.minRecords || 5) && !graded.length) {
    return { status: "not_enough_records", reasons: [{ rule: "records", text: "Not enough attendance or grade records yet. Check with the school office." }] };
  }
  const failing = graded.filter(c => c.percent < Number(policy.minCoursePercent));
  if (failing.length) reasons.push({ rule: "grades", text: `Below the district minimum in ${failing.length === 1 ? "1 course" : `${failing.length} courses`}: ${failing.map(c => c.title).join(", ")}` });
  if (records >= Number(policy.minRecords || 5)) {
    const attended = Number(att.present || 0) + Number(att.tardy || 0) + Number(att.excused || 0);
    if ((attended / records) * 100 < Number(policy.minAttendancePercent)) reasons.push({ rule: "attendance", text: `Attendance below the district minimum in the last ${policy.windowDays} days` });
  }
  return { status: reasons.length ? "not_eligible" : "eligible", reasons };
}
export function evaluateTeam(inputs, now = new Date()) {
  const policy = inputs.policy;
  return {
    policy: { minCoursePercent: Number(policy.minCoursePercent), minAttendancePercent: Number(policy.minAttendancePercent), windowDays: policy.windowDays },
    students: (inputs.students || []).map(st => ({ studentId: st.studentId, name: st.name, grade: st.grade, jersey: st.jersey, ...evaluateStudent(st, policy, now) }))
  };
}
