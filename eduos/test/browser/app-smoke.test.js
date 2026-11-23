// Browser smoke test for the web app at /app/: loads the real index.html and
// app.js in headless Chrome (driven over the DevTools protocol with Node's own
// WebSocket, no extra dependencies) against a small mock API, signed in as each
// role, and checks every tab renders without an uncaught error.
//
// 37.4.0 shipped an app.js that threw while loading (an undefined view), so
// /app/ never got past "Loading EduOS..." for anyone; nothing in CI opened it.
//
// Skips when Chrome isn't installed, unless EDUOS_REQUIRE_BROWSER=1 (set in CI).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CHROME, startChrome, Page } from "./cdp.js";
import { METHODS, PROCESSORS } from "../../src/commerce/catalog.js";

const APP_DIR = new URL("../../public/app/", import.meta.url);
const ui = fs.readFileSync(new URL("app.js", APP_DIR), "utf8");

const required = process.env.EDUOS_REQUIRE_BROWSER === "1";

// CMP-02: axe-core scan of every screen. axe-core is not a project dependency
// (CI installs a pinned copy, as it does playwright-core); EDUOS_AXE_PATH points
// at its axe.min.js. Required in CI (EDUOS_REQUIRE_AXE=1).
const AXE_PATH = process.env.EDUOS_AXE_PATH && fs.existsSync(process.env.EDUOS_AXE_PATH) ? process.env.EDUOS_AXE_PATH : null;
const AXE_SOURCE = AXE_PATH ? fs.readFileSync(AXE_PATH, "utf8") : null;
// WCAG 2.0, 2.1 and 2.2, levels A and AA.
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
// Keyboard focus, for checks axe can't make: every focusable control shows a
// focus indicator (WCAG 2.4.7) and isn't hidden behind the sticky header or the
// fixed tab bar when focused (2.4.11). One real Tab press puts Chrome in
// keyboard mode, so focus() then matches :focus-visible as a Tab would.
async function focusScan(page, label, out) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  const found = await page.eval(`(() => {
    const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
    const els = [...document.querySelectorAll(sel)].filter(e => !e.disabled && !e.closest("[inert], dialog:not([open])") && e.getClientRects().length && getComputedStyle(e).visibility !== "hidden");
    const bad = [];
    const name = e => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + " " + JSON.stringify((e.getAttribute("aria-label") || e.textContent || e.name || "").trim().slice(0, 30));
    for (const e of els.slice(0, 80)) {
      if (e.classList.contains("skip")) continue;
      e.focus();
      if (document.activeElement !== e) continue;
      const cs = getComputedStyle(e);
      const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== "none");
      if (!ring) bad.push({ id: "focus-visible", node: name(e) });
      const r = e.getBoundingClientRect();
      const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + 2], [r.right - 2, r.bottom - 2]]
        .filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
      const seen = pts.some(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit && (hit === e || e.contains(hit) || hit.contains(e) || (e.labels && [...e.labels].some(l => l.contains(hit)))); });
      if (!seen) bad.push({ id: "focus-obscured", node: name(e) + " at y=" + Math.round(r.top) + ".." + Math.round(r.bottom) + " of " + innerHeight });
    }
    document.activeElement?.blur?.();
    scrollTo(0, 0);
    return bad;
  })()`);
  if (!Array.isArray(found)) throw new Error(`focus check did not run on ${label}`);
  const groups = {};
  for (const b of found) (groups[b.id] ||= []).push(b.node);
  for (const [id, nodes] of Object.entries(groups)) out.push({ screen: label, id, impact: "serious",
    help: id === "focus-visible" ? "Focused control has no visible focus indicator (WCAG 2.4.7)" : "Focused control is hidden behind fixed or sticky content (WCAG 2.4.11)", nodes: nodes.slice(0, 4) });
}

async function axeScan(page, label, out) {
  if (!AXE_SOURCE) return;
  if (!(await page.eval("Boolean(window.axe)"))) await page.send("Runtime.evaluate", { expression: AXE_SOURCE });
  const found = await page.eval(`window.axe.run(document, { runOnly: { type: "tag", values: ${JSON.stringify(AXE_TAGS)} }, resultTypes: ["violations"] })
    .then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map(n => n.target.join(" ") + " :: " + (n.html || "").slice(0, 120)) })))`);
  if (!Array.isArray(found)) throw new Error(`axe did not run on ${label}: ${JSON.stringify(found)}`);
  out.scanned = (out.scanned || 0) + 1;
  for (const v of found) out.push({ screen: label, ...v });
}

