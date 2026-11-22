// PowerSchool SIS REST API roster adapter. Read-only: this module issues GETs
// for district schools and each school's students; it never writes to PowerSchool.
// Configure the district's OAuth token URL explicitly (commonly /oauth/access_token/).
import { clientCredentialsToken, getJson, IntegrationError } from "./http.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 50_000;
const MAX_SCHOOLS = 2000;
export const MAX_STUDENT_RECORDS = 200_000;
const text = (v, max) => (typeof v === "string" || typeof v === "number") && String(v).trim()
  ? String(v).trim().slice(0, max) : null;

function rows(body, collection, item) {
  const value = body?.[collection]?.[item] ?? body?.[collection] ?? body?.[item];
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  if (value === undefined || value === null) return [];
  throw new IntegrationError("connector_bad_response", `PowerSchool ${collection}: invalid collection`);
}

export function normalizeSchool(s) {
  const id = text(s?.id ?? s?.dcid, 40);
  if (!id || !/^\d+$/.test(id)) return { rejected: { externalId: id, reason: "invalid_school_id" } };
  return { school: { externalId: id, name: text(s?.name, 160) || text(s?.school_name, 160) || id } };
}

export function normalizeStudent(s, schoolExternalId) {
  const externalId = text(s?.id ?? s?.dcid, 80);
  if (!externalId) return { rejected: { externalId: null, reason: "missing_student_id" } };
  const enrollment = s?.school_enrollment && typeof s.school_enrollment === "object" ? s.school_enrollment : {};
  const enrollmentStatus = [s?.enroll_status, enrollment.enroll_status, enrollment.enroll_status_code, s?.enroll_status_code]
    .find(value => value !== undefined && value !== null && String(value).trim() !== "");
  if (enrollmentStatus === undefined)
    return { rejected: { externalId, reason: "missing_enrollment_status" } };
  const normalizedStatus = String(enrollmentStatus).trim().toLowerCase();
  if (!["0", "a", "active"].includes(normalizedStatus)) return { skipped: true };
  const name = s?.name && typeof s.name === "object" ? s.name : {};
  const first = text(s?.first_name ?? name.first_name, 80);
  const last = text(s?.last_name ?? name.last_name, 80);
  if (!first && !last) return { rejected: { externalId, reason: "missing_name" } };
  const number = text(s?.student_number ?? s?.studentNumber, 80);
  if (!number) return { rejected: { externalId, reason: "missing_student_number" } };
  const grade = text(s?.grade_level ?? s?.gradeLevel ?? enrollment.grade_level ?? enrollment.gradeLevel, 20);
  return { student: {
    externalId, localStudentNumber: number,
    displayName: [first, last].filter(Boolean).join(" ").slice(0, 160),
    gradeLevel: grade, schoolExternalId,
  } };
}

export function studentRosterUrl(baseUrl, schoolId) {
  const query = new URLSearchParams({
    q: "school_enrollment.enroll_status==(A)",
    expansions: "school_enrollment",
  });
  return `${baseUrl.replace(/\/+$/, "")}/ws/v1/school/${encodeURIComponent(schoolId)}/student?${query}`;
}

async function collect(url, token, options, collection, item, maxRecords) {
  if (maxRecords <= 0) throw new IntegrationError("connector_too_many_records", collection);
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const separator = url.includes("?") ? "&" : "?";
    const body = await getJson(`${url}${separator}pagesize=${PAGE_SIZE}&page=${page}`, token, options);
    const batch = rows(body, collection, item);
    out.push(...batch);
    if (out.length > maxRecords) throw new IntegrationError("connector_too_many_records", collection);
    if (batch.length < PAGE_SIZE) return out;
  }
  throw new IntegrationError("connector_too_many_records", collection);
}

export function isMappedSchool(schoolId, mappedSchoolIds) {
  return Array.isArray(mappedSchoolIds) && mappedSchoolIds.includes(String(schoolId));
}

