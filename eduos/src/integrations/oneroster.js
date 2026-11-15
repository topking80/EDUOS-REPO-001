// OneRoster 1.2 Rostering (REST/JSON binding), read-only. Reads schools
// (/schools) and students (/students) with OAuth 2.0 client credentials and
// turns them into EduOS roster records. Works with 1.1-style users (orgs[])
// as well as 1.2 users (roles[]).
import { clientCredentialsToken, getJson, IntegrationError } from "./http.js";

export const DEFAULT_SCOPE = "https://purl.imsglobal.org/spec/or/v1p2/scope/roster-core.readonly";
const PAGE = 500;
const MAX_PAGES = 400; // 200,000 records per collection

export const gradeOf = (g) => {
  const v = String(g ?? "").trim();
  if (!v) return null;
  const n = /^0*(\d{1,2})$/.exec(v);
  return n ? String(Number(n[1])) : v.slice(0, 20);
};
const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** A OneRoster user -> {externalId, localStudentNumber, displayName, gradeLevel, schoolExternalId} or {rejected}. */
export function normalizeStudent(u) {
  const externalId = text(u?.sourcedId, 255);
  if (!externalId) return { rejected: { externalId: null, reason: "missing_sourcedId" } };
  if (u.status && u.status !== "active") return { skipped: true };
  const given = text(u.preferredFirstName, 80) || text(u.givenName, 80), family = text(u.familyName, 80);
  if (!given && !family) return { rejected: { externalId, reason: "missing_name" } };
  const roles = Array.isArray(u.roles) ? u.roles.filter(r => r?.role === "student" && r.org?.sourcedId) : [];
  const org = (roles.find(r => r.roleType === "primary") || roles[0])?.org?.sourcedId
    || (Array.isArray(u.orgs) ? u.orgs.find(o => o?.sourcedId)?.sourcedId : null);
  if (!org) return { rejected: { externalId, reason: "no_school" } };
  return { student: { externalId, localStudentNumber: text(u.identifier, 80) || externalId.slice(0, 80),
    displayName: [given, family].filter(Boolean).join(" ").slice(0, 160), gradeLevel: gradeOf(Array.isArray(u.grades) ? u.grades[0] : null),
    schoolExternalId: String(org).slice(0, 255) } };
}

async function collect(base, path, key, token, options) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const body = await getJson(`${base}${path}${sep}limit=${PAGE}&offset=${page * PAGE}`, token, options);
    const items = body?.[key];
    if (!Array.isArray(items)) throw new IntegrationError("connector_bad_response", `${path}: no ${key}[]`);
    out.push(...items);
    if (items.length < PAGE) return out;
  }
  throw new IntegrationError("connector_too_many_records", path);
}

export async function fetchRoster({ baseUrl, tokenUrl, clientId, clientSecret, scope, options }) {
  const token = await clientCredentialsToken({ tokenUrl, clientId, clientSecret, scope: scope || DEFAULT_SCOPE, options });
  const base = baseUrl.replace(/\/+$/, "");
  const orgs = await collect(base, "/schools", "orgs", token, options);
  const users = await collect(base, "/students", "users", token, options);
  const schools = orgs.filter(o => o?.sourcedId && (!o.status || o.status === "active"))
    .map(o => ({ externalId: String(o.sourcedId).slice(0, 255), name: text(o.name, 160) || String(o.sourcedId) }));
  const students = [], rejected = [];
  for (const u of users) { const r = normalizeStudent(u); if (r.student) students.push(r.student); else if (r.rejected) rejected.push(r.rejected); }
  return { schools, students, rejected };
}
