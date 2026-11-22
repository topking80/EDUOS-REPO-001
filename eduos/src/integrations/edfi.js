// Ed-Fi API (v8 and ODS/API v5-7), read-only. Reads schools, students and
// student-school associations with OAuth 2.0 client credentials and turns
// them into EduOS roster records.
//
// Base URL is the data path up to the namespace, e.g.
//   Ed-Fi API v8: https://edfi.district.org/api/data
//   ODS/API v7:   https://edfi.district.org/api/data/v3
// Token URL: v8 serves /connect/token on the Configuration Service and keeps an
// /oauth/token proxy on the API host; ODS/API uses /oauth/token.
import { clientCredentialsToken, getJson, IntegrationError } from "./http.js";

const PAGE = 500; // Ed-Fi's usual maximum page size
const MAX_PAGES = 1000;
const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

const GRADES = { kindergarten: "K", "preschool/prekindergarten": "PK", prekindergarten: "PK", "infant/toddler": "PK", "early education": "PK",
  first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6", seventh: "7", eighth: "8", ninth: "9", tenth: "10", eleventh: "11", twelfth: "12" };
/** "uri://ed-fi.org/GradeLevelDescriptor#Third grade" -> "3". */
export function gradeOf(descriptor) {
  const v = String(descriptor ?? "").split("#").pop().trim().toLowerCase();
  if (!v) return null;
  if (GRADES[v]) return GRADES[v];
  const word = v.replace(/\s+grade$/, "");
  return GRADES[word] || v.slice(0, 20);
}

/** Pick each student's current school: an association with no exit date, latest entry. */
export function currentSchools(associations) {
  const best = new Map();
  for (const a of associations) {
    const sid = a?.studentReference?.studentUniqueId, school = a?.schoolReference?.schoolId;
    if (!sid || school === undefined || school === null || a.exitWithdrawDate) continue;
    const prev = best.get(sid);
    if (!prev || String(a.entryDate || "") > String(prev.entryDate || "")) best.set(sid, a);
  }
  return best;
}

export function normalizeStudent(s, assoc) {
  const externalId = text(s?.studentUniqueId, 80);
  if (!externalId) return { rejected: { externalId: null, reason: "missing_studentUniqueId" } };
  const given = text(s.preferredFirstName, 80) || text(s.firstName, 80), family = text(s.lastSurname, 80);
  if (!given && !family) return { rejected: { externalId, reason: "missing_name" } };
  if (!assoc) return { skipped: true }; // not currently enrolled anywhere
  return { student: { externalId, localStudentNumber: externalId, displayName: [given, family].filter(Boolean).join(" ").slice(0, 160),
    gradeLevel: gradeOf(assoc.entryGradeLevelDescriptor), schoolExternalId: String(assoc.schoolReference.schoolId).slice(0, 255) } };
}

async function collect(base, resource, token, options) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const items = await getJson(`${base}/ed-fi/${resource}?limit=${PAGE}&offset=${page * PAGE}`, token, options);
    if (!Array.isArray(items)) throw new IntegrationError("connector_bad_response", `${resource}: not an array`);
    out.push(...items);
    if (items.length < PAGE) return out;
  }
  throw new IntegrationError("connector_too_many_records", resource);
}

export async function fetchRoster({ baseUrl, tokenUrl, clientId, clientSecret, scope, options }) {
  const token = await clientCredentialsToken({ tokenUrl, clientId, clientSecret, scope, options });
  const base = baseUrl.replace(/\/+$/, "");
  const schoolRows = await collect(base, "schools", token, options);
  const studentRows = await collect(base, "students", token, options);
  const assoc = currentSchools(await collect(base, "studentSchoolAssociations", token, options));
  const schools = schoolRows.filter(s => s?.schoolId !== undefined && s?.schoolId !== null)
    .map(s => ({ externalId: String(s.schoolId), name: text(s.nameOfInstitution, 160) || String(s.schoolId) }));
  const students = [], rejected = [];
  for (const s of studentRows) {
    const r = normalizeStudent(s, assoc.get(s?.studentUniqueId));
    if (r.student) students.push(r.student); else if (r.rejected) rejected.push(r.rejected);
  }
  return { schools, students, rejected };
}

// ---- SIS-04 class rosters (read-only): sections, staffs and their section associations ----
// An Ed-Fi section is identified by school, course code, school year, session and section identifier.
export function sectionKey(r) {
  if (!r) return null;
  const parts = [r.schoolId, r.localCourseCode, r.schoolYear, r.sessionName, r.sectionIdentifier];
  return parts.every(p => p !== undefined && p !== null && String(p).trim() !== "") ? parts.map(p => String(p).trim()).join("|").slice(0, 255) : null;
}
const current = (a, today) => !a?.endDate || String(a.endDate).slice(0, 10) >= today;
const workEmail = s => {
  const list = Array.isArray(s?.electronicMails) ? s.electronicMails : [];
  const pick = list.find(m => /work/i.test(String(m?.electronicMailTypeDescriptor || ""))) || list[0];
  const v = pick?.electronicMailAddress;
  return typeof v === "string" && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(v.trim()) ? v.trim().toLowerCase() : null;
};

export function normalizeClasses({ sections = [], staffs = [], staffSections = [], studentSections = [] }, today = new Date().toISOString().slice(0, 10)) {
  const out = { sections: [], staff: [], enrollments: [] };
  for (const s of sections) {
    const key = sectionKey({ ...s.courseOfferingReference, sectionIdentifier: s.sectionIdentifier });
    if (key) out.sections.push({ externalId: key, schoolExternalId: String(s.courseOfferingReference.schoolId),
      title: text(s.sectionName, 160) || `${s.courseOfferingReference.localCourseCode} ${s.sectionIdentifier}`.slice(0, 160) });
  }
  for (const s of staffs) {
    const id = text(s?.staffUniqueId, 255);
    if (id) out.staff.push({ externalId: id, email: workEmail(s), displayName: [text(s.firstName, 80), text(s.lastSurname, 80)].filter(Boolean).join(" ") || id });
  }
  for (const [list, role, who] of [[staffSections, "teacher", "staffReference.staffUniqueId"], [studentSections, "student", "studentReference.studentUniqueId"]]) {
    for (const a of list) {
      if (!current(a, today)) continue;
      const [obj, field] = who.split(".");
      const user = text(a?.[obj]?.[field], 255), section = sectionKey(a?.sectionReference);
      if (user && section) out.enrollments.push({ sectionExternalId: section, userExternalId: user, role });
    }
  }
  return out;
}

export async function fetchClasses({ baseUrl, tokenUrl, clientId, clientSecret, scope, options }) {
  const token = await clientCredentialsToken({ tokenUrl, clientId, clientSecret, scope, options });
  const base = baseUrl.replace(/\/+$/, "");
  return normalizeClasses({
    sections: await collect(base, "sections", token, options),
    staffs: await collect(base, "staffs", token, options),
    staffSections: await collect(base, "staffSectionAssociations", token, options),
    studentSections: await collect(base, "studentSectionAssociations", token, options),
  });
}
