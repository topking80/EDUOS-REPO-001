// Turns a fetched roster into an import plan and applies it through the shared
// SIS import (src/sis-import.js). Pure planning is separate from the database
// so it can be unit-tested.
import { applySisBatch } from "../sis-import.js";

const MAX_REJECTED = 200;

/**
 * roster: {schools, students, rejected, fetchedStudentRecords?} from a connector.
 * map: Map(externalSchoolId -> EduOS schoolId).
 * existing: Map(localStudentNumber -> EduOS schoolId) for numbers already in the district.
 * eduosSchools: [{id, name}] (for suggesting a mapping by exact name).
 */
export function planImport(roster, map, existing, eduosSchools) {
  const rejected = [...roster.rejected];
  const bySchool = new Map(), seen = new Set(), unmapped = new Map();
  for (const s of roster.students) {
    if (seen.has(s.localStudentNumber)) { rejected.push({ externalId: s.externalId, reason: "duplicate_student_number" }); continue; }
    seen.add(s.localStudentNumber);
    const schoolId = map.get(s.schoolExternalId);
    if (!schoolId) { unmapped.set(s.schoolExternalId, (unmapped.get(s.schoolExternalId) || 0) + 1); continue; }
    const current = existing.get(s.localStudentNumber);
    if (current && current !== schoolId) { rejected.push({ externalId: s.externalId, reason: "enrolled_at_another_eduos_school" }); continue; }
    if (!bySchool.has(schoolId)) bySchool.set(schoolId, []);
    bySchool.get(schoolId).push({ localStudentNumber: s.localStudentNumber, displayName: s.displayName, gradeLevel: s.gradeLevel });
  }
  const names = new Map(roster.schools.map(x => [x.externalId, x.name]));
  const byName = new Map(eduosSchools.map(x => [x.name.trim().toLowerCase(), x.id]));
  const externalSchools = roster.schools.map(x => ({ externalId: x.externalId, name: x.name, schoolId: map.get(x.externalId) || null,
    suggestedSchoolId: map.get(x.externalId) ? null : byName.get(x.name.trim().toLowerCase()) || null, unmappedStudents: unmapped.get(x.externalId) || 0 }));
  for (const [externalId, n] of unmapped) if (!names.has(externalId)) externalSchools.push({ externalId, name: externalId, schoolId: null, suggestedSchoolId: null, unmappedStudents: n });
  const counts = {
    schoolsFetched: roster.schools.length,
    studentsFetched: Number.isSafeInteger(roster.fetchedStudentRecords) ? roster.fetchedStudentRecords : roster.students.length + roster.rejected.length,
    toImport: [...bySchool.values()].reduce((n, l) => n + l.length, 0),
    perSchool: Object.fromEntries([...bySchool].map(([id, l]) => [id, l.length])),
    notMapped: [...unmapped.values()].reduce((n, x) => n + x, 0), rejected: rejected.length,
  };
  return { bySchool, counts, rejected: rejected.slice(0, MAX_REJECTED), externalSchools };
}

export async function loadPlanInputs(client, districtId, connectorId, numbers) {
  const map = new Map((await client.query("SELECT external_id, school_id FROM integration_school_map WHERE connector_id=$1 AND district_id=$2", [connectorId, districtId]))
    .rows.map(r => [r.external_id, r.school_id]));
  const existing = new Map((await client.query("SELECT local_student_number, school_id FROM students WHERE district_id=$1 AND local_student_number = ANY($2::text[])", [districtId, numbers]))
    .rows.map(r => [r.local_student_number, r.school_id]));
  const schools = (await client.query("SELECT id, name FROM schools WHERE district_id=$1 AND status='active'", [districtId])).rows;
  return { map, existing, schools };
}

/** Applies the plan in the caller's transaction: one SIS batch per school. */
export async function applyPlan(client, actor, connector, runId, plan, requestId) {
  const results = {};
  for (const [schoolId, students] of plan.bySchool) {
    const r = await applySisBatch(client, actor, { schoolId, sourceSystem: `${connector.kind}:${connector.id}`, sourceBatchId: `${runId}:${schoolId}`, students, attendance: [] }, requestId);
    if (r.status !== 201) throw Object.assign(new Error(r.error), { code: "SYNC_SCHOOL_FAILED", detail: `${r.error} (${schoolId})` });
    results[schoolId] = r.data.studentsUpserted;
  }
  return results;
}