// Role -> tab ids, read from ROLE_TABS so new tabs are covered automatically.
const roleTabs = (() => {
  const block = ui.slice(ui.indexOf("const ROLE_TABS"), ui.indexOf("};", ui.indexOf("const ROLE_TABS")));
  const out = {};
  for (const m of block.matchAll(/^\s*(\w+):\s*\[(.*)\],?\s*$/gm)) out[m[1]] = [...m[2].matchAll(/\["(\w+)", "/g)].map(x => x[1]);
  return out;
})();

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// LTI-02: when set, the course list holds one course whose assignment has a tool link.
let withCourse = false;
// UI-02: the school theme the app receives; the light pass switches its appearance.
let appearance = "dark";
const BRAND = () => ({ data: { school: { id: "s1", name: "Maple" }, districtName: "Riverside", mascot: null, publicKey: null,
  branding: { primary: "#1f4e79", secondary: "#2f6f73", accent: "#f2b134", font: "system", appAppearance: appearance, mascotUploadId: null,
    tiles: { preset: "bold", base: { shape: "square", bg: "cycle", glyphMode: "color", glyphColor: "auto", labelColor: "auto", badge: false }, overrides: {} } },
  preferences: { theme: "school", reduceMotion: false } } });
let mockSchool = "s1", switches = [], copies = [], draftSaves = [], planSaves = [], commandsSent = [], pairedRoom = false, checkins = [], attendanceSent = [];
function mockApi(role, pathname, failWebhookLoads = false) {
  const now = new Date().toISOString();
  // TEACH-04: today's classes and one plan (any date).
  if (pathname === "/api/class-plans") return { data: [{ course_id: "k1", title: "Math 3", subject: "Math", grade_level: "3", plan_id: "pl1", status: "ready", version: 2, blocks: 4, minutes: 35 },
    { course_id: "k2", title: "Reading 3", subject: "Reading", grade_level: "3", plan_id: null, status: null, version: null, blocks: 0, minutes: 0 }] };
  if (/^\/api\/class-plans\/k1\/\d{4}-\d{2}-\d{2}$/.test(pathname)) return { data: { course: { id: "k1", title: "Math 3", subject: "Math", grade_level: "3" }, date: pathname.slice(-10),
    plan: { id: "pl1", title: "Fractions", status: "ready", version: 2, minutes: 35, updatedBy: "Smoke Test", updatedAt: now, blocks: [
      { kind: "warmup", prompt: "Which is bigger, 1/2 or 3/8?", minutes: 5, note: "SECRET-NOTE" },
      { kind: "lesson", lessonId: "ls1", minutes: 20, note: null, lesson: { id: "ls1", title: "Fraction strips", objective: "Show halves", content: "Fold strips.\nCompare.", status: "published", approved: true } },
      { kind: "timer", label: "Pair work", minutes: 2, note: null },
      { kind: "link", label: "Fraction game", url: "https://example.org/fractions", minutes: 8, note: null }] },
    choices: { lessons: [{ id: "ls1", title: "Fraction strips", unit_seq: 1, seq: 1 }], assignments: [] } } };
  if (withCourse) switch (pathname) {
    case "/api/learning/courses": return { data: { courses: [{ id: "k1", title: "Math 3", subject: "Math", gradeLevel: "3", term: "Fall", teacher: "Teacher S1", teacher_name: "Teacher S1", status: "active", grade: null, mastery: { average: 0, mastered: 0, total: 0 } }] } };
    case "/api/learning/courses/k1": return { data: { id: "k1", title: "Math 3", subject: "Math", gradeLevel: "3", term: "Fall", teacher: "Teacher S1", canManage: role === "teacher",
      standards: [], units: [], assignments: [{ id: "as1", title: "Fractions week", kind: "work", points: 10, due_at: null, status: "published" }],
      ...(role === "teacher" ? { students: [] } : { learner: { id: "st1", name: "Alice" }, grade: null, mastery: { mastered: 0, total: 0 } }) } };
    case "/api/lti/content-links": return { data: [{ id: "cl1", assignmentId: "as1", appId: "app1", appName: "Practice Tool", title: "Fractions practice", description: "", canRemove: role === "teacher", gradesCapable: true, gradesEnabled: true }] };
    case "/api/lti/scores": return { data: [{ id: "sc1", studentName: "Alice A", appName: "Practice Tool", scoreGiven: 8, scoreMaximum: 10, status: "pending", gradebookScore: null }] };
    case "/api/my/apps": return { data: [{ id: "app1", name: "Practice Tool", integrationType: "lti13", deepLinking: true }] };
    case "/api/lti/course-sharing": return { data: { canManage: role === "teacher", shared: [{ appId: "app1", appName: "Practice Tool", enabledBy: "Teacher S1", enabledAt: now }],
      candidates: role === "teacher" ? [{ appId: "app1", appName: "Practice Tool" }] : [] } };
  }
  switch (pathname) {
    case "/api/branding/current": return BRAND();
    // UI-01: the Apps view for leaders.
    case "/api/lti/grade-approvals": return { data: { policy: { enabled: true, teacherReviewRequired: true }, canApprove: role === "principal",
      approvals: [{ id: "g1", appId: "app1", appName: "Practice Tool", schoolId: "s1", schoolName: "Maple", approvedBy: "Pat Principal", approvedAt: now, scores30d: 3 }],
      candidates: role === "principal" ? [{ appId: "app2", appName: "Quiz Maker" }] : [] } };
    case "/api/apps": return { data: [{ id: "app3", name: "New LTI Tool", vendor: "Tool Co", integrationType: "lti13", registrationStatus: "pending" }] };
    case "/api/app-requests": return { data: [{ id: "r1", status: "pending" }] };
    case "/api/my/apps": return { data: [{ id: "a1", name: "Reading Room", category: "Reading", integrationType: "link" }, { id: "a2", name: "MathQuest", category: "Math", integrationType: "lti13" }] };
    case "/api/me": return { userId: "u1", displayName: "Smoke Test", role, districtId: "d1", schoolId: mockSchool, memberships: [] };
    case "/api/session": return { csrfToken: "smoke" };
    case "/api/safety/status": return { data: { incidents: [], canInitiate: false, canLead: false } };
    case "/api/home": if (role === "parent") return { data: { children: [{ id: "c1", display_name: "Alice A", grade_level: "3", school_id: "s1", school_name: "Maple", absences_30d: 0, due_7d: 0, overdue: 0, to_acknowledge: 0 },
      { id: "c2", display_name: "Ben A", grade_level: "7", school_id: "s2", school_name: "Oak Middle", absences_30d: 1, due_7d: 2, overdue: 0, to_acknowledge: 0 }] } };
    // TEACH-01: the district teacher network.
    case "/api/network/colleagues": return { data: { schools: [{ id: "s1", name: "Maple" }, { id: "s2", name: "Oak Middle" }],
      colleagues: [{ user_id: "u7", name: "Teacher Two", roles: ["teacher"], schools: [{ id: "s2", name: "Oak Middle" }] }, { user_id: "u8", name: "Principal P", roles: ["principal"], schools: [{ id: "s1", name: "Maple" }] }] } };
    case "/api/network/groups": return { data: [{ id: "g1", name: "Grade 4 math", description: "Fractions and decimals", members: 6, joined: true, started_at_school: "Oak Middle", started_by: "Teacher Two", last_message_at: now },
      { id: "g2", name: "Science fair", description: null, members: 3, joined: false, started_at_school: "Maple", started_by: "Principal P", last_message_at: now }] };
    // TEACH-02: the shared materials library.
    case "/api/materials": return { data: [{ id: "m1", kind: "lesson", title: "Fraction strips", subject: "Math", grade_level: "4", summary: "Hands-on start", version: 1, status: "shared", updated_at: now, author: "Teacher Two", school: "Oak Middle", mine: false, copies: 3, lessons: 1 },
      { id: "m2", kind: "unit", title: "Fractions", subject: "Math", grade_level: "4", summary: null, version: 2, status: "shared", updated_at: now, author: "Smoke Test", school: "Maple", mine: true, copies: 0, lessons: 2 }] };
    case "/api/materials/m1": return { data: { id: "m1", kind: "lesson", title: "Fraction strips", subject: "Math", grade_level: "4", summary: "Hands-on start", version: 1, status: "shared", author: "Teacher Two", school: "Oak Middle", mine: false, copies: 3,
      body: { title: "Fraction strips", objective: "Show equivalent fractions", content: "Fold strips.\nCompare lengths.", standards: [{ id: "sd1", code: "4.NF.A.1", description: "Equivalent fractions" }], sources: [] } } };
    // TEACH-03: co-written drafts.
    case "/api/drafts": return { data: [{ id: "d1", kind: "lesson", title: "Fraction strips", subject: "Math", grade_level: "4", version: 3, updated_at: now, updated_by: "Teacher Two", with_names: "Teacher Two" }] };
    case "/api/drafts/d1": return { data: { id: "d1", kind: "lesson", title: "Fraction strips", subject: "Math", gradeLevel: "4", version: 3, updatedAt: now, updatedBy: "Teacher Two",
      body: { title: "Fraction strips", objective: "Show halves", content: "Fold strips.", standards: [{ id: "sd1", code: "4.NF.A.1", description: "" }], sources: [] },
      editors: [{ user_id: "u1", name: "Smoke Test", school: "Maple" }, { user_id: "u7", name: "Teacher Two", school: "Oak Middle" }],
      revisions: [{ version: 3, edited_by: "Teacher Two", edited_at: now, merged: true }, { version: 2, edited_by: "Smoke Test", edited_at: now, merged: false }] } };
    // UI-04: a family with children at two schools and an account at each.
    case "/api/family/children": return { data: [{ id: "c1", display_name: "Alice A", grade_level: "3", school_id: "s1", school_name: "Maple", relationship: "parent" },
      { id: "c2", display_name: "Ben A", grade_level: "7", school_id: "s2", school_name: "Oak Middle", relationship: "parent" }] };
    case "/api/memberships": return { data: [{ id: "00000000-0000-4000-8000-0000000a0001", role: "parent", district_id: "d1", district_name: "Riverside", school_id: "s1", school_name: "Maple", current: role === "parent" && mockSchool === "s1" },
      { id: "00000000-0000-4000-8000-0000000a0002", role: "parent", district_id: "d1", district_name: "Riverside", school_id: "s2", school_name: "Oak Middle", current: role === "parent" && mockSchool === "s2" },
      // UI-05: a profile in another district.
      { id: "00000000-0000-4000-8000-0000000a0003", role: "teacher", district_id: "d2", district_name: "Hill County", school_id: "s9", school_name: "Hill Primary", current: false }] };
      return { data: { school_name: "Maple", students: 4, absent_today: 1, open_cases: 0, overdue_follow_ups: 0, pending_invitations: 0, schools: 1, urgent_cases: 0, absences_7d: 1 } };
    case "/api/attendance": return { data: [{ id: "e1", event_date: today(), status: "absent", display_name: "Bob B" }] };
    case "/api/attendance/day": return { data: { date: today(), counts: { present: 3, absent: 1, tardy: 0, excused: 0 }, exceptions: [{ student_id: "s1", status: "absent", display_name: "Bob B" }] } };
    case "/api/school-operations/command-center": return { data: { summary: [], work: [{ id: "w1", domain: "facilities", kind: "repair", status: "open", priority: "high", summary: "Gym door", escalation_level: 0, created_at: now }] } };
    case "/api/staff-management": return { data: { absences: [], shifts: [], coverage: [], staffing: [] } };
    case "/api/transport/today": return { data: { routes: [], riders: [] } };
    case "/api/christie/path": return { data: { learner: { grade: "4" }, skills: [], activeSessionId: null } };
    case "/api/christie/copilot": return { data: { suggestions: [], note: "", bySkill: [] } };
    case "/api/learning/courses": return { data: { courses: [] } };
    case "/api/pickup/family": return { data: { children: [] } };
    case "/api/pickup/queue": return { data: { incident: null, waiting: [], released: [], blocked: 0, denied: 0, earlyDismissals: [] } };
    case "/api/learning/review": return { data: { attempts: [] } };
    case "/api/learning/progress": return { data: { children: [] } };
    case "/api/notifications": return { data: { unread: 0, items: [] } };
    case "/api/ai/status": return { data: { provider: "local", budget: { district: { used: 100, cap: 200000 }, you: { used: 50, cap: 20000 } },
      usecases: [{ id: "lesson_draft", label: "Lesson draft", enabled: true, input: { min: 3, max: 500 } }, { id: "ops_brief", label: "Operations brief", enabled: true, input: null }] } };
    case "/api/edison/trends": return { data: { scope: "school", days: 10, k: 5, withheld: 1, briefEnabled: true, schools: [{ label: "School 1", schoolId: "s1", name: "Maple", today: today(), enrolled: 120,
      attendance: [{ date: today(), total: 120, counts: { present: 100, absent: 12, tardy: 8 }, suppressed: [] }, { date: today(), total: null, counts: {}, suppressed: ["present"] }],
      transport: { date: today(), riders: 40, counts: { boarded: 35, no_checkin: 5 }, suppressed: [] } }] } };
    case "/api/ai/policy": return { data: { canEdit: role === "superintendent", provider: "local", usage30d: [{ usecase: "lesson_draft", calls: 4, tokens: 1800 }],
      policy: { enabled_usecases: ["lesson_draft"], daily_token_cap: 200000, user_daily_token_cap: 20000 },
      usecases: [{ id: "lesson_draft", label: "Lesson draft", roles: ["teacher"] }, { id: "ops_brief", label: "Operations brief", roles: ["principal"] }] } };
    case "/api/edge/updates": return { data: { canApprove: ["superintendent", "it_admin"].includes(role),
      policy: { require_approval: true, min_canaries: 2, soak_hours: 24 }, fleet: [{ version: "45.20261110.3.0", cohort: "canary", devices: 2 }],
      releases: [{ id: "r1", version: "45.20261117.3.0", stage: "canary", approved_at: now, approved_by_name: "Supt",
        gate: { ready: false, blockers: ["1 of 2 canaries healthy on it"], soaked: 0, required: 2, soakHours: 24 } },
        { id: "r0", version: "45.20261110.3.0", stage: "promoted", approved_at: now, promoted_at: now, approved_by_name: "Supt", promoted_by_name: "IT" }] } };
    case "/api/integrations/connectors": return { data: { enabled: true, schools: [{ id: "s1", name: "Maple" }],
      teachers: [{ id: "u7", name: "Teacher S1", email: "t1@d1.test", school: "Maple" }], connectors: [
      { id: "c1", kind: "oneroster", name: "District SIS", baseUrl: "https://sis.example.org/ims/oneroster/rostering/v1p2", status: "active", updatedBy: "IT", approvedBy: "Supt", canApprove: false, lastSyncAt: now, lastSyncStatus: "completed", schoolMap: [],
        dataScope: ["students", "class_rosters"], staffMap: [] },
      { id: "c2", kind: "edfi", name: "State Ed-Fi", baseUrl: "https://edfi.example.org/api/data", status: "pending_approval", updatedBy: "IT", canApprove: true, schoolMap: [] }] } };
    // SIS-04: a preview with class rosters and one unmatched teacher.
    case "/api/integrations/connectors/c1/sync": return { data: { runId: "r1", mode: "preview", rejected: [{ externalId: "u-x", reason: "student_not_imported" }],
      externalSchools: [], counts: { studentsFetched: 3, toImport: 2, notMapped: 0, rejected: 1,
        rosters: { sectionsFetched: 4, sectionsNotMapped: 0, enrollmentsFetched: 20, teachersUnmatched: 1, rosterLinks: 15, toAdd: 12, toRemove: 1, keptManual: 2 } },
      unmatchedTeachers: [{ externalId: "tch-2", reason: "no_matching_eduos_teacher", name: "New Hire", email: "new.hire@d1.test" }] } };
    // 37.7.0 commerce (sandbox) screens.
    // COACH-01: a team the teacher coaches; the coach workspace; its staff list.
    case "/api/activities": return { data: [{ id: "a1", school_id: "s1", kind: "sport", title: "Falcons Soccer", description: "", grade_min: null, grade_max: null, meeting_details: "Mon/Wed 3:30", status: "published", member_count: 2, school_name: "Maple" }] };
    case "/api/sports/my-roles": return { data: { athleticDirector: false, coachOf: role === "teacher" || role === "coach" ? ["a1"] : [] } };
    case "/api/activities/a1/staff": return { data: [{ user_id: "u7", name: "Teacher Two", staff_role: "coach", home_school: "Oak Middle", visiting: true }] };
    case "/api/coach/teams": return { data: { teams: [{ id: "a1", kind: "sport", title: "Falcons Soccer", role: "coach", meetingDetails: "Mon/Wed 3:30", status: "published",
        events: [{ id: "e1", title: "Home game", starts_at: new Date(Date.now() + 864e5).toISOString(), venue: "Field" }], results: [{ title: "Opener", starts_at: now, opponent: "Hawks", home_score: 2, away_score: 1, status: "published" }],
        slip: { id: "sl1", title: "Away trip", granted: 1, declined: 0, pending: 1 },
        roster: [{ studentId: "c1", name: "Alice A", grade: "3", jersey: 9, eligibility: "eligible", slip: "granted" }, { studentId: "c2", name: "Bob B", grade: "3", jersey: null, eligibility: "not_enough_records", slip: "pending" }] }],
      elsewhere: role === "coach" ? [] : [{ membership_id: "00000000-0000-4000-8000-0000000a0009", school_id: "s9", school: "Hill Primary" }] } };
    // COACH-02: a coach's plans and the coaching library.
    case "/api/coaching/plans": return { data: [{ id: "cp1", kind: "practice", title: "Tuesday practice", sport: "Soccer", level: "JV", teamId: "a1", version: 2, minutes: 15, items: 2, adaptedFrom: null, updatedAt: now }] };
    case "/api/coaching/plans/cp1": return { data: { id: "cp1", kind: "practice", title: "Tuesday practice", sport: "Soccer", level: "JV", teamId: "a1", version: 2, minutes: 15, items: 2, adaptedFrom: null, updatedAt: now,
      body: { summary: "Possession day", items: [{ kind: "drill", title: "Rondo 5v2", minutes: 10, description: "Keep-away", equipment: "8 cones" }, { kind: "play", title: "Corner: near post", minutes: 5, description: "", equipment: "" }] } } };
    case "/api/coaching/library": return { data: [{ id: "sm9", kind: "playbook", title: "Set pieces", sport: "Soccer", level: "Var", summary: "Corners and free kicks", version: 1, updated_at: now, author: "Teacher Two", school: "Oak Middle", mine: false, copies: 4,
      body: { summary: null, items: [{ kind: "play", title: "Near-post corner", minutes: null, description: "Runner to the near post", equipment: "" }] } }] };
    // DEV-01: rooms and the classroom device registry.
    case "/api/rooms": return { data: [{ id: "rm1", schoolId: "s1", school: "Maple", name: "Room 101", building: "Main", capacity: 28, devices: [{ id: "dv1", kind: "display", name: "Front board" }] }] };
    case "/api/devices": return { data: [
      { id: "dv2", schoolId: "s1", school: "Maple", kind: "student_device", name: "Cart A", maker: null, model: null, serial: null, capabilities: ["lock", "unlock", "open_link", "focus"], status: "pending", roomId: null, room: null, requestedBy: "Principal S1", requestedAt: now },
      { id: "dv1", schoolId: "s1", school: "Maple", kind: "display", name: "Front board", maker: "Acme", model: "B75", serial: "SN-1", capabilities: ["show", "blank", "volume"], status: "approved", roomId: "rm1", room: "Room 101", requestedBy: "Principal S1", requestedAt: now, decidedBy: "District IT", decidedAt: now, note: "On the list" }] };
    case "/api/devices/dv1/events": return { data: [{ event: "requested", detail: "show,blank,volume", at: now, by: "Principal S1" }, { event: "approved", detail: null, at: now, by: "District IT" }, { event: "placed", detail: "Room 101", at: now, by: "Principal S1" }] };
    // DEV-02: the room timetable and pairing.
    case "/api/my/rooms": return { data: [{ id: "rm1", name: "Room 101", now: true, slots: [{ id: "tt1", roomId: "rm1", teacherId: "u1", teacher: "Smoke Test", weekdays: [1, 2, 3, 4, 5], starts: "08:00", ends: "09:00", label: "Math 3" }],
      devices: [{ id: "dv1", kind: "display", name: "Front board", capabilities: ["show", "blank", "volume"] }, { id: "dv2", kind: "student_device", name: "Cart A", capabilities: ["lock", "unlock", "open_link", "focus"] }],
      pairing: pairedRoom ? { id: "pp1", roomId: "rm1", room: "Room 101", controller: "My phone", pairedAt: now, until: new Date(Date.now() + 36e5).toISOString() } : null }] };
    case "/api/rooms/rm1/commands": return { data: commandsSent.map((c, i) => ({ id: `c${i}`, deviceId: c.deviceId, device: c.deviceId === "dv1" ? "Front board" : "Cart A", capability: c.capability, args: c.args,
      status: i === 0 ? "done" : "delivered", by: "Smoke Test", createdAt: now, finishedAt: null, result: null })).reverse() };
    case "/api/rooms/rm1/timetable": return { data: [{ id: "tt1", roomId: "rm1", teacherId: "u1", teacher: "Teacher S1", weekdays: [1, 2, 3, 4, 5], starts: "08:00", ends: "09:00", label: "Math 3" }] };
    case "/api/rooms/rm1/teachers": return { data: [{ id: "u1", name: "Teacher S1" }, { id: "u2", name: "Teacher Two" }] };
    case "/api/pairings": return { data: [{ id: "pp1", roomId: "rm1", room: "Room 101", teacherId: "u1", teacher: "Teacher S1", controller: "My phone", pairedAt: now, until: new Date(Date.now() + 36e5).toISOString(), via: "Front board" }] };
    // ROOM-01: today's roll for a room.
    case "/api/rooms/rm1/roll": return { data: { id: "rm1", name: "Room 101", kind: "classroom", date: now.slice(0, 10), unscheduled: [], periods: [{ id: "tt1", starts: "08:00", ends: "09:00", class: "Math 3", course: "Math 3", courseId: "k1", teacher: "Smoke Test", now: true,
      roster: [{ studentId: "c1", name: "Alice A", checkedInAt: now, method: "display_qr", attendance: null }, { studentId: "c2", name: "Bob B", checkedInAt: now, method: "door_qr", attendance: null },
        { studentId: "c3", name: "Cara C", checkedInAt: null, method: null, attendance: "absent" }], others: [{ name: "Ms Aide", kind: "staff", at: now, method: "display_qr" }] }] } };
    // STATE-01: the state index and licenses.
    case "/api/states": return { data: { districtState: "TX", categories: {}, states: [["TX", "Texas"], ["OH", "Ohio"]].map(([code, name]) => ({ code, name, counts: { licensing: 0, athletics: 1, agency: 1, records: 0 }, complete: false })) } };
    case "/api/states/TX": return { data: { code: "TX", name: "Texas", sections: [
      { key: "licensing", label: "Educator licensing", entries: [{ id: "se1", category: "licensing", title: "Certificate lookup", url: "https://example.org/lookup", description: "Look up a certificate", source: "https://example.org/", checked: "2026-11-20", from: "district", addedBy: "Supt One" }] },
      { key: "athletics", label: "Athletics", entries: [{ category: "athletics", title: "NFHS", url: "https://nfhs.org/about", source: "https://nfhs.org/about", checked: "2026-11-22", from: "national" }] },
      { key: "agency", label: "Education agency & school data", entries: [] }, { key: "records", label: "Student records rules", entries: [] }] } };
    case "/api/licenses/mine": return { data: [{ id: "l1", stateCode: "TX", state: "Texas", number: "TX-1", type: "Standard Teaching", endorsements: "Math 7-12", issuedOn: "2022-07-01", expiresOn: "2027-01-01", daysLeft: 40, status: "verified", verifiedBy: "Supt One", note: "Checked" }] };
    case "/api/licenses": return { data: [{ id: "l1", userId: "u1", name: "Teacher S1", stateCode: "TX", state: "Texas", number: "TX-1", type: "Standard Teaching", endorsements: null, issuedOn: null, expiresOn: "2027-01-01", daysLeft: 40, status: "self_reported" }] };
    case "/api/events": return { data: [{ id: "e1", activity_id: "a1", school_id: "s1", title: "Friday Night Football", starts_at: new Date(Date.now() + 864e5).toISOString(),
      ends_at: new Date(Date.now() + 9e7).toISOString(), venue: "Main field", status: "published", school_name: "Maple" }] };
    case "/api/commerce/status": return { data: { provider: "sandbox", enabled: true, live: false, sandbox: false, canPay: ["parent", "superintendent"].includes(role),
      canManageProviders: ["superintendent", "it_admin"].includes(role), note: "Test mode: payments go to the processor's test system. No real money moves.", defaultMethod: "paypal",
      methods: [{ method: "paypal", label: "PayPal", processor: "paypal", mode: "test", default: true }, { method: "sandbox", label: "Sandbox (test checkout)", processor: "sandbox", mode: "test", default: false }],
      settings: { enabled: true, networkFeeBps: 300, salesTaxBps: 0, split: { schoolBps: 8500, districtBps: 1000, stateBps: 500 }, stateFundLabel: "State education fund",
        marketplaceFeeBps: 500, holdMinutes: 10, updatedAt: now } } };
    case "/api/commerce/shop": return { data: { events: [{ id: "e1", title: "Friday Night Football", startsAt: now, venue: "Main field", school: "Maple",
      ticketTypes: [{ id: "t1", name: "Adult", priceCents: 1000, currency: "USD", available: 3 }, { id: "t2", name: "Student", priceCents: 0, currency: "USD", available: 0 }] }] } };
    case "/api/commerce/my": return { data: { payments: [{ id: "p1", purpose: "event_tickets", status: "succeeded", amountCents: 2000, currency: "USD", title: "Friday Night Football",
      quantity: 2, createdAt: now, receipts: [{ id: "r1", kind: "payment", number: "R-20261117-ABCDEF0123", amountCents: 2000, issuedAt: now }] }] } };
    case "/api/commerce/report": return { data: { scope: role === "principal" ? "school" : "district",
      totals: { gross: 2000, processing_fee: 88, network_fee: 60, school_share: 1574, district_share: 185, state_share: 93 },
      bySchool: [{ id: "s1", name: "Maple", totals: { gross: 2000, school_share: 1574 } }, { id: "s2", name: "Oak", totals: { gross: 1000, school_share: 787 } }],
      payments: [{ id: "p1", purpose: "event_tickets", status: "succeeded", amountCents: 2000, currency: "USD", payer: "Parent A", title: "Friday Night Football", quantity: 2, createdAt: now, refundable: true }] } };
    case "/api/commerce/marketplace": return { data: { marketplaceFeeBps: 500, licenses: [
      { feeEventId: "f1", approvedAt: now, listingId: "l1", name: "Math Garden", vendor: "MathCo", unitPriceCents: 1250, priceUnit: "seat", seatLimit: 30, purchase: null },
      { feeEventId: "f2", approvedAt: now, listingId: "l2", name: "Read Along", vendor: "ReadCo", unitPriceCents: null, priceUnit: "flat", seatLimit: null, purchase: { id: "m1", status: "paid", total_cents: 5000, quantity: 1 } }] } };
    // 37.8.0 district webhook operations.
    case "/api/commerce/providers/webhook-refund-cases": if (failWebhookLoads) return null; return { data: { refundCases: [{ id: "rf1", processor: "paypal", captureRef: "CAPTURE-123", amountCents: 1250, currency: "USD", reasonCode: "hold_expired", openedAt: now }] } };
    case "/api/commerce/providers/webhook-dead-letters": if (failWebhookLoads) return null; return { data: { deadLetters: [{ id: "dl1", processor: "square", providerEventId: "evt-123", eventType: "payment.updated", attempts: 20, errorCode: "provider_unreachable", receivedAt: now }] } };
    // 37.7.1 district payment setup, built from the real catalog.
    case "/api/commerce/providers": return { data: { liveSwitch: false, secretsKeyConfigured: true, btcpayAllowedHosts: [],
      setup: { enabledMethods: ["paypal", "sandbox"], defaultMethod: "paypal", cardProcessor: "square", updatedAt: now },
      processors: Object.fromEntries(["paypal", "square", "btcpay"].map(p => { const spec = PROCESSORS[p], plain = spec.fields.filter(f => !f.secret), sec = spec.fields.filter(f => f.secret);
        return [p, { processor: p, label: spec.label, description: spec.description, fields: spec.fields, enabled: p === "paypal", mode: "test", status: p === "paypal" ? "test" : "not_set_up",
          config: Object.fromEntries(plain.map(f => [f.key, p === "paypal" && f.key === "clientId" ? "AbcDef1234567890" : null])),
          secretsSet: Object.fromEntries(sec.map(f => [f.key, p === "paypal"])), missing: [], fee: spec.defaultFee,
          lastTest: p === "paypal" ? { at: now, ok: true, detail: "token_ok" } : null, updatedAt: now }]; })),
      methods: Object.values(METHODS).map(m => ({ id: m.id, label: m.label, description: m.description, processors: m.processors, setupProcessor: m.setupProcessor, checkout: !m.methodless,
        signup: m.signup || null, developer: m.developer || null, docs: m.docs || [], notes: m.notes || [], otherLinks: m.otherLinks || [], adapter: m.adapter, comingReason: m.comingReason || null })) } };
    // TC-03 teacher contributions: one item in each state the screens handle.
    case "/api/rosters": return { data: [{ teacher_user_id: "u1", teacher_name: "Smoke Test", student_id: "c1", student_name: "Alice A", school_id: "s1" }], page: { limit: 500, offset: 0, nextOffset: null } };
    case "/api/teacher/history-items": return { data: [
      { id: "h1", studentId: "c1", studentName: "Alice A", entryType: "project", title: "Volcano project", body: "Built a model.", occurredAt: now, status: "draft", updatedAt: now,
        decisions: [{ decision: "submitted", reasonCode: null, note: null, by: "teacher", at: now }, { decision: "changes_requested", reasonCode: "needs_edits", note: "Add the date.", by: "school_lead", at: now }] },
      { id: "h2", studentId: "c1", studentName: "Alice A", entryType: "achievement", title: "Spelling bee", body: "", occurredAt: now, status: "published", updatedAt: now, decisions: [] }] };
    // TC-04 portfolio.
    case "/api/history/portfolio": return { data: { student: { id: "c1", name: "Alice A" }, nextCursor: "next",
      items: [{ id: "p1", entryType: "project", kind: "teacher_artifact", title: "Volcano project", body: "Built a model.", occurredAt: now, schoolYear: "2026-27", source: "teacher", authorName: "Teacher S1" },
        { id: "p2", entryType: "event", kind: "family_memory", title: "Family day", body: "", occurredAt: "2025-09-10T12:00:00Z", schoolYear: "2025-26", source: "guardian", authorName: "Parent A" }],
      facets: { years: ["2026-27", "2025-26"], types: ["event", "project"], kinds: ["family_memory", "teacher_artifact"], total: 2 } } };
    case "/api/history-review": return { data: [{ id: "h3", studentId: "c1", studentName: "Alice A", entryType: "project", title: "Science fair", body: "Second place.", occurredAt: now, status: "submitted", authorName: "Teacher S1", updatedAt: now, decisions: [] }] };
    // Time Capsules: one invitation, one released to me, one draft of mine, one milestone to confirm.
    case "/api/history/capsules": return { data: [
      { id: "cap1", studentId: "c1", studentName: "Alice A", title: "For Alice at 18", status: "draft", releaseKind: "scheduled", releaseAt: "2034-06-01T13:00:00Z", mine: true },
      { id: "cap2", studentId: "c1", studentName: "Alice A", title: "Kindergarten memories", status: "released", releaseKind: "milestone", milestone: "grade_5_completion", mine: false }] };
    case "/api/history/capsule-invitations": return { data: [{ capsuleId: "cap3", studentId: "c1", studentName: "Alice A", from: "Grandma Rose", status: "scheduled",
      releaseKind: "scheduled", releaseAt: "2030-01-01T00:00:00Z", consent: "pending" }] };
    case "/api/history/capsule-milestones": return { data: role === "principal" ? [{ capsuleId: "cap4", studentId: "c1", studentName: "Alice A", from: "Parent A",
      milestone: "graduation", sealedAt: now, accepted: 1 }] : [] };
    case "/api/history/capsules/cap1": return { data: { id: "cap1", studentId: "c1", studentName: "Alice A", title: "For Alice at 18", message: "Open when you're grown.",
      status: "draft", releaseKind: "scheduled", releaseAt: "2034-06-01T13:00:00Z", mine: true,
      items: [{ position: 0, entryId: "e1", withheld: false, entryType: "reflection", kind: "family_memory", title: "The day you were born", body: "So happy.", occurredAt: now }],
      recipients: [{ userId: "u9", name: "Pupil A", type: "student", consent: "pending" }], events: [] } };
    case "/api/history/capsules/cap1/candidates": return { data: [{ id: "e2", title: "First day of school", entryType: "event", kind: "family_memory", occurredAt: now }] };
    case "/api/history/capsule-recipient-options": return { data: [{ userId: "u9", name: "Pupil A", type: "student" }, { userId: "u1", name: "Smoke Test", type: "guardian" }] };
    default:
      if (pathname.startsWith("/api/node/")) return null; // no local node: 404
      if (/^\/api\/family\/children\/[^/]+\/history-items\/pending$/.test(pathname))
        return { data: [{ id: "h4", studentId: "c1", entryType: "project", title: "Volcano project", body: "Built a model.", occurredAt: now, status: "approved", authorName: "Teacher S1", updatedAt: now }] };
      return { data: [] };
  }
}

function startServer() {
  const state = { role: "parent", endpointOps: { issued: 0, revoked: 0, urls: [] } };
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://x");
    if (pathname.startsWith("/api/")) {
      const endpoint = pathname.match(/^\/api\/commerce\/providers\/(paypal|square|btcpay)\/webhook-endpoint(?:\/(rotate))?$/);
      if (endpoint && req.method === "POST" && endpoint[2] === "rotate") {
        const processor = endpoint[1], webhookUrl = `https://hooks.example.test/api/commerce/webhooks/${processor}/smoke-token-${state.endpointOps.issued + 1}`;
        state.endpointOps.issued++;
        state.endpointOps.urls.push(webhookUrl);
        res.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify({ data: { processor, webhookUrl, notice: "Copy this URL now. It will not be shown again." } }));
      }
      if (endpoint && req.method === "DELETE" && !endpoint[2]) {
        state.endpointOps.revoked++;
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify({ data: { processor: endpoint[1], revoked: 1, active: false } }));
      }
      const checkin = /^\/api\/rooms\/([^/]+)\/checkin$/.exec(pathname);
      if (checkin && req.method === "POST") {
        let raw = ""; req.on("data", c => { raw += c; });
        return req.on("end", () => { checkins.push({ room: checkin[1], ...JSON.parse(raw || "{}") });
          res.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ data: { room: "Room 101", kind: "classroom", class: "Math 3", checkedInAt: new Date().toISOString(), already: false, method: "display_qr" } })); });
      }
      if (/^\/api\/rooms\/[^/]+\/door-qr$/.test(pathname) && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify({ data: { room: "Room 101", path: "/app/#/scan?r=x&d=y", qr: ["1110111", "1010101", "1110111", "0000000", "1110111", "1010101", "1110111"], note: "Print it now: it isn't shown again." } }));
      }
      if (pathname === "/api/attendance" && req.method === "POST") {
        let raw = ""; req.on("data", c => { raw += c; });
        return req.on("end", () => { attendanceSent.push(JSON.parse(raw || "{}"));
          res.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ data: { id: "at1" } })); });
      }
      const cmd = /^\/api\/devices\/([^/]+)\/commands$/.exec(pathname);
      if (cmd && req.method === "POST") {
        let raw = ""; req.on("data", c => { raw += c; });
        return req.on("end", () => { commandsSent.push({ deviceId: cmd[1], ...JSON.parse(raw || "{}") });
          res.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ data: { id: "c", status: "queued" } })); });
      }
      if (/^\/api\/class-plans\/k1\//.test(pathname) && req.method === "PUT") {
        let raw = ""; req.on("data", c => { raw += c; });
        return req.on("end", () => { planSaves.push(JSON.parse(raw || "{}"));
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ data: { id: "pl1", version: 3, status: "ready", minutes: 40 } })); });
      }
      // TEACH-03: the first save of the draft conflicts with a colleague's; the next one merges.
      if (pathname === "/api/drafts/d1" && req.method === "PUT") {
        let raw = ""; req.on("data", c => { raw += c; });
        return req.on("end", () => { const b = JSON.parse(raw || "{}"); draftSaves.push(b);
          const theirs = { title: "Fraction strips", objective: "Show halves", content: "Fold strips into quarters.", standards: [], sources: [] };
          res.writeHead(draftSaves.length === 1 ? 409 : 200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(draftSaves.length === 1 ? { error: "edit_conflict", conflicts: ["content"], current: { version: 4, body: theirs, updatedBy: "Teacher Two", updatedAt: new Date().toISOString() } }
            : { data: { version: 5, merged: true, body: b.body, warnings: [] } })); });
      }
      if (/^\/api\/materials\/[^/]+\/copy$/.test(pathname) && req.method === "POST") {
        let raw = ""; req.on("data", c => { raw += c; });
        return req.on("end", () => { copies.push({ path: pathname, body: JSON.parse(raw || "{}") });
          res.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ data: { kind: "unit", id: "u9", lessonIds: ["l8", "l9"] } })); });
      }
      if (pathname === "/api/session/membership" && req.method === "POST") {
        let raw = ""; req.on("data", c => { raw += c; });
        return req.on("end", () => { const id = JSON.parse(raw || "{}").membershipId; switches.push(id); mockSchool = id.endsWith("0002") ? "s2" : "s1";
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ role: state.role, schoolId: mockSchool, csrfToken: "smoke2" })); });
      }
      // GETs, and a connector sync (preview), answer from the sample data; other writes just succeed.
      const body = req.method === "GET" || /^\/api\/integrations\/connectors\/[^/]+\/sync$/.test(pathname) ? mockApi(state.role, pathname, state.failWebhookLoads) : { data: {} };
      res.writeHead(body ? (req.method === "GET" ? 200 : 201) : 404, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(body ?? { error: "not_found" }));
    }
    const rel = pathname.replace(/^\/app\/?/, "") || "index.html";
    const file = new URL(rel, APP_DIR);
    if (!pathname.startsWith("/app/") || !file.href.startsWith(APP_DIR.href) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file.pathname)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  server.unref(); // never keep the test process alive
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })));
}

