// PowerSchool SIS REST API roster adapter. Read-only: this module issues GETs
// for district schools and each school's students; it never writes to PowerSchool.
// Configure the district's OAuth token URL explicitly (commonly /oauth/access_token/).
import { clientCredentialsToken, getJson, IntegrationError } from "./http.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 50_000;
const MAX_SCHOOLS = 2000;
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
  if (!id || !/^\\d+$/.test(id)) return { rejected: { externalId: id, reason: "invalid_school_id" } };
  return { school: { externalId: id, name: text(s?.name, 160) || text(s?.school_name, 160) || id } };
}

export function normalizeStudent(s, schoolExternalId) {
  const externalId = text(s?.id ?? s?.dcid, 80);
  if (!externalId) return { rejected: { externalId: null, reason: "missing_student_id" } };
  const enrollment = s?.school_enrollment && typeof s.school_enrollment === "object" ? s.school_enrollment : {};
  const enrollmentStatus = s?.enroll_status ?? enrollment.enroll_status ?? enrollment.enroll_status_code ?? s?.enroll_status_code;
  if (enrollmentStatus === undefined || enrollmentStatus === null || enrollmentStatus === "")
    return { rejected: { externalId, reason: "missing_enrollment_status" } };
  if (!["0", 0, "A", "active"].includes(enrollmentStatus)) return { skipped: true };
  const name = s?.name && typeof s.name === "object" ? s.name : {};
  const first = text(s?.first_name ?? name.first_name, 80);
  const last = text(s?.last_name ?? name.last_name, 80);
  if (!first && !last) return { rejected: { externalId, reason: "missing_name" } };
  const number = text(s?.student_number ?? s?.studentNumber, 80);
  if (!number) return { rejected: { externalId, reason: "missing_student_number" } };
  const grade = text(s?.grade_level ?? s?.gradeLevel, 20);
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
  return `${baseUrl.replace(/\\/+$/, "")}/ws/v1/school/${encodeURIComponent(schoolId)}/student?${query}`;
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

export async function fetchRoster({ baseUrl, tokenUrl, clientId, clientSecret, scope, options, mappedSchoolIds = [], maxStudentRecords = 1_000_000 }) {
  const token = await clientCredentialsToken({ tokenUrl, clientId, clientSecret, scope, options });
  const base = baseUrl.replace(/\\/+$/, "");
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
      token, options, "students", "student", maxStudentRecords - fetchedStudentRecords);
    fetchedStudentRecords += studentRows.length;
    for (const rawStudent of studentRows) {
      const result = normalizeStudent(rawStudent, schoolId);
      if (result.student) students.push(result.student);
      else if (result.rejected) rejected.push(result.rejected);
    }
  }
  return { schools, students, rejected, fetchedStudentRecords };
}