// ---- SIS-04 class rosters ----
const MAX_UNMATCHED = 200;

/**
 * classes: {staff, sections, enrollments} from a connector's fetchClasses().
 * roster: the same run's student roster (externalId -> localStudentNumber).
 * inputs (loadRosterInputs): map (external school -> EduOS school), students
 * (number -> {id, schoolId}), teachersByEmail (email -> [{userId, schoolId}]),
 * teachersAtSchool (Set "user|school"), staffMap (external -> userId),
 * synced ([{teacherUserId, studentId, schoolId}] this connector created),
 * manual (Set "teacher|student" entered by hand).
 */
export function planRosters(classes, roster, inputs) {
  const numberOf = new Map(roster.students.map(s => [s.externalId, s.localStudentNumber]));
  const section = new Map();
  let sectionsNotMapped = 0;
  for (const s of classes.sections) {
    const schoolId = inputs.map.get(s.schoolExternalId);
    if (schoolId) section.set(s.externalId, { schoolId, teachers: [], students: [] }); else sectionsNotMapped++;
  }
  for (const e of classes.enrollments) {
    const s = section.get(e.sectionExternalId);
    if (s) (e.role === "teacher" ? s.teachers : s.students).push(e.userExternalId);
  }
  const staff = new Map(classes.staff.map(t => [t.externalId, t]));
  const unmatched = new Map(), rejectedStudents = new Map();
  // An SIS teacher becomes the one active EduOS teacher at that school with the
  // same email, or the teacher a lead matched them to by hand.
  const teacherFor = (externalId, schoolId) => {
    const manual = inputs.staffMap.get(externalId);
    if (manual) return inputs.teachersAtSchool.has(`${manual}|${schoolId}`) ? manual : (unmatched.set(externalId, "matched_teacher_not_at_school"), null);
    const t = staff.get(externalId);
    if (!t?.email) return (unmatched.set(externalId, t ? "no_email" : "not_in_staff_list"), null);
    const candidates = (inputs.teachersByEmail.get(t.email) || []).filter(c => c.schoolId === schoolId);
    if (candidates.length === 1) return candidates[0].userId;
    unmatched.set(externalId, candidates.length ? "ambiguous_email" : "no_matching_eduos_teacher");
    return null;
  };
  const desired = new Map();
  for (const s of section.values()) {
    const teachers = [...new Set(s.teachers)].map(t => teacherFor(t, s.schoolId)).filter(Boolean);
    for (const ext of new Set(s.students)) {
      const number = numberOf.get(ext), student = number && inputs.students.get(number);
      if (!student) { rejectedStudents.set(ext, "student_not_imported"); continue; }
      if (student.schoolId !== s.schoolId) { rejectedStudents.set(ext, "student_at_another_eduos_school"); continue; }
      for (const t of teachers) desired.set(`${t}|${student.id}`, { teacherUserId: t, studentId: student.id, schoolId: s.schoolId });
    }
  }
  const mappedSchools = new Set(inputs.map.values());
  const managed = inputs.synced.filter(r => mappedSchools.has(r.schoolId));
  const syncedKeys = new Set(managed.map(r => `${r.teacherUserId}|${r.studentId}`));
  const add = [...desired].filter(([k]) => !syncedKeys.has(k) && !inputs.manual.has(k)).map(([, v]) => v);
  const keep = [...desired].filter(([k]) => syncedKeys.has(k)).map(([, v]) => v);
  const remove = managed.filter(r => !desired.has(`${r.teacherUserId}|${r.studentId}`));
  const unmatchedTeachers = [...unmatched].slice(0, MAX_UNMATCHED).map(([externalId, reason]) => {
    const t = staff.get(externalId);
    return { externalId, reason, name: t?.displayName ?? null, email: t?.email ?? null };
  });
  return {
    add, keep, remove, unmatchedTeachers,
    rejected: [...rejectedStudents].slice(0, MAX_UNMATCHED).map(([externalId, reason]) => ({ externalId, reason })),
    counts: { sectionsFetched: classes.sections.length, sectionsNotMapped, enrollmentsFetched: classes.enrollments.length,
      teachersUnmatched: unmatched.size, rosterLinks: desired.size, toAdd: add.length, toRemove: remove.length,
      keptManual: [...desired.keys()].filter(k => inputs.manual.has(k) && !syncedKeys.has(k)).length },
  };
}

