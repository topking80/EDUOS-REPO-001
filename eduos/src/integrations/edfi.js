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