export async function fetchRoster({ baseUrl, tokenUrl, clientId, clientSecret, scope, options, mappedSchoolIds = [], maxStudentRecords = MAX_STUDENT_RECORDS }) {
  const recordLimit = Math.min(Number.isSafeInteger(maxStudentRecords) ? maxStudentRecords : MAX_STUDENT_RECORDS, MAX_STUDENT_RECORDS);
  if (recordLimit < 1) throw new IntegrationError("connector_too_many_records", "students");
  const token = await clientCredentialsToken({ tokenUrl, clientId, clientSecret, scope, options });
  const base = baseUrl.replace(/\/+$/, "");
  const schoolRows = await collect(`${base}/ws/v1/district/school`, token, options, "schools", "school", MAX_SCHOOLS);
  const schools = [], rejected = [], students = [];
  // Count raw downloaded records, including inactive and rejected rows.
  let fetchedStudentRecords = 0;
  for (const raw of schoolRows) {
    const normalized = normalizeSchool(raw);
    if (!normalized.school) { rejected.push(normalized.rejected); continue; }
    schools.push(normalized.school);
    const schoolId = normalized.school.externalId;
    if (!isMappedSchool(schoolId, mappedSchoolIds)) continue;
    const studentRows = await collect(studentRosterUrl(base, schoolId),
      token, options, "students", "student", recordLimit - fetchedStudentRecords);
    fetchedStudentRecords += studentRows.length;
    for (const rawStudent of studentRows) {
      const result = normalizeStudent(rawStudent, schoolId);
      if (result.student) students.push(result.student);
      else if (result.rejected) rejected.push(result.rejected);
    }
  }
  return { schools, students, rejected, fetchedStudentRecords };
}

// ---- SIS-04 class rosters (read-only), per mapped school ----
// GET /ws/v1/school/{id}/section, /ws/v1/school/{id}/staff and
// /ws/v1/section/{id}/section_enrollment. Field names vary between
// PowerSchool versions and plugins; preview against the district's sandbox
// before turning class rosters on (docs/INTEGRATIONS.md).
const MAX_SECTIONS = 20_000;
const staffEmail = s => {
  const e = s?.emails && typeof s.emails === "object" ? s.emails : {};
  const v = s?.email ?? s?.email_addr ?? e.work_email ?? e.email;
  return typeof v === "string" && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(v.trim()) ? v.trim().toLowerCase() : null;
};
export function normalizeClasses({ schoolExternalId, sections = [], staffs = [], enrollmentsBySection = new Map() }, today = new Date().toISOString().slice(0, 10)) {
  const out = { sections: [], staff: [], enrollments: [] };
  for (const s of staffs) {
    const id = text(s?.id ?? s?.dcid, 80);
    if (!id) continue;
    const name = s?.name && typeof s.name === "object" ? s.name : {};
    out.staff.push({ externalId: id, email: staffEmail(s), displayName: [text(s?.first_name ?? name.first_name, 80), text(s?.last_name ?? name.last_name, 80)].filter(Boolean).join(" ") || id });
  }
  for (const s of sections) {
    const id = text(s?.id ?? s?.dcid, 80);
    if (!id) continue;
    out.sections.push({ externalId: id, schoolExternalId, title: [text(s?.course_name ?? s?.course_number, 120), text(s?.section_number, 30)].filter(Boolean).join(" ").slice(0, 160) || id });
    const teacher = text(s?.staff_id ?? s?.teacher_id, 80);
    if (teacher) out.enrollments.push({ sectionExternalId: id, userExternalId: teacher, role: "teacher" });
    for (const e of enrollmentsBySection.get(id) || []) {
      const student = text(e?.student_id, 80);
      const dropped = e?.dropped === true || String(e?.dropped).toLowerCase() === "true";
      const exited = e?.exit_date && String(e.exit_date).slice(0, 10) < today;
      if (student && !dropped && !exited) out.enrollments.push({ sectionExternalId: id, userExternalId: student, role: "student" });
    }
  }
  return out;
}

export async function fetchClasses({ baseUrl, tokenUrl, clientId, clientSecret, scope, options, mappedSchoolIds = [] }) {
  const token = await clientCredentialsToken({ tokenUrl, clientId, clientSecret, scope, options });
  const base = baseUrl.replace(/\/+$/, "");
  const all = { sections: [], staff: [], enrollments: [] };
  let sectionCount = 0;
  for (const schoolId of mappedSchoolIds) {
    if (!/^\d+$/.test(String(schoolId))) continue;
    const school = encodeURIComponent(schoolId);
    const sections = await collect(`${base}/ws/v1/school/${school}/section`, token, options, "sections", "section", MAX_SECTIONS - sectionCount);
    sectionCount += sections.length;
    const staffs = await collect(`${base}/ws/v1/school/${school}/staff`, token, options, "staffs", "staff", MAX_SECTIONS);
    const enrollmentsBySection = new Map();
    for (const s of sections) {
      const id = text(s?.id ?? s?.dcid, 80);
      if (id) enrollmentsBySection.set(id, await collect(`${base}/ws/v1/section/${encodeURIComponent(id)}/section_enrollment`, token, options,
        "section_enrollments", "section_enrollment", MAX_STUDENT_RECORDS));
    }
    const part = normalizeClasses({ schoolExternalId: String(schoolId), sections, staffs, enrollmentsBySection });
    all.sections.push(...part.sections); all.staff.push(...part.staff); all.enrollments.push(...part.enrollments);
  }
  return all;
}
