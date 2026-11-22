// CANVAS-API-02: read-only Canvas courses and enrollments, for teacher rosters.
//
// Canvas is not the student system of record: no student is created or changed
// from Canvas. A Canvas student is matched to an existing EduOS student only by
// their Canvas SIS user ID equal to the EduOS student number; a Canvas teacher
// to the one EduOS teacher at that school with the same email (their Canvas
// login ID), or the teacher a district lead matched by hand. Canvas
// sub-accounts are mapped to EduOS schools by the district (school map).
//
// Only GET requests, with the district's OAuth token (canvas-oauth.js). The
// developer key's scopes must include (url:GET|...):
//   /api/v1/accounts
//   /api/v1/accounts/:account_id/sub_accounts
//   /api/v1/accounts/:account_id/courses
//   /api/v1/courses/:course_id/enrollments
import { request, IntegrationError } from "./http.js";

export const REQUIRED_SCOPES = [
  "url:GET|/api/v1/accounts",
  "url:GET|/api/v1/accounts/:account_id/sub_accounts",
  "url:GET|/api/v1/accounts/:account_id/courses",
  "url:GET|/api/v1/courses/:course_id/enrollments"
];
export const LIMITS = Object.freeze({ pagesPerList: 200, accounts: 500, courses: 5000, enrollments: 250_000 });
const ID = /^\d{1,20}$/;
const text = (v, n) => typeof v === "string" ? v.trim().slice(0, n) : "";
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/** Canvas puts the next page in the Link header; follow it only on the same origin and API path. */
export function nextLink(header, origin) {
  if (typeof header !== "string") return null;
  for (const part of header.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (!m) continue;
    let u; try { u = new URL(m[1]); } catch { return null; }
    return u.origin === origin && u.pathname.startsWith("/api/v1/") && !u.username && !u.password ? u.toString() : null;
  }
  return null;
}

async function getList(url, { origin, token, options, label, cap }) {
  const out = [];
  let next = url, pages = 0;
  while (next) {
    if (++pages > LIMITS.pagesPerList) throw new IntegrationError("canvas_too_many_pages", label);
    let r = await request(next, { headers: { authorization: `Bearer ${token}`, accept: "application/json+canvas-string-ids" }, options });
    // Canvas throttles with 403 "Rate Limit Exceeded" (or 429). Wait briefly once, then give up.
    const limited = r.status === 429 || (r.status === 403 && /rate limit/i.test(r.text));
    if (limited) {
      const wait = Math.min(5, Math.max(1, Number(r.headers?.["retry-after"]) || 2));
      await new Promise(resolve => setTimeout(resolve, wait * 1000));
      r = await request(next, { headers: { authorization: `Bearer ${token}`, accept: "application/json+canvas-string-ids" }, options });
      if (r.status === 429 || (r.status === 403 && /rate limit/i.test(r.text))) throw new IntegrationError("canvas_rate_limited", label);
    }
    if (r.status === 401) throw new IntegrationError("canvas_authorization_required", label);
    if (r.status === 403) throw new IntegrationError("canvas_scope_or_permission_missing", label);
    if (r.status === 404) throw new IntegrationError("canvas_not_found", label);
    if (r.status < 200 || r.status > 299) throw new IntegrationError("connector_http_error", `${label}: HTTP ${r.status}`);
    let page;
    try { page = JSON.parse(r.text); } catch { throw new IntegrationError("connector_bad_response", `${label}: not JSON`); }
    if (!Array.isArray(page)) throw new IntegrationError("connector_bad_response", `${label}: not a list`);
    out.push(...page);
    if (out.length > cap) throw new IntegrationError("canvas_too_many_records", label);
    next = nextLink(r.headers?.link, origin);
  }
  return out;
}

/** Accounts the authorizing administrator can see, with their sub-accounts, for the school map. */
export async function listAccounts({ baseUrl, accessToken, options }) {
  const origin = new URL(baseUrl).origin, ctx = { origin, token: accessToken, options, cap: LIMITS.accounts };
  const roots = await getList(`${origin}/api/v1/accounts?per_page=100`, { ...ctx, label: "accounts" });
  const all = new Map();
  for (const a of roots) {
    const id = String(a?.id ?? "");
    if (!ID.test(id)) continue;
    all.set(id, text(a.name, 160) || id);
    const subs = await getList(`${origin}/api/v1/accounts/${id}/sub_accounts?recursive=true&per_page=100`, { ...ctx, label: "sub_accounts" });
    for (const s of subs) { const sid = String(s?.id ?? ""); if (ID.test(sid) && !all.has(sid)) all.set(sid, text(s.name, 160) || sid); }
    if (all.size > LIMITS.accounts) throw new IntegrationError("canvas_too_many_records", "accounts");
  }
  return [...all].map(([externalId, name]) => ({ externalId, name }));
}