export async function loadRosterInputs(client, districtId, connectorId, classes, roster) {
  const map = new Map((await client.query("SELECT external_id, school_id FROM integration_school_map WHERE connector_id=$1 AND district_id=$2", [connectorId, districtId]))
    .rows.map(r => [r.external_id, r.school_id]));
  const numbers = roster.students.map(s => s.localStudentNumber);
  const students = new Map((await client.query("SELECT id, local_student_number, school_id FROM students WHERE district_id=$1 AND local_student_number = ANY($2::text[])", [districtId, numbers]))
    .rows.map(r => [r.local_student_number, { id: r.id, schoolId: r.school_id }]));
  const teachers = (await client.query(`SELECT lower(u.email) AS email, m.user_id, m.school_id FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.district_id=$1 AND m.role='teacher' AND m.status='active' AND m.school_id IS NOT NULL`, [districtId])).rows;
  const teachersByEmail = new Map();
  for (const t of teachers) teachersByEmail.set(t.email, [...(teachersByEmail.get(t.email) || []), { userId: t.user_id, schoolId: t.school_id }]);
  const staffMap = new Map((await client.query("SELECT external_id, user_id FROM integration_staff_map WHERE connector_id=$1 AND district_id=$2", [connectorId, districtId]))
    .rows.map(r => [r.external_id, r.user_id]));
  const rosterRows = (await client.query("SELECT teacher_user_id, student_id, school_id, source_connector_id FROM teacher_student_rosters WHERE district_id=$1", [districtId])).rows;
  return {
    map, students, teachersByEmail, staffMap,
    teachersAtSchool: new Set(teachers.map(t => `${t.user_id}|${t.school_id}`)),
    synced: rosterRows.filter(r => r.source_connector_id === connectorId).map(r => ({ teacherUserId: r.teacher_user_id, studentId: r.student_id, schoolId: r.school_id })),
    manual: new Set(rosterRows.filter(r => r.source_connector_id !== connectorId).map(r => `${r.teacher_user_id}|${r.student_id}`)),
  };
}

/** Applies a roster plan in the caller's transaction. Only this connector's rows change. */
export async function applyRosters(client, districtId, connectorId, plan) {
  if (!plan.counts.rosterLinks && plan.remove.length)
    throw Object.assign(new Error("roster_sync_would_remove_all"), { code: "SYNC_ROSTER_EMPTY",
      detail: `the SIS returned no class enrollments for mapped schools; ${plan.remove.length} synced roster links kept` });
  const col = (list, k) => list.map(r => r[k]);
  if (plan.add.length) await client.query(`INSERT INTO teacher_student_rosters(district_id, school_id, teacher_user_id, student_id, source_connector_id, synced_at)
      SELECT $1, s, t, st, $2, now() FROM unnest($3::uuid[], $4::uuid[], $5::uuid[]) AS x(s, t, st)
      ON CONFLICT (district_id, teacher_user_id, student_id) DO NOTHING`,
    [districtId, connectorId, col(plan.add, "schoolId"), col(plan.add, "teacherUserId"), col(plan.add, "studentId")]);
  if (plan.keep.length) await client.query(`UPDATE teacher_student_rosters r SET synced_at=now()
      FROM unnest($3::uuid[], $4::uuid[]) AS x(t, st)
     WHERE r.district_id=$1 AND r.source_connector_id=$2 AND r.teacher_user_id=x.t AND r.student_id=x.st`,
    [districtId, connectorId, col(plan.keep, "teacherUserId"), col(plan.keep, "studentId")]);
  if (plan.remove.length) await client.query(`DELETE FROM teacher_student_rosters r USING unnest($3::uuid[], $4::uuid[]) AS x(t, st)
     WHERE r.district_id=$1 AND r.source_connector_id=$2 AND r.teacher_user_id=x.t AND r.student_id=x.st`,
    [districtId, connectorId, col(plan.remove, "teacherUserId"), col(plan.remove, "studentId")]);
  return { added: plan.add.length, kept: plan.keep.length, removed: plan.remove.length };
}