test("web app boots and every role's tabs render", { skip: !CHROME && !required && "Chrome not installed (set EDUOS_REQUIRE_BROWSER=1 to require it)", timeout: 300000 }, async (t) => {
  assert.ok(CHROME, "EDUOS_REQUIRE_BROWSER=1 but no Chrome found (set CHROME_PATH)");
  assert.ok(Object.keys(roleTabs).length >= 10, "read ROLE_TABS from app.js");
  const { server, state, port } = await startServer();
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const chrome = await startChrome(t);
  // Boot first: a load-time error would otherwise fail every tab the same way.
  {
    const page = await Page.open(chrome.port);
    await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html` });
    const text = (await page.mainText()).trim();
    page.close();
    assert.deepEqual(page.errors, [], "app.js threw while loading, so /app/ never starts");
    assert.doesNotMatch(text, /^Loading/, "/app/ never got past Loading");
  }
  const failures = [], a11y = [];
  assert.ok(AXE_SOURCE || process.env.EDUOS_REQUIRE_AXE !== "1", "EDUOS_REQUIRE_AXE=1 but axe-core was not found (set EDUOS_AXE_PATH)");
  // 37.7.0: commerce screens opened from Clubs & Sports (not tabs of their own);
  // 37.7.1: district payment setup from Ticketing & revenue or Data links.
  const SUBVIEWS = { parent: ["tickets", "portfolio", "capsule"], pupil: ["tickets"], principal: ["commerce"], superintendent: ["commerce", "payments"], it_admin: ["payments"] };
  for (const [role, roleTabList] of Object.entries(roleTabs)) {
    for (const tab of [...roleTabList, ...(SUBVIEWS[role] || [])]) {
      state.role = role;
      const page = await Page.open(chrome.port);
      try {
        await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/${tab}` });
        const text = (await page.mainText()).trim();
        const hash = await page.eval("location.hash");
        const problem = page.errors.length ? `uncaught error: ${page.errors[0].split("\n")[0]}`
          : /^Loading/.test(text) ? "never got past Loading"
          : /Something went wrong/.test(text) ? "the view failed"
          : !text ? "blank"
          : hash !== `#/${tab}` ? `was sent to ${hash}` : null;
        if (problem) failures.push(`${role} #/${tab}: ${problem}`);
        await axeScan(page, `${role} #/${tab}`, a11y);
        if (AXE_SOURCE) await focusScan(page, `${role} #/${tab}`, a11y);
        // Phone width: axe again (target size, WCAG 2.5.8), then reflow at 320 CSS px (WCAG 1.4.10).
        if (AXE_SOURCE) {
          await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
          await axeScan(page, `${role} #/${tab} (390px)`, a11y);
          await focusScan(page, `${role} #/${tab} (390px)`, a11y);
          await page.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
          const overflow = await page.eval(`(() => { const w = document.documentElement.clientWidth;
            const wide = [...document.querySelectorAll("#main *")].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > w + 1 && getComputedStyle(e).position !== "fixed"
              && !e.closest("table, pre, [data-scroll-x]") && ![...document.querySelectorAll("#main *")].some(p => p !== e && p.contains(e) && ["auto","scroll","hidden"].includes(getComputedStyle(p).overflowX)); });
            return document.documentElement.scrollWidth > w + 1 ? wide.slice(0, 3).map(e => e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : "") + " " + Math.round(e.getBoundingClientRect().right) + "px") : []; })()`);
          // Every bottom tab is on screen or can be scrolled to within the bar.
          const lostTabs = await page.eval(`[...document.querySelectorAll("#tabs a")].filter(a => { const r = a.getBoundingClientRect(), nav = a.parentElement;
            return (r.right > innerWidth + 1 || r.left < -1) && !(nav.scrollWidth > nav.clientWidth && ["auto", "scroll"].includes(getComputedStyle(nav).overflowX)); }).map(a => a.textContent)`);
          if (lostTabs?.length) a11y.push({ screen: `${role} #/${tab} (320px)`, id: "tabs-off-screen", impact: "serious", help: "Bottom tabs are off the screen and can't be reached", nodes: lostTabs });
          if (overflow?.length) a11y.push({ screen: `${role} #/${tab} (320px)`, id: "reflow", impact: "serious", help: "Content needs sideways scrolling at 320 CSS px (WCAG 1.4.10)", nodes: overflow });
          await page.send("Emulation.clearDeviceMetricsOverride");
        }
        // Time Capsules: each screen shows its sample items and actions.
        const capsuleExpect = { "parent/capsules": ["Capsules for you", "From Grandma Rose", "Accept", "Opened for you", "Kindergarten memories", "Make a Time Capsule", "Capsules you made", "For Alice at 18", "Manage"],
          "pupil/capsules": ["Capsules for you", "Opened for you"],
          "principal/capsules": ["Milestones to confirm", "Alice A: Graduation", "1 recipient accepted", "Confirm milestone"],
          "parent/capsule": ["Choose a capsule from Time Capsules."] }[`${role}/${tab}`];
        for (const want of capsuleExpect || []) if (!text.includes(want)) failures.push(`${role} #/${tab}: "${want}" is missing`);
        if (["superintendent", "it_admin"].includes(role) && tab === "payments") {
          if (!text.includes("Payment webhook operations") || !text.includes("Late payment captures needing a refund") || !text.includes("Webhook events requiring investigation"))
            failures.push(`${role} #/payments: webhook operations panel is incomplete`);
          if (!text.includes("CAPTURE-123") || !text.includes("evt-123")) failures.push(`${role} #/payments: webhook recovery records did not render`);
        }
        // TC-03: the teacher, reviewer and family screens show their items and actions.
        const expect = { "teacher/contributions": ["Volcano project", "Changes requested · Needs edits", "Save and resubmit", "In the student's history"],
          "principal/history": ["Teacher contributions", "Science fair", "Ask for changes", "Reject"],
          "vice_principal/history": ["Teacher contributions", "Science fair", "Ask for changes"],
          "superintendent/history": ["Teacher contributions", "Science fair"],
          "parent/children": ["From teachers (1 to decide)", "Volcano project", "Keep in history", "Decline", "History & portfolio"],
          "parent/portfolio": ["Alice A's history", "School year 2026-27", "Volcano project", "Search"],
          "pupil/portfolio": ["My history", "School year 2026-27", "School year 2025-26", "Volcano project", "From a teacher", "Family day", "All school years", "Show more"] }[`${role}/${tab}`];
        for (const want of expect || []) if (!text.includes(want)) failures.push(`${role} #/${tab}: "${want}" is missing`);
      } finally {
        page.close();
      }
    }
  }
  // SIS-04: a connector preview shows class roster counts and unmatched teachers to match by hand.
  state.role = "superintendent";
  {
    const page = await Page.open(chrome.port);
    try {
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/integrations` });
      let text = await page.mainText();
      if (!text.includes("students and class rosters")) failures.push("superintendent #/integrations: class rosters status is missing");
      if (!text.includes("Stop class rosters")) failures.push("superintendent #/integrations: class rosters switch is missing");
      await page.eval(`([...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Preview") || {}).click?.()`);
      for (const end = Date.now() + 5000; Date.now() < end && !text.includes("Save teacher matches"); await new Promise(r => setTimeout(r, 50))) text = await page.mainText();
      for (const want of ["Class rosters", "Classes found", "Would be added", "Would be removed", "Already on a roster entered by hand (left as is)",
        "New Hire · new.hire@d1.test · No EduOS teacher at that school has this email", "Teacher S1 (Maple)", "Save teacher matches", "a student in a class isn't in EduOS"])
        if (!text.includes(want)) failures.push(`superintendent integrations preview: "${want}" is missing`);
      await axeScan(page, "superintendent integrations preview", a11y);
      if (page.errors.length) failures.push(`superintendent integrations preview: ${page.errors[0].split("\n")[0]}`);
    } finally { page.close(); }
  }
  // UI-03: on a phone the bar holds at most five one-line items, and every tab it
  // leaves out is on the More screen.
  for (const role of Object.keys(roleTabs)) {
    state.role = role;
    const page = await Page.open(chrome.port);
    try {
      await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/more` });
      await page.mainText();
      const r = await page.eval(`(() => { const all = [...document.querySelectorAll("#tabs a")];
        const shown = all.filter(a => a.getBoundingClientRect().width > 0);
        const listed = [...document.querySelectorAll("#main .morelist a")].map(a => a.getAttribute("href"));
        return { shown: shown.length, tall: shown.filter(a => a.getBoundingClientRect().height > 64).map(a => a.textContent),
          missing: all.filter(a => !shown.includes(a)).map(a => a.getAttribute("href")).filter(h => !listed.includes(h)) }; })()`);
      if (r.shown > 5) failures.push(`${role}: ${r.shown} items in the phone tab bar (at most 5)`);
      if (r.tall.length) failures.push(`${role}: phone tab labels wrap: ${r.tall.join(", ")}`);
      if (r.missing.length) failures.push(`${role}: tabs neither in the phone bar nor on More: ${r.missing.join(", ")}`);
      await axeScan(page, `${role} #/more (390px)`, a11y);
    } finally { page.close(); }
  }
  // UI-02: the light appearance a school can choose, on every role's screens.
  if (AXE_SOURCE) {
    appearance = "light";
    for (const [role, roleTabList] of Object.entries(roleTabs)) for (const tab of roleTabList) {
      state.role = role;
      const page = await Page.open(chrome.port);
      try {
        await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/${tab}` });
        await page.mainText();
        if (await page.eval("document.documentElement.dataset.appearance") !== "light") failures.push(`${role} #/${tab} (light): the school's light appearance wasn't applied`);
        await axeScan(page, `${role} #/${tab} (light)`, a11y);
        await focusScan(page, `${role} #/${tab} (light)`, a11y);
        if (page.errors.length) failures.push(`${role} #/${tab} (light): ${page.errors[0].split("\n")[0]}`);
      } finally { page.close(); }
    }
    appearance = "dark";
  }
  // TEACH-01: Colleagues: the directory, the colleague picker, and groups.
  {
    state.role = "teacher";
    const page = await Page.open(chrome.port);
    try {
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/network` });
      const text = await page.mainText();
      for (const want of ["Colleagues", "Teacher Two", "Teacher · Oak Middle", "Message several colleagues", "no student records"])
        if (!text.includes(want)) failures.push(`teacher #/network: missing "${want}"`);
      await page.eval(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("Message several colleagues")).click()`);
      await new Promise(r => setTimeout(r, 300));
      const picker = await page.eval(`document.querySelector("dialog[open]")?.innerText || ""`);
      if (!/Search colleagues across the district/.test(picker) || !/Principal P/.test(picker)) failures.push(`colleague picker: ${picker.slice(0, 120)}`);
      await axeScan(page, "teacher: colleague picker", a11y);
      await page.eval(`document.querySelector("dialog[open] input[type=search]").value = "oak"; document.querySelector("dialog[open] input[type=search]").dispatchEvent(new Event("input"))`);
      const filtered = await page.eval(`[...document.querySelectorAll("dialog[open] .pick b")].map(b => b.textContent)`);
      if (JSON.stringify(filtered) !== '["Teacher Two"]') failures.push(`picker search by school: ${JSON.stringify(filtered)}`);
      await page.eval(`[...document.querySelectorAll("dialog[open] button")].find(b => b.textContent === "Cancel").click()`);
      await page.eval(`[...document.querySelectorAll(".seg button")].find(b => b.textContent === "Groups").click()`);
      for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 100)); if ((await page.eval(`document.getElementById("main").innerText`)).includes("Grade 4 math")) break; }
      const groups = await page.eval(`document.getElementById("main").innerText`);
      for (const want of ["Grade 4 math", "6 members · started at Oak Middle", "Science fair", "Start a group"]) if (!groups.includes(want)) failures.push(`teacher groups: missing "${want}"`);
      const buttons = await page.eval(`[...document.querySelectorAll("#main li button")].map(b => b.getAttribute("aria-label"))`);
      if (JSON.stringify(buttons) !== '["Open Grade 4 math","Join Science fair"]') failures.push(`group buttons: ${JSON.stringify(buttons)}`);
      await axeScan(page, "teacher #/network groups", a11y);
      if (page.errors.length) failures.push(`teacher network: ${page.errors[0].split("\n")[0]}`);
    } finally { page.close(); state.netView = undefined; }
  }
  // TEACH-02: Materials: browse, preview, copy a unit into my course.
  {
    state.role = "teacher"; withCourse = true; copies = [];
    const page = await Page.open(chrome.port);
    try {
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/network` });
      await page.mainText();
      await page.eval(`[...document.querySelectorAll(".seg button")].find(b => b.textContent === "Materials").click()`);
      for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 100)); if ((await page.eval(`document.getElementById("main").innerText`)).includes("Fraction strips")) break; }
      const text = await page.eval(`document.getElementById("main").innerText`);
      for (const want of ["Fraction strips", "Lesson · Math · Grade 4 · Teacher Two, Oak Middle · copied 3×", "Unit · 2 lessons · Math · Grade 4 · You, Maple", "Stop sharing"])
        if (!text.includes(want)) failures.push(`materials: missing "${want}"`);
      await axeScan(page, "teacher #/network materials", a11y);
      await page.eval(`document.querySelector('[aria-label="Preview Fraction strips"]').click()`);
      for (let i = 0; i < 30 && !(await page.eval(`!!document.querySelector("dialog[open] .preview")`)); i++) await new Promise(r => setTimeout(r, 100));
      const preview = await page.eval(`document.querySelector("dialog[open]")?.innerText || ""`);
      for (const want of ["Fraction strips", "Show equivalent fractions", "4.NF.A.1", "Compare lengths."]) if (!preview.includes(want)) failures.push(`material preview: missing "${want}"`);
      await axeScan(page, "teacher: material preview", a11y);
      await page.eval(`[...document.querySelectorAll("dialog[open] button")].find(b => b.textContent === "Close").click()`);
      await page.eval(`document.querySelector('[aria-label="Copy to my course: Fractions"]').click()`);
      for (let i = 0; i < 30 && !(await page.eval(`!!document.querySelector("dialog[open] #cm-course")`)); i++) await new Promise(r => setTimeout(r, 100));
      await axeScan(page, "teacher: copy material", a11y);
      await page.eval(`[...document.querySelectorAll("dialog[open] button")].find(b => b.textContent === "Copy").click()`);
      for (let i = 0; i < 30 && !copies.length; i++) await new Promise(r => setTimeout(r, 100));
      if (JSON.stringify(copies) !== '[{"path":"/api/materials/m2/copy","body":{"courseId":"k1","unitId":null}}]') failures.push(`copy request: ${JSON.stringify(copies)}`);
      if (page.errors.length) failures.push(`materials: ${page.errors[0].split("\n")[0]}`);
    } finally { page.close(); withCourse = false; }
  }
  // COACH-01: a teacher's "My teams" (and other schools to switch to); a principal manages coaches.
  {
    state.role = "teacher";
    const page = await Page.open(chrome.port);
    const until = async (js, n = 40) => { for (let i = 0; i < n; i++) { if (await page.eval(js)) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
    try {
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/activities` });
      await page.mainText();
      await until(`[...document.querySelectorAll("#main button")].some(b => b.textContent.includes("My teams"))`);
      await page.eval(`[...document.querySelectorAll("#main button")].find(b => b.textContent.includes("My teams")).click()`);
      await until(`document.getElementById("main").innerText.includes("Roster (2)")`);
      const t = await page.eval(`document.getElementById("main").innerText`);
      for (const want of ["My teams", "Falcons Soccer", "you're the coach", "Home game", "Away trip", "1 signed, 1 waiting", "#9 Alice A", "Eligible", "Not enough records", "Slip signed", "Slip waiting", "Opener: vs Hawks 2–1", "Your teams at Hill Primary"])
        if (!t.includes(want)) failures.push(`my teams: missing "${want}"`);
      await axeScan(page, "teacher #/teams", a11y);
      // COACH-02: plans on My teams, the plan editor, and the coaching library.
      if (!(await page.eval(`document.getElementById("main").innerText`)).includes("Practice plan · Soccer · 2 items · 15 min")) failures.push("my teams: plan list missing");
      await page.eval(`document.querySelector('[aria-label="Open plan: Tuesday practice"]').click()`);
      await until(`!!document.getElementById("cp-i1-title")`);
      const ed = await page.eval(`({ t: document.getElementById("cp-title").value, i0: document.getElementById("cp-i0-title").value, eq: document.getElementById("cp-i0-equipment").value, team: document.getElementById("cp-team").value })`);
      if (JSON.stringify(ed) !== '{"t":"Tuesday practice","i0":"Rondo 5v2","eq":"8 cones","team":"a1"}') failures.push(`plan editor: ${JSON.stringify(ed)}`);
      await axeScan(page, "teacher: plan editor", a11y);
      await page.eval(`[...document.querySelectorAll("#main button")].find(b => b.textContent.includes("My teams")).click()`);
      await until(`[...document.querySelectorAll("#main button")].some(b => b.textContent === "Coaching library")`);
      await page.eval(`[...document.querySelectorAll("#main button")].find(b => b.textContent === "Coaching library").click()`);
      await until(`document.getElementById("main").innerText.includes("Set pieces")`);
      const lib = await page.eval(`document.getElementById("main").innerText`);
      for (const want of ["Coaching library", "Set pieces", "Playbook · Soccer · Var · Teacher Two, Oak Middle · copied 4×", "Copy to my plans"]) if (!lib.includes(want)) failures.push(`coaching library: missing "${want}"`);
      await axeScan(page, "teacher: coaching library", a11y);
    } finally { page.close(); }
    state.role = "principal";
    const p2 = await Page.open(chrome.port);
    try {
      await p2.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/activities` });
      await p2.mainText();
      for (let i = 0; i < 40 && !(await p2.eval(`!!document.querySelector('[aria-label="Coaches: Falcons Soccer"]')`)); i++) await new Promise(r => setTimeout(r, 100));
      await p2.eval(`document.querySelector('[aria-label="Coaches: Falcons Soccer"]').click()`);
      for (let i = 0; i < 40 && !(await p2.eval(`(document.querySelector("dialog[open]")?.innerText || "").includes("Teacher Two")`)); i++) await new Promise(r => setTimeout(r, 100));
      const dlg = await p2.eval(`document.querySelector("dialog[open]")?.innerText || ""`);
      for (const want of ["Coaches: Falcons Soccer", "Teacher Two", "Oak Middle · visiting coach", "Add a coach", "another school in the district"]) if (!dlg.includes(want)) failures.push(`coaches dialog: missing "${want}"`);
      await axeScan(p2, "principal: coaches dialog", a11y);
      if (p2.errors.length) failures.push(`coaches: ${p2.errors[0].split("\n")[0]}`);
    } finally { p2.close(); }
  }
  // TEACH-04: today's classes, the plan builder, and present mode (notes never shown).
  {
    state.role = "teacher"; planSaves = [];
    const page = await Page.open(chrome.port);
    const until = async (js, n = 40) => { for (let i = 0; i < n; i++) { if (await page.eval(js)) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
    const main = () => page.eval(`document.getElementById("main").innerText`);
    try {
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/classes` });
      await page.mainText();
      await until(`document.getElementById("main").innerText.includes("Today's classes")`);
      const home = await main();
      for (const want of ["Today's classes", "Ready · 4 steps · 35 min", "Not planned yet"]) if (!home.includes(want)) failures.push(`today card: missing "${want}"`);
      await page.eval(`document.querySelector('[aria-label="Present: Math 3"]').click()`);
      await until(`document.body.classList.contains("presenting") && document.getElementById("main").innerText.includes("Warm-up")`);
      if (!(await main()).includes("Which is bigger, 1/2 or 3/8?")) failures.push("present: warm-up not shown");
      if ((await page.eval(`document.body.innerText`)).includes("SECRET-NOTE")) failures.push("present mode showed a private note");
      if (await page.eval(`getComputedStyle(document.getElementById("tabs")).display !== "none"`)) failures.push("present mode: tab bar still visible");
      await axeScan(page, "teacher: present warm-up", a11y);
      await page.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }))`);
      await until(`document.getElementById("main").innerText.includes("Fraction strips")`);
      await page.eval(`document.querySelector('[aria-label="Next step"]').click()`);
      await until(`!!document.querySelector(".present .clock")`);
      if ((await page.eval(`document.querySelector(".present .clock").textContent`)) !== "2:00") failures.push("timer doesn't start at 2:00");
      await page.eval(`[...document.querySelectorAll(".present button")].find(b => b.textContent === "Start").click()`);
      await new Promise(r => setTimeout(r, 2300));
      const t = await page.eval(`document.querySelector(".present .clock").textContent`);
      if (!/^1:5[6-8]$/.test(t)) failures.push(`timer didn't count down: ${t}`);
      await axeScan(page, "teacher: present timer", a11y);
      await page.eval(`document.querySelector('[aria-label="Next step"]').click()`);
      await until(`!!document.querySelector('.present a[href="https://example.org/fractions"]')`);
      if ((await page.eval(`document.querySelector('.present a').getAttribute("rel")`)) !== "noopener noreferrer") failures.push("present link without noopener");
      await page.eval(`[...document.querySelectorAll(".present button")].find(b => b.textContent === "Exit").click()`);
      await until(`!document.body.classList.contains("presenting") && !!document.getElementById("plan-date")`);
      const plan = await main();
      for (const want of ["Plan: Math 3", "1. Warm-up question", "2. Lesson", "3. Timer", "4. Link", "35 min planned"]) if (!plan.includes(want)) failures.push(`plan builder: missing "${want}"`);
      await axeScan(page, "teacher: plan builder", a11y);
      await page.eval(`document.getElementById("pb-add").value = "text"; [...document.querySelectorAll("button")].find(b => b.textContent === "Add step").click()`);
      await until(`!!document.getElementById("pb-4-b")`);
      await page.eval(`const b = document.getElementById("pb-4-b"); b.value = "Tidy up."; b.dispatchEvent(new Event("input")); const m = document.getElementById("pb-4-m"); m.value = "5"; m.dispatchEvent(new Event("input"));
        [...document.querySelectorAll("button")].find(x => x.textContent === "Save as ready").click()`);
      await until(`document.getElementById("main").innerText.includes("ready to present")`);
      const sent = planSaves[0];
      if (!sent || sent.baseVersion !== 2 || sent.status !== "ready" || sent.blocks.length !== 5 || sent.blocks[4].body !== "Tidy up." || sent.blocks[4].minutes !== 5 || sent.blocks[1].lesson)
        failures.push(`plan save: ${JSON.stringify(sent)?.slice(0, 300)}`);
      if (page.errors.length) failures.push(`plan/present: ${page.errors[0].split("\n")[0]}`);
    } finally { page.close(); }
  }
  // TEACH-03: Co-write: open a draft, a save that clashes keeps my text visible, the next save merges.
  {
    state.role = "teacher"; draftSaves = [];
    const page = await Page.open(chrome.port);
    const until = async (js, n = 40) => { for (let i = 0; i < n; i++) { if (await page.eval(js)) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
    try {
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/network` });
      await page.mainText();
      await page.eval(`[...document.querySelectorAll(".seg button")].find(b => b.textContent === "Co-write").click()`);
      await until(`document.getElementById("main").innerText.includes("Your drafts")`);
      const list = await page.eval(`document.getElementById("main").innerText`);
      for (const want of ["Fraction strips", "Lesson · Math · Grade 4 · with Teacher Two", "Start a draft"]) if (!list.includes(want)) failures.push(`co-write list: missing "${want}"`);
      await axeScan(page, "teacher #/network co-write", a11y);
      await page.eval(`document.querySelector('[aria-label="Open draft: Fraction strips"]').click()`);
      await until(`!!document.getElementById("d-content")`);
      const head = await page.eval(`document.getElementById("main").innerText`);
      for (const want of ["Writing together: Smoke Test (Maple), Teacher Two (Oak Middle)", "Standards: 4.NF.A.1", "version 3", "History (2)"]) if (!head.includes(want)) failures.push(`draft: missing "${want}"`);
      await axeScan(page, "teacher: draft editor", a11y);
      await page.eval(`const c = document.getElementById("d-content"); c.value = "Fold strips in half."; c.dispatchEvent(new Event("input")); document.querySelector('form[aria-label="Edit the draft"] button[type=submit]').click()`);
      await until(`!!document.querySelector("details.yours")`);
      const clash = await page.eval(`({ editor: document.getElementById("d-content").value, mine: document.querySelector("details.yours")?.innerText || "", note: document.querySelector(".notice.warn")?.innerText || "" })`);
      if (clash.editor !== "Fold strips into quarters." || !clash.mine.includes("Fold strips in half.") || !/Teacher Two changed the same part/.test(clash.note)) failures.push(`edit conflict: ${JSON.stringify(clash)}`);
      if (draftSaves[0]?.baseVersion !== 3) failures.push(`first save sent baseVersion ${draftSaves[0]?.baseVersion}`);
      await axeScan(page, "teacher: draft edit conflict", a11y);
      await page.eval(`document.querySelector('form[aria-label="Edit the draft"] button[type=submit]').click()`);
      await until(`document.getElementById("main").innerText.includes("together with a colleague's changes")`);
      if (draftSaves[1]?.baseVersion !== 4) failures.push(`second save sent baseVersion ${draftSaves[1]?.baseVersion} (should build on theirs, 4)`);
      if (!(await page.eval(`document.getElementById("main").innerText.includes("version 5")`))) failures.push("draft didn't move to version 5 after the merged save");
      if (page.errors.length) failures.push(`co-write: ${page.errors[0].split("\n")[0]}`);
    } finally { page.close(); }
  }
  // DEV-01: IT approves devices; a school sees rooms and asks for a device; the dialogs pass axe.
  {
    let page;
    try {
      for (const role of ["it_admin", "principal"]) {
        state.role = role;
        page?.close(); page = await Page.open(chrome.port);
        await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/devices` });
        const text = await page.mainText();
        if (!text.includes("Front board") || !text.includes("Cart A")) failures.push(`${role} #/devices: ${text.slice(0, 160)}`);
        if ((role === "it_admin") !== await page.eval(`[...document.querySelectorAll("main button")].some(b => b.textContent === "Approve")`)) failures.push(`${role} #/devices approve button: ${role === "it_admin" ? "missing" : "shown to a school"}`);
        await axeScan(page, `${role}: #/devices`, a11y);
      }
      const asked = await page.eval(`(() => { const b = [...document.querySelectorAll("main button")].find(b => b.textContent === "Ask for a device"); if (!b) return [...document.querySelectorAll("main button")].map(b => b.textContent).join("|"); b.click(); return "ok"; })()`);
      if (asked !== "ok") failures.push(`no "Ask for a device" button: ${asked}`);
      await new Promise(r => setTimeout(r, 200));
      const caps = await page.eval(`(() => { const d = document.querySelector("dialog[open]"); if (!d) return "no dialog"; d.querySelector("#dv-k").value = "student_device"; d.querySelector("#dv-k").dispatchEvent(new Event("change"));
        return [...d.querySelectorAll("fieldset.caps input")].map(i => i.value).join(","); })()`);
      if (caps !== "lock,unlock,open_link,focus") failures.push(`device dialog student capabilities: ${caps}`);
      await axeScan(page, "principal: ask for a device dialog", a11y);
      await page.eval(`document.querySelector("dialog[open] .btns .btn:not(.primary)").click()`);
      await page.eval(`[...document.querySelectorAll("main button")].find(b => b.textContent === "Rooms").click()`);
      for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 100)); if ((await page.eval(`document.querySelector("main")?.textContent || ""`)).includes("28 seats")) break; }
      await axeScan(page, "principal: rooms", a11y);
      if (page.errors.length) failures.push(`devices: ${page.errors[0].split("\n")[0]}`);
    } finally { page?.close(); }
  }
  // DEV-02: a teacher timetabled now pairs from Classes; the school sets the timetable; leaders see who's paired. Dialogs pass axe.
  {
    let page;
    const waitFor = async js => { for (let i = 0; i < 100; i++) { if (await page.eval(js)) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
    const clickText = (t, scope = "main") => page.eval(`(() => { const b = [...document.querySelectorAll("${scope} button")].find(b => b.textContent === ${JSON.stringify(t)}); if (!b) return false; b.click(); return true; })()`);
    try {
      state.role = "teacher"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/classes` });
      await page.mainText();
      if (!(await waitFor(`(document.querySelector("main")?.textContent || "").includes("Your classroom")`))) failures.push("teacher: no Your classroom card");
      if (!(await clickText("Pair this device"))) failures.push("teacher: no Pair this device button");
      if (!(await waitFor(`!!document.querySelector("dialog[open] #pr-code")`))) failures.push("teacher: no pairing dialog");
      await axeScan(page, "teacher: pair dialog", a11y);
      await page.eval(`document.querySelector("dialog[open] .btns .btn:not(.primary)").click()`);
      if (page.errors.length) failures.push(`teacher pairing: ${page.errors[0].split("\n")[0]}`);
      page.close();

      state.role = "principal"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/devices` });
      await page.mainText();
      await clickText("Rooms");
      await waitFor(`[...document.querySelectorAll("main button")].some(b => b.textContent === "Timetable")`);
      await clickText("Timetable");
      if (!(await waitFor(`!!document.querySelector("dialog[open] #tt-t")`))) failures.push("principal: no timetable dialog");
      const tt = await page.eval(`document.querySelector("dialog[open]")?.textContent || ""`);
      if (!tt.includes("Teacher S1") || !tt.includes("Weekdays · 08:00–09:00")) failures.push(`timetable dialog: ${tt.slice(0, 160)}`);
      await axeScan(page, "principal: timetable dialog", a11y);
      await page.eval(`document.querySelector("dialog[open] .btns .btn:not(.primary)").click()`);
      await clickText("Paired now");
      if (!(await waitFor(`(document.querySelector("main")?.textContent || "").includes("Room 101: Teacher S1")`))) failures.push("principal: paired now list");
      await axeScan(page, "principal: paired now", a11y);
      if (page.errors.length) failures.push(`principal timetable: ${page.errors[0].split("\n")[0]}`);
    } finally { page?.close(); }
  }
  // DEV-03: the paired teacher opens Controls, sends checked commands; no screen viewing anywhere; the screen passes axe.
  {
    pairedRoom = true; commandsSent = [];
    let page;
    const waitFor = async js => { for (let i = 0; i < 100; i++) { if (await page.eval(js)) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
    const clickLabel = l => page.eval(`(() => { const b = document.querySelector('main button[aria-label=${JSON.stringify(l)}]'); if (!b) return false; b.click(); return true; })()`);
    try {
      state.role = "teacher"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/classes` });
      await page.mainText();
      await waitFor(`!!document.querySelector('main button[aria-label="Controls: Room 101"]')`);
      if (!(await clickLabel("Controls: Room 101"))) failures.push("teacher: no Controls button when paired");
      if (!(await waitFor(`!!document.querySelector('main button[aria-label="Blank: Front board"]')`))) failures.push("controls: no Blank button");
      await clickLabel("Blank: Front board");
      await page.eval(`document.querySelector("main input[type=url]").value = "https://example.org/lesson"`);
      await clickLabel("Open link: Cart A");
      await page.eval(`document.querySelector("main input[maxlength='120']").value = "Eyes up front"`);
      await clickLabel("Lock: Cart A");
      await waitFor(`(document.getElementById("room-log")?.textContent || "").includes("Lock")`);
      const sent = JSON.stringify(commandsSent.map(c => [c.deviceId, c.capability, c.args]));
      if (sent !== JSON.stringify([["dv1", "blank", { on: true }], ["dv2", "open_link", { url: "https://example.org/lesson" }], ["dv2", "lock", { message: "Eyes up front" }]])) failures.push(`commands sent: ${sent}`);
      const text = await page.eval(`document.querySelector("main").textContent`);
      if (/view (their|the) screen|screenshot|watch/i.test(text.replace("No one can see their screens", ""))) failures.push("controls offer screen viewing");
      await axeScan(page, "teacher: classroom controls", a11y);
      if (page.errors.length) failures.push(`classroom controls: ${page.errors[0].split("\n")[0]}`);
    } finally { page?.close(); pairedRoom = false; }
  }
  // ROOM-01: a scanned room link checks a student in (and survives the app starting); the teacher's roll confirms attendance; the door QR prints. All pass axe.
  {
    checkins = []; attendanceSent = [];
    let page;
    const waitFor = async js => { for (let i = 0; i < 100; i++) { if (await page.eval(js)) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
    const clickLabel = l => page.eval(`(() => { const b = document.querySelector('main button[aria-label=${JSON.stringify(l)}], dialog[open] button[aria-label=${JSON.stringify(l)}]'); if (!b) return false; b.click(); return true; })()`);
    try {
      state.role = "pupil"; page = await Page.open(chrome.port);
      const code = "Abcdefghijklmnopqrstuv";
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/scan?r=00000000-0000-4000-8000-00000000a001&c=${code}` });
      await page.mainText();
      if (!(await waitFor(`(document.querySelector("main")?.textContent || "").includes("Checked in to Room 101")`))) failures.push(`pupil scan: ${(await page.eval(`document.querySelector("main")?.textContent || ""`)).slice(0, 160)}`);
      if (JSON.stringify(checkins) !== JSON.stringify([{ room: "00000000-0000-4000-8000-00000000a001", code }])) failures.push(`scan sent: ${JSON.stringify(checkins)}`);
      if ((await page.eval("location.hash")) !== "#/scan") failures.push("the code stays in the address bar");
      await axeScan(page, "pupil: checked in", a11y);
      if (page.errors.length) failures.push(`pupil scan: ${page.errors[0].split("\n")[0]}`);
      page.close();

      state.role = "teacher"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/classes` });
      await page.mainText();
      await waitFor(`!!document.querySelector('main button[aria-label="Roll: Room 101"]')`);
      if (!(await clickLabel("Roll: Room 101"))) failures.push("teacher: no Roll button");
      if (!(await waitFor(`(document.querySelector("main")?.textContent || "").includes("2 of 3 checked in")`))) failures.push("teacher roll: counts");
      await axeScan(page, "teacher: room roll", a11y);
      await page.eval(`[...document.querySelectorAll("main button")].find(b => b.textContent.startsWith("Mark the 2 checked in present")).click()`);
      for (let i = 0; i < 50 && attendanceSent.length < 2; i++) await new Promise(r => setTimeout(r, 100));
      const att = JSON.stringify(attendanceSent.map(a => [a.studentId, a.status]));
      if (att !== JSON.stringify([["c1", "present"], ["c2", "present"]])) failures.push(`roll confirmed: ${att}`);
      if (page.errors.length) failures.push(`teacher roll: ${page.errors[0].split("\n")[0]}`);
      page.close();

      state.role = "principal"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/devices` });
      await page.mainText();
      await page.eval(`[...document.querySelectorAll("main button")].find(b => b.textContent === "Rooms").click()`);
      await waitFor(`!!document.querySelector('main button[aria-label="Door QR: Room 101"]')`);
      await clickLabel("Door QR: Room 101");
      if (!(await waitFor(`!!document.querySelector("dialog[open] .print-qr svg")`))) failures.push("principal: no door QR");
      await axeScan(page, "principal: door QR", a11y);
      if (page.errors.length) failures.push(`door QR: ${page.errors[0].split("\n")[0]}`);
    } finally { page?.close(); }
  }
  // STATE-01: Account shows my licenses; the state index and staff licenses open and pass axe.
  {
    state.role = "superintendent";
    const page = await Page.open(chrome.port);
    try {
      for (const [hash, want] of [["me", "My licenses"], ["states", "State index"], ["licenses", "Staff licenses"]]) {
        await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/${hash}` });
        const text = await page.mainText();
        if (!text.includes(want)) failures.push(`state index #/${hash}: ${text.slice(0, 120)}`);
        await axeScan(page, `superintendent: #/${hash}`, a11y);
      }
      await page.eval(`[...document.querySelectorAll("main button")].find(b => b.textContent.includes("Expiring")).click()`);
      const waitFor = async js => { for (let i = 0; i < 100; i++) { if (await page.eval(js)) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
      await waitFor(`[...document.querySelectorAll("main button[aria-pressed=true]")].some(b => b.textContent.includes("Expiring"))`);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/states` });
      await page.mainText();
      await waitFor(`!!document.querySelector("main button.linkrow")`);
      await page.eval(`document.querySelector("main button.linkrow").click()`);
      for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 100)); if ((await page.eval(`document.querySelector("main")?.textContent || ""`)).includes("Certificate lookup")) break; }
      const info = await page.eval(`document.querySelector("main")?.textContent || ""`);
      if (!info.includes("Certificate lookup") || !info.includes("Added by Supt One")) failures.push(`state info: ${info.slice(0, 160)}`);
      await axeScan(page, "superintendent: state info", a11y);
      if (page.errors.length) failures.push(`state index: ${page.errors[0].split("\n")[0]}`);
    } finally { page.close(); }
  }
  // UI-05: any profile can be chosen from the header; the dialog passes axe.
  {
    state.role = "parent"; mockSchool = "s1"; switches = [];
    const page = await Page.open(chrome.port);
    try {
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/messages` });
      await page.mainText();
      const opened = await page.eval(`(() => { const b = document.querySelector(".top button.school.switch"); if (!b) return "no header switch"; b.click();
        const d = document.querySelector("dialog[open]"); if (!d) return "no dialog";
        return [...d.querySelectorAll(".profile")].map(p => (p.getAttribute("aria-current") ? "*" : "") + p.textContent.trim()).join(" | "); })()`);
      const want = "*Family · Maple · RiversideCurrent | Family · Oak Middle · Riverside | Teacher · Hill Primary · Hill County";
      if (opened !== want) failures.push(`profile switcher: ${opened}`);
      await axeScan(page, "parent: switch profile dialog", a11y);
      await page.eval(`[...document.querySelectorAll("dialog[open] button.profile")].find(b => b.textContent.includes("Oak Middle")).click()`);
      for (let i = 0; i < 30 && !switches.length; i++) await new Promise(r => setTimeout(r, 100));
      if (JSON.stringify(switches) !== '["00000000-0000-4000-8000-0000000a0002"]') failures.push(`profile switch sent ${JSON.stringify(switches)}`);
      for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 100)); if ((await page.eval(`document.querySelector(".top .school")?.textContent || ""`)).length) break; }
      if (page.errors.length) failures.push(`profile switcher: ${page.errors[0].split("\n")[0]}`);
    } finally { page.close(); mockSchool = "s1"; switches = []; }
  }
  // UI-04: a family picks a child; a child at another school moves the app there.
  {
    state.role = "parent"; mockSchool = "s1"; switches = [];
    const page = await Page.open(chrome.port);
    try {
      await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/children` });
      await page.mainText();
      const chips = await page.eval(`[...document.querySelectorAll(".familybar .famchip")].map(b => b.textContent + "|" + b.getAttribute("aria-pressed"))`);
      if (JSON.stringify(chips) !== JSON.stringify(["Everyone2 schools|true", "AliceMaple|false", "BenOak Middle|false"])) failures.push(`family bar chips: ${JSON.stringify(chips)}`);
      await axeScan(page, "parent #/children (family bar)", a11y);
      await page.eval(`[...document.querySelectorAll(".famchip")].find(b => b.textContent.startsWith("Ben")).click()`);
      let cards = [];
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 100));
        cards = await page.eval(`[...document.querySelectorAll("#main section.card[aria-label$=' A']")].map(c => c.getAttribute("aria-label"))`);
        if (switches.length && JSON.stringify(cards) === '["Ben A"]') break;
      }
      if (switches.length !== 1 || mockSchool !== "s2") failures.push(`choosing Ben didn't switch to his school (switches: ${JSON.stringify(switches)})`);
      if (JSON.stringify(cards) !== '["Ben A"]') failures.push(`after choosing Ben the children screen shows ${JSON.stringify(cards)}`);
      const pressed = await page.eval(`document.querySelector('.famchip[aria-pressed="true"]')?.textContent`);
      if (!/^Ben/.test(pressed || "")) failures.push(`Ben's chip isn't marked as chosen (${pressed})`);
      // Everyone: both children again, and no further school switch.
      await page.eval(`[...document.querySelectorAll(".famchip")].find(b => b.textContent.startsWith("Everyone")).click()`);
      for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 100)); cards = await page.eval(`[...document.querySelectorAll("#main section.card[aria-label$=' A']")].map(c => c.getAttribute("aria-label"))`); if (cards.length === 2) break; }
      if (cards.length !== 2 || switches.length !== 1) failures.push(`Everyone: ${JSON.stringify(cards)}, switches ${switches.length}`);
      if (page.errors.length) failures.push(`family bar: ${page.errors[0].split("\n")[0]}`);
    } finally { page.close(); mockSchool = "s1"; }
  }
  // LTI-02: tool links on a course assignment, for a pupil (open) and a teacher (open, remove, add).
  withCourse = true;
  for (const [role, wants] of [["pupil", ["Fractions practice · Practice Tool", "Open", "Class list sharing", "These tools can read this course's class list"]],
    ["teacher", ["Fractions practice · Practice Tool", "Remove", "Add from Practice Tool", "Share the class list with Practice Tool", "Send grades to EduOS (Fractions practice)", "Review scores from tools"]]]) {
    state.role = role;
    const page = await Page.open(chrome.port);
    try {
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/courses` });
      await page.mainText();
      await page.eval(`([...document.querySelectorAll("button")].find(b => /Open course|^Open$/.test(b.textContent.trim()) && /Math 3/.test(b.closest("li,section")?.textContent || "")) || {}).click?.()`);
      let text = "";
      for (const end = Date.now() + 5000; Date.now() < end && !text.includes("Fractions practice"); await new Promise(r => setTimeout(r, 50))) text = await page.mainText();
      for (const want of wants) if (!text.includes(want)) failures.push(`${role} course tool links: "${want}" is missing`);
      await axeScan(page, `${role} course with tool links`, a11y);
      if (page.errors.length) failures.push(`${role} course tool links: ${page.errors[0].split("\n")[0]}`);
    } finally { page.close(); }
  }
  withCourse = false;
  // Time Capsules: open a draft from the list; its management controls render.
  state.role = "parent";
  {
    const page = await Page.open(chrome.port);
    try {
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/capsules` });
      await page.mainText();
      await page.eval(`([...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Manage") || {}).click?.()`);
      let text = "";
      for (const end = Date.now() + 5000; Date.now() < end && !text.includes("Who receives it"); await new Promise(r => setTimeout(r, 50))) text = await page.mainText();
      for (const want of ["For Alice at 18", "The day you were born", "Add a memory", "First day of school", "Who receives it", "Pupil A (student): Hasn't answered", "Seal", "Cancel capsule"])
        if (!text.includes(want)) failures.push(`parent capsule detail: "${want}" is missing`);
      await axeScan(page, "parent capsule detail", a11y);
      if (page.errors.length) failures.push(`parent capsule detail: ${page.errors[0].split("\n")[0]}`);
    } finally { page.close(); }
  }
  // Failed queue requests must be visibly different from genuinely empty queues.
  state.role = "superintendent";
  state.failWebhookLoads = true;
  {
    const page = await Page.open(chrome.port);
    try {
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/payments` });
      const text = await page.mainText();
      if (!text.includes("Refund cases couldn't be loaded") || !text.includes("Dead-letter events couldn't be loaded"))
        failures.push("superintendent #/payments: webhook API failures were presented as empty queues");
      await axeScan(page, "superintendent #/payments (load failures)", a11y);
      if (page.errors.length) failures.push(`superintendent #/payments failure state: ${page.errors[0].split("\n")[0]}`);
    } finally { page.close(); }
  }
  // Exercise the real provider endpoint controls: issue, rotate (replacing the
  // one-time bearer URL), then revoke (clearing the secret from the view).
  state.failWebhookLoads = false;
  state.endpointOps = { issued: 0, revoked: 0, urls: [] };
  {
    const page = await Page.open(chrome.port);
    try {
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/payments` });
      await page.mainText();
      const clickButton = label => page.eval(`([...document.querySelectorAll("button")].find(b => b.textContent.trim() === ${JSON.stringify(label)}) || {}).click?.()`);
      const clickDialogButton = label => page.eval(`([...document.querySelectorAll("dialog button")].find(b => b.textContent.trim() === ${JSON.stringify(label)}) || {}).click?.()`);
      const waitFor = async expression => {
        const end = Date.now() + 5000;
        while (Date.now() < end) {
          if (await page.eval(expression)) return true;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return false;
      };

      await clickButton("Issue / rotate URL");
      await waitFor('document.querySelector("dialog[open]")');
      await axeScan(page, "superintendent #/payments (issue URL dialog)", a11y);
      await clickDialogButton("Issue URL");
      if (!await waitFor('document.querySelector(\'[aria-label="PayPal one-time webhook URL"]\')?.value'))
        failures.push("superintendent #/payments: issuing a webhook URL did not reveal the one-time URL");
      const firstUrl = await page.eval('document.querySelector(\'[aria-label="PayPal one-time webhook URL"]\')?.value');
      await clickButton("Issue / rotate URL");
      await clickDialogButton("Issue URL");
      if (!await waitFor(`document.querySelector('[aria-label="PayPal one-time webhook URL"]')?.value !== ${JSON.stringify(firstUrl)}`))
        failures.push("superintendent #/payments: rotating a webhook URL did not replace the prior URL");
      const secondUrl = await page.eval('document.querySelector(\'[aria-label="PayPal one-time webhook URL"]\')?.value');
      await clickButton("Revoke URL");
      await clickDialogButton("Revoke");
      if (!await waitFor('!document.querySelector(\'[aria-label="PayPal one-time webhook URL"]\')'))
        failures.push("superintendent #/payments: revoking a webhook URL did not clear the revealed secret");
      if (firstUrl === secondUrl || !firstUrl?.includes("smoke-token-1") || !secondUrl?.includes("smoke-token-2"))
        failures.push("superintendent #/payments: issue/rotate returned unexpected one-time URL values");
      if (state.endpointOps.issued !== 2 || state.endpointOps.revoked !== 1)
        failures.push(`superintendent #/payments: expected 2 issue/rotate calls and 1 revoke call, got ${JSON.stringify(state.endpointOps)}`);
      if (page.errors.length) failures.push(`superintendent #/payments endpoint controls: ${page.errors[0].split("\\n")[0]}`);
    } finally { page.close(); }
  }
  if (AXE_SOURCE) assert.ok(a11y.scanned >= 40, `axe scanned only ${a11y.scanned} screens`);
  if (process.env.EDUOS_A11Y_REPORT) fs.writeFileSync(process.env.EDUOS_A11Y_REPORT, JSON.stringify(a11y, null, 2));
  assert.deepEqual(failures, []);
  assert.deepEqual(a11y.map(v => `${v.screen}: ${v.id} (${v.impact}) ${v.help} :: ${v.nodes.join(" | ")}`), [], "accessibility violations (WCAG 2.2 A/AA, axe-core)");
});