/**
 * Pure: turn Canvas courses (per mapped account) and their enrollments into the
 * SIS-04 roster shapes. Students without a SIS user ID can't be matched.
 */
export function normalizeCanvas(coursesByAccount, enrollmentsByCourse) {
  const sections = [], seenCourse = new Set();
  for (const [accountId, courses] of coursesByAccount) for (const c of courses) {
    const id = String(c?.id ?? "");
    if (!ID.test(id) || seenCourse.has(id) || (c.workflow_state && c.workflow_state !== "available")) continue;
    seenCourse.add(id);
    sections.push({ externalId: id, title: text(c.name, 160) || id, schoolExternalId: accountId });
  }
  const staff = new Map(), students = new Map(), rejected = new Map(), enrollments = [];
  for (const [courseId, list] of enrollmentsByCourse) {
    if (!seenCourse.has(courseId)) continue;
    for (const e of list) {
      if (e?.enrollment_state && e.enrollment_state !== "active") continue;
      const role = e?.type === "TeacherEnrollment" ? "teacher" : e?.type === "StudentEnrollment" ? "student" : null;
      const userId = String(e?.user_id ?? e?.user?.id ?? "");
      if (!role || !ID.test(userId)) continue;
      if (role === "teacher") {
        const login = text(e.user?.login_id, 254).toLowerCase(), mail = text(e.user?.email, 254).toLowerCase();
        if (!staff.has(userId)) staff.set(userId, { externalId: userId, email: EMAIL.test(mail) ? mail : EMAIL.test(login) ? login : null, displayName: text(e.user?.name, 160) || userId });
      } else {
        const sis = text(e.user?.sis_user_id, 64);
        if (!sis) { rejected.set(userId, "no_sis_user_id"); continue; }
        students.set(userId, { externalId: userId, localStudentNumber: sis });
      }
      enrollments.push({ sectionExternalId: courseId, userExternalId: userId, role });
    }
  }
  return {
    roster: { schools: [], students: [...students.values()], rejected: [...rejected].map(([externalId, reason]) => ({ externalId, reason })) },
    classes: { staff: [...staff.values()], sections, enrollments }
  };
}

/** Courses in each mapped sub-account (and below it), and their active teacher and student enrollments. */
export async function fetchCanvasClasses({ baseUrl, accessToken, mappedAccountIds, options }) {
  const origin = new URL(baseUrl).origin, ctx = { origin, token: accessToken, options };
  const coursesByAccount = new Map(), enrollmentsByCourse = new Map();
  let courseCount = 0, enrollmentCount = 0;
  for (const accountId of mappedAccountIds) {
    if (!ID.test(accountId)) continue; // only numeric Canvas account IDs are mapped
    const courses = await getList(`${origin}/api/v1/accounts/${accountId}/courses?state[]=available&per_page=100`,
      { ...ctx, label: "courses", cap: LIMITS.courses });
    coursesByAccount.set(accountId, courses);
    courseCount += courses.length;
    if (courseCount > LIMITS.courses) throw new IntegrationError("canvas_too_many_records", "courses");
  }
  const seen = new Set();
  for (const courses of coursesByAccount.values()) for (const c of courses) {
    const id = String(c?.id ?? "");
    if (!ID.test(id) || seen.has(id) || (c.workflow_state && c.workflow_state !== "available")) continue;
    seen.add(id);
    const list = await getList(`${origin}/api/v1/courses/${id}/enrollments?type[]=StudentEnrollment&type[]=TeacherEnrollment&state[]=active&per_page=100`,
      { ...ctx, label: "enrollments", cap: LIMITS.enrollments });
    enrollmentCount += list.length;
    if (enrollmentCount > LIMITS.enrollments) throw new IntegrationError("canvas_too_many_records", "enrollments");
    enrollmentsByCourse.set(id, list);
  }
  return normalizeCanvas(coursesByAccount, enrollmentsByCourse);
}

/** Canvas connectors don't import students; the shared roster sync path guards on this. */
export async function fetchRoster() {
  throw new IntegrationError("canvas_is_not_a_student_source", "Canvas connectors sync class rosters only");
}
