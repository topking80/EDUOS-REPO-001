// Turns a fetched roster into an import plan and applies it through the shared
// SIS import (src/sis-import.js). Pure planning is separate from the database
// so it can be unit-tested.
import { applySisBatch } from "../sis-import.js";

const MAX_REJECTED = 200;

/**
 * roster: {schools, students, rejected} from a connector.
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
    // A student already at another EduOS school isn't moved by a sync; a
    // transfer is done in EduOS so nobody loses access by accident.
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
    schoolsFetched: roster.schools.length, studentsFetched: roster.students.length + roster.rejected.length,
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
