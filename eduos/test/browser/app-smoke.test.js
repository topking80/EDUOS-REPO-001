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
  // A vice principal sees the principal screens (db/121); those run under
  // "principal" already, so here: their own queue and two principal screens.
  out.vice_principal = [...out.vice_principal, "overview", "history"];
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
let mockSchool = "s1", switches = [], copies = [], draftSaves = [], planSaves = [], commandsSent = [], pairedRoom = false, checkins = [], attendanceSent = [], remoteJoins = [], adultStudent = false, liveLockdown = false, roomReports = [], sosCaps = false;
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
    case "/api/me": if (role === "private_school") return { userId: "u1", displayName: "Smoke Test", role: "private_school_member", membershipRole: "private_school_member", districtId: null, schoolId: null,
        tenantKind: "private_school", privateSchoolId: "ps1", privateSchoolRole: "school_admin", privateSchoolStatus: "active" };
      return role === "homeschool" ? { userId: "u1", displayName: "Smoke Test", role: "family_member", membershipRole: "family_member", districtId: null, schoolId: null,
        tenantKind: "homeschool_family", familyId: "f1", familyRole: "owner" }
      : { userId: "u1", displayName: "Smoke Test", role: role === "vice_principal" ? "principal" : role, membershipRole: role, districtId: "d1", schoolId: mockSchool, memberships: [] };
    // HSP-03: an independent private school (school administrator).
    case "/api/private-school/me": return { data: { school: { id: "ps1", legalName: "Hillside Academy, Inc.", displayName: "Hillside Academy", status: "active", timeZone: "America/Chicago",
      websiteDomain: "hillside.example", domainVerified: true, branding: {} }, role: "school_admin", campus: null, displayName: "Smoke Test", learnersYouCanSee: 1, campuses: 1 } };
    case "/api/private-school/learners": return { data: [{ id: "pl1", campusId: "pc1", displayName: "Ava Lin", gradeLevel: "4", localNumber: "H-001", enrollmentStatus: "enrolled" }] };
    case "/api/private-school/campuses": return { data: [{ id: "pc1", name: "Main Campus", city: "Austin", status: "active" }] };
    case "/api/private-school/members": return { data: { members: [{ id: "pm1", role: "school_admin", name: "Smoke Test", you: true }, { id: "pm2", role: "registrar", name: "Rita Registrar", you: false }], invitations: [] } };
    case "/api/private-school/calendar": return { data: [{ id: "pe1", title: "First day of term", kind: "term_start", audience: "everyone", startsAt: now, endsAt: now }] };
    // HSP-04: admissions, classes, report cards and the week.
    case "/api/private-school/admissions": return { data: [{ id: "pa1", campusId: "pc1", kind: "new", applicantName: "Cy Park", gradeLevel: "4", schoolYear: "2027-2028", status: "under_review",
      waitlistPosition: null, documents: [{ label: "Birth certificate", received: true }, { label: "Records", received: false }], next: ["offered", "waitlisted", "not_offered", "withdrawn"] }] };
    case "/api/private-school/classes": return { data: [{ id: "pk1", campusId: "pc1", name: "Math 4", schoolYear: "2026-2027", term: "Fall", teacher: "Teacher S1", status: "active", size: 18 }] };
    case "/api/private-school/report-cards": return { data: [{ id: "prc1", learnerId: "pl1", learner: "Ava Lin", schoolYear: "2026-2027", term: "Fall", status: "draft", lines: [] }] };
    // HSP-06 part 2: compliance planning.
    case "/api/homeschool/compliance": return { data: { schoolYear: "2026-2027", disclaimer: "Requirements differ by place and change. This is a planning aid, not legal advice.", canAdopt: true, canCheck: true,
      profile: { id: "cp1", label: "Example plan (2026.1)", custom: false, retentionYears: 3, provenance: "From the platform's template, last reviewed 2026-11-01 by Reviewer.",
        template: { authority: { name: "Example Department of Education", url: "https://example.org" }, sources: [{ title: "Example statute", url: "https://example.org/s" }], retired: false } },
      instruction: { required: { days: 180 }, progress: [{ learnerId: "l1", learner: "Mia", days: 42, hours: 168, daysMet: false }] }, subjects: ["Reading"],
      deadlines: [{ key: "notice", label: "Notice of intent", due: "2026-08-15", status: "done", flag: null }],
      documents: [{ key: "att", label: "Attendance record", perLearner: [{ learnerId: "l1", learner: "Mia", status: "to_do" }] }], assessments: [] } };
    case "/api/private-school/compliance": return { data: { schoolYear: "2026-2027", disclaimer: "Requirements differ by place and change. This is a planning aid, not legal advice.", canAdopt: true, profile: null } };
    case "/api/private-school/compliance/templates": return { data: [] };
    // HSP-07 part 2: reading lists and school messages.
    case "/api/homeschool/learners/l1/reading": return { data: { canEdit: true, totals: { finishedThisSchoolYear: 3, reading: 1, minutes: 600 },
      books: [{ id: "b1", title: "Charlotte's Web", author: "E. B. White", status: "reading", minutes: 90 }, { id: "b2", title: "Holes", author: "Louis Sachar", status: "finished", finishedOn: "2026-11-01", minutes: 300 }] } };
    case "/api/private-school/messages": return { data: [{ id: "t1", subject: "Math homework", status: "open", learner: "Ava Lin", learnerId: "pl1", lastAt: now, unread: 2, participant: true }] };
    case "/api/private-school/messages/contacts": return { data: [{ membershipId: "pm2", name: "Rita Registrar", role: "registrar" }] };
    // HSP-07: co-ops.
    case "/api/homeschool/coops": return { data: [{ id: "k1", name: "Creek Co-op", role: "organizer", families: 3 }] };
    case "/api/homeschool/coop-attendance": return { data: [{ id: "ca1", present: true, learnerId: "l1", name: "Mia", session: "Science lab", coop: "Creek Co-op", startsAt: now, minutes: 120, logged: false }] };
    // HSP-06: learner transfers.
    case "/api/homeschool/transfers": return { data: [{ id: "x1", direction: "sent", learner: "Mia", from: "Ortiz Homeschool", to: "Hillside Academy", purpose: "enrollment", sections: ["courses", "work"],
      status: "accepted", items: 4, sourceLearnerId: "l1", preparedAt: now }] };
    case "/api/homeschool/learners/l1/transferred-records": return { data: [] };
    case "/api/private-school/transfers": return { data: [{ id: "x2", direction: "received", learner: "Mia Ortiz", from: "Ortiz Homeschool", to: "Hillside Academy", purpose: "enrollment",
      sections: ["courses", "attendance"], status: "accepted", items: 3, receiverLearnerId: "pl1", preparedAt: now }] };
    // HSP-05: billing for finance and the school admin.
    case "/api/private-school/billing/accounts": return { data: [{ id: "pba1", name: "Lin family", payer: "Gwen Lin", status: "active", balanceCents: 555000 }] };
    case "/api/private-school/billing/learners": return { data: [{ id: "pl1", displayName: "Ava Lin", enrolled: true }] };
    case "/api/private-school/billing/invoices": return { data: [{ id: "pbi1", accountId: "pba1", account: "Lin family", number: "INV-2026-0001", title: "Fall tuition", status: "issued", dueOn: "2027-09-01",
      totalCents: 1155000, paidCents: 600000, refundedCents: 0, balanceCents: 555000, lines: [{ id: "pbl1", kind: "tuition", description: "Fall tuition", learner: "Ava Lin", amountCents: 1200000, needsApproval: false, approved: false },
        { id: "pbl2", kind: "aid", description: "Sibling discount", learner: null, amountCents: -45000, needsApproval: false, approved: true }],
      payments: [{ id: "pbp1", amountCents: 600000, method: "check", reference: "Check 1001", receivedOn: "2026-11-20", receiptNumber: "RCT-2026-0001" }],
      refunds: [{ id: "pbr1", paymentId: "pbp1", amountCents: 25000, reason: "Activity cancelled", status: "requested" }] },
      { id: "pbi2", accountId: "pba1", account: "Lin family", number: null, title: "Spring tuition", status: "draft", totalCents: 1000, paidCents: 0, refundedCents: 0, balanceCents: 1000,
        lines: [{ id: "pbl3", kind: "discount", description: "Early payment", amountCents: -100, needsApproval: true, approved: false }], payments: [], refunds: [] }] };
    case "/api/private-school/billing/providers": return { data: [{ id: "pbv1", provider: "square", label: "Square (front office)", accountReference: "sq-1", status: "proposed" }] };
    case "/api/private-school/billing/reconciliations": return { data: [{ id: "pbc1", from: "2026-11-01", to: "2026-11-20", totals: { receivedCents: 600000, refundedCents: 0, netCents: 600000 }, preparedBy: "Fran Finance", signedOffBy: null }] };
    case "/api/private-school/schedule": return { data: [{ classId: "pk1", name: "Math 4", weekday: 1, starts: "09:00", ends: "09:50", room: "12" }] };
    // HSP-01: a homeschool family session (owner).
    case "/api/homeschool/me": return { data: { family: { id: "f1", name: "Ortiz Homeschool", timeZone: "America/Chicago", jurisdiction: "US-TX" }, role: "owner", displayName: "Smoke Test",
      learners: [{ id: "l1", displayName: "Mia", gradeBand: "3", status: "active", authority: "full", upcomingThisWeek: 2 }], familyEventsThisWeek: 1 } };
    // HSP-02: one learner's plan, attendance and work.
    case "/api/homeschool/learners/l1/plan": return { data: { learner: { id: "l1", displayName: "Mia", gradeBand: "3", authority: "full" }, canTeach: true,
      courses: [{ id: "c1", title: "Algebra I", subject: "Math", schoolYear: "2026-2027", status: "active", finalGrade: null, credits: null }],
      goals: [{ id: "g1", courseId: "c1", text: "Two-step equations", status: "open" }] } };
    case "/api/homeschool/learners/l1/attendance": return { data: { totals: { instructionalDays: 12, absentDays: 1, minutes: 2880, hours: 48, minutesByKind: {} },
      sessions: [{ id: "a1", day: "2026-11-25", minutes: 240, kind: "instruction", courseId: "c1", voided: false }] } };
    case "/api/homeschool/learners/l1/work": return { data: [{ id: "w1", courseId: "c1", title: "Unit 1 test", kind: "test", doneOn: "2026-11-24", score: 18, maxScore: 20, provenance: "parent_entered", voided: false }] };
    case "/api/homeschool/calendar": return { data: [{ id: "e1", learnerId: "l1", title: "Fractions", kind: "lesson", startsAt: now, endsAt: now, allDay: false, cancelled: false }] };
    case "/api/homeschool/members": return { data: { members: [{ id: "m1", role: "owner", name: "Smoke Test", you: true }, { id: "m2", role: "co_educator", name: "Tutor Tess", you: false }], invitations: [] } };
    case "/api/session/contexts": return { data: { current: role === "homeschool" ? { kind: "homeschool_family", membershipId: "m1" } : { kind: "district" },
      contexts: [{ kind: "district", membershipId: "dm1", label: "Lakeside ISD · Maple", role: "parent" }, { kind: "homeschool_family", membershipId: "m1", label: "Ortiz Homeschool", role: "owner" }] } };
    case "/api/session": return { csrfToken: "smoke" };
    case "/api/safety/status": return { data: { incidents: liveLockdown ? [{ id: "inc1", schoolId: "s1", schoolName: "Maple", kind: "lockdown", label: "Lockdown", isDrill: true, status: "active",
        startedAt: now, message: "Lock doors, lights off, out of sight.", audience: "staff", instructions: null }] : [], canInitiate: sosCaps, canLead: sosCaps,
        weather: sosCaps ? [{ id: "w1", schoolId: "s1", school: "Maple", event: "Tornado Warning", level: "warning", hazard: "tornado", hazardLabel: "Tornado warning", suggestedKind: "shelter",
          headline: "Tornado Warning issued until 8:15PM", instruction: "TAKE COVER NOW!", expires: now, prompt: true }] : [] } };
    case "/api/safety/weather": return { data: { enabled: true, running: true, canToggle: false, schools: [{ id: "s1", name: "Maple", lat: 39.7393, lon: -104.9903 }],
        alerts: [{ id: "w2", school: "Maple", event: "Wind Advisory", level: "advisory", prompt: false, expires: now }] } };
    // SAFE-01: room status.
    case "/api/safety/incidents/inc1/my-room": return { data: { incidentId: "inc1", live: true, rooms: [{ id: "r12", name: "Room 12", building: "North", kind: "classroom" }, { id: "r14", name: "Room 14", building: "North", kind: "classroom" }],
        suggestedRoomId: "r12", last: null } };
    case "/api/safety/incidents/inc1/rooms": return { data: { incident: { id: "inc1", kind: "lockdown", label: "Lockdown", isDrill: true, status: "active", schoolName: "Maple" },
        totals: { rooms: 2, reported: 1, secured: 0, not_secured: 0, needs_help: 1, moved: 0, students: 2, adults: 1, waiting: 1 },
        rooms: [{ roomId: "r12", name: "Room 12", building: "North", report: { status: "needs_help", need: "medical", students: 2, adults: 1, note: "Asthma", by: "Teacher S1", at: now } },
          { roomId: "r14", name: "Room 14", building: "North", report: null }] } };
    case "/api/safety/incidents/inc1/displays": return { data: { total: 3, switched: 2, devices: [{ id: "d1", name: "Front board", kind: "display", room: "Room 14", lastSeenAt: now, switched: false },
        { id: "d2", name: "Door kiosk", kind: "kiosk", room: "Room 12", lastSeenAt: now, switched: true }, { id: "d3", name: "Cart A", kind: "student_device", room: "Room 12", lastSeenAt: now, switched: true }] } };
    case "/api/safety/shelter-areas": return { data: { schoolId: "s1", canEdit: true, hazards: [{ key: "tornado", label: "Tornado warning" }, { key: "lightning", label: "Lightning" }],
        defaults: { tornado: { id: "a1", area: "Gym hallway", route: null, setBy: "Principal S1", setAt: now } },
        rooms: [{ id: "r12", name: "Room 12", building: "North", areas: { tornado: { id: "a2", area: "Interior hallway B", route: null, setBy: "Principal S1", setAt: now } } }, { id: "r14", name: "Room 14", building: "North", areas: {} }] } };
    case "/api/safety/incidents/inc1/rollcall": return { data: { incident: {}, learners: [{ studentId: "c9", name: "Alice A", grade: "3", status: null, note: null }], extras: [], submittedAt: null } };
    case "/api/safety/incidents/inc1/sro-status": return { data: { incident: {}, updates: [] } };
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
    case "/api/staff-workspace": return { data: {
      tasks: role === "teacher" ? [{ id: "tk1", domain: "library", kind: "follow_up", status: "open", priority: "high", summary: "Reshelve overnight returns", due_at: null, assigned_to: "u1" }] : [],
      checklists: role === "teacher" ? [
        { id: "cl1", title: "Morning Library Check", domain: "library", cadence: "daily", item_id: "cli1", label: "Unlock media cart", position: 0, completed_at: null },
        { id: "cl2", title: "Transport sweep", domain: "transport", cadence: "daily", item_id: "cli2", label: "Confirm bus 12 arrival board", position: 0, completed_at: null }
      ] : [],
      handoffs: role === "teacher" ? [{ id: "sh1", domain: "library", summary: "Cart ready", next_action: "Shelve returns", from_user_id: "u8", to_user_id: "u1", acknowledged_at: null, created_at: now }] : [],
      announcements: []
    } };
    case "/api/arrival/today": return { data: role === "teacher" ? [
      { id: "ah1", student_id: "c1", display_name: "Alice A", grade_level: "3", method: "bus", status: "pending", initiated_at: now }
    ] : [] };
    case "/api/staff-management": return { data: { absences: [], shifts: role === "teacher" ? [
      { id: "shift1", staff_user_id: "u1", display_name: "Smoke Test", shift_date: today(), starts_at: "08:00", ends_at: "09:00", department: "library", assignment: "Morning library check-in", status: "scheduled" }
    ] : [], coverage: [], staffing: [] } };
    case "/api/transport/today": return { data: { routes: [], riders: role === "teacher" ? [
      { display_name: "Alice A", bus_label: "Bus 12", route_name: "North", direction: "am", stop_name: "Oak St", status: "boarded" }
    ] : [] } };
    case "/api/christie/path": return { data: { learner: { grade: "4" }, skills: [], activeSessionId: null } };
    case "/api/christie/copilot": return { data: { suggestions: [], note: "", bySkill: [] } };
    case "/api/learning/courses": return { data: { courses: [] } };
    case "/api/pickup/family": return { data: { children: [] } };
    case "/api/pickup/queue": return { data: { incident: null, waiting: role === "teacher" ? [
      { name: "Bob B", grade: "3" }
    ] : [], released: [], blocked: 0, denied: 0, earlyDismissals: [] } };
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
    // FED-06: the district's exchange gateway side.
    case "/api/district/exchange": return { data: { configured: true, publicKey: "TEST-PUBLIC-KEY", fingerprint: "1a".repeat(16),
      datasets: { enrollment_by_grade: { name: "Enrollment by school and grade" }, sports_participation: { name: "Students on sports rosters, by school" } },
      purposes: { state_reporting: "Required state reporting" }, minCellFloor: 5, defaultMinCell: 10, termsKeyConfigured: true } };
    // FED-05: a policy bundle received from Master Control.
    case "/api/district/policy-bundles": { const b = { id: "pbr1", bundleId: "pb-1", releaseId: "rel-1", version: 2, kind: "release", issuedAt: now, effectiveFrom: now,
      issuer: "Texas Education Agency", receivedAt: now, receivedBy: "Supt One", policies: [{ id: "security.mfa.required_for_staff", value: true, locked_by: "ps-1" }, { id: "ui.default_locale", value: "en-US", locked_by: null }] };
      return { data: { configured: true, fingerprint: "0f".repeat(16), latest: b, bundles: [b, { ...b, id: "pbr0", version: 1 }] } }; }
    // SPORT-05: one athletic association agreement, read once.
    case "/api/district/athletic-associations": return { data: { signingConfigured: true, fingerprint: "ab".repeat(16), agreements: [{ id: "ag1", associationRef: "uil-tx",
      associationName: "University Interscholastic League", purpose: "eligibility_verification", legalBasis: "UIL Constitution", effectiveFrom: now, effectiveTo: now, status: "active",
      inForce: true, consents: 12, reads: [{ action: "read", outcome: "allowed", reason: null, at: now }] }] } };
    // FED-07: the jurisdiction rules in force, under a state legal hold.
    case "/api/district/jurisdiction-rules": return { data: { bundleVersion: 2, jurisdictionId: "US-TX", effectiveFrom: now, auditYears: 7, closedCaseYears: 0, safetyYears: 5, historyYears: 10,
      legalHold: true, consentRequired: true, residency: { scope: "in_state", status: "met", declaredLocation: "US-TX", jurisdictionId: "US-TX" } } };
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
    // Teacher Dashboard (Phase 1): unified command center summary.
    case "/api/teacher/dashboard": return { data: {
      school: { id: "s1", name: "Maple", timezone: "America/New_York" },
      date: "2026-11-25",
      overview: {
        students: 20, attendanceMarkedToday: 18, absences7d: 2, myOpenCases: 1, coursesCount: 1,
        courses: [{ id: "co1", title: "Grade 4 Math", subject: "Math", gradeLevel: "4", students: 20, toReview: 1, toGrade: 2, planId: "cp1", planStatus: "ready", planTitle: "Fractions", planBlocks: 3 }],
        scheduleToday: [{ slotId: "tt1", roomId: "rm1", room: "Room 101", starts: "08:00", ends: "09:00", label: "Math 3", courseId: "co1", course: "Grade 4 Math", now: true }],
        upcomingShifts: [{ id: "sh1", shift_date: "2026-11-25", starts_at: now, ends_at: now, department: "library", assignment: "Morning library check-in", status: "scheduled" }],
        upcomingEvents: [{ id: "ev1", title: "Science Showcase", starts_at: new Date(Date.now() + 864e5).toISOString(), ends_at: new Date(Date.now() + 900e5).toISOString(), venue: "Gym", status: "published" }]
      },
      classroom: { assignedRooms: 1, connectedRooms: 1, checkinsToday: 1, rooms: [{ id: "rm1", name: "Room 101", kind: "classroom", now: true, deviceCount: 2, paired: true, controller: "My phone" }] },
      transportation: { busRidersCount: 1, busRiders: [{ studentId: "c1", displayName: "Alice A", busLabel: "Bus 12", routeName: "North", direction: "am", stopName: "Oak St", status: "boarded" }], arrivalsTotal: 1, arrivalsPending: 1, busArrivalsPending: 1, carArrivalsPending: 0, pickupWaitingCount: 1, pendingArrivals: [{ id: "ah1", studentId: "c1", displayName: "Alice A", gradeLevel: "3", method: "bus", status: "pending", initiatedAt: now }] },
      duties: [
        { domain: "library", label: "Library / media center", shiftsToday: 1, checklistsTotal: 2, checklistsCompleted: 1, openTasks: 1 },
        { domain: "meal_service", label: "Lunchroom", shiftsToday: 0, checklistsTotal: 1, checklistsCompleted: 1, openTasks: 0 },
        { domain: "transport", label: "Transport", shiftsToday: 0, checklistsTotal: 1, checklistsCompleted: 0, openTasks: 1 },
        { domain: "general", label: "General staff", shiftsToday: 0, checklistsTotal: 1, checklistsCompleted: 0, openTasks: 0 }
      ],
      workQueue: {
        toGrade: 2, quizzesToReview: 1, openAssignments: 3, draftAssignments: 1, tutoringFlagged: 1, historyDrafts: 1, openTasks: 2, incompleteChecklists: 3, pendingHandoffs: 1, unplannedCourses: 0,
        items: [{ kind: "grading", title: "Grade submitted work", detail: "2 submission(s) waiting", count: 2, target: "grading", priority: "high" }],
        checklistItems: [{ itemId: "cli1", checklistId: "cl1", title: "Morning Library Check", label: "Unlock media cart", domain: "library" }]
      },
      connections: { unreadMessages: 2, pendingHandoffsCount: 1, recentHandoffs: [{ id: "h1", domain: "library", summary: "Cart ready", next_action: "Shelve returns", acknowledged_at: null, created_at: now }], staffAnnouncements: [{ id: "sa1", title: "Staff briefing", body: "Meet at 8:00 AM", audience: "all_staff", created_at: now }], recentAnnouncements: [] },
      alerts: { unreadNotifications: 1, notifications: [{ id: "n1", kind: "announcement", title: "Bus 12 delayed 5m", body: "Updated arrival time", created_at: now, read_at: null }], safetyIncidents: [], urgentTasksCount: 0, urgentTasks: [], pendingArrivalsCount: 1, weatherPassOn: true, weatherAdvisories: [{ id: "wx1", event: "Winter Weather Advisory", level: "advisory", headline: "Snow expected this afternoon", expires: now }] }
    } };
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
    // SPORTS-01: MaxPreps and Hudl.
    case "/api/activities/a1/links": return { data: [{ service: "maxpreps", name: "MaxPreps", url: "https://www.maxpreps.com/x/falcons-soccer/" }] };
    case "/api/activities/a1/exports": return { data: { team: "Falcons Soccer", services: { maxpreps: { included: 1, withheld: 1 }, hudl: { included: 0, withheld: 2 } }, log: [] } };
    case "/api/family/sports-sharing": return { data: [{ studentId: "c1", name: "Ava Lee", teams: ["Falcons Soccer"], maxpreps: { since: now, by: "Smoke Test" }, hudl: null }] };
    // TC-05: history privacy controls.
    case "/api/history/sharing": return { data: role === "pupil" ? { holdsOwnRights: adultStudent, transition: adultStudent ? { basis: "age_18", effectiveOn: "2026-11-01" } : null,
        guardians: adultStudent ? [{ id: "u1", name: "Smoke Parent" }] : [], grants: adultStudent ? [{ id: "g1", grantee: "Smoke Parent", classifications: ["official_record"], expiresAt: new Date(Date.now() + 864e6).toISOString(), active: true }] : [] }
      : { grantsToMe: [], holdsOwnRights: [] } };
    case "/api/students": return { data: [{ id: "c9", local_student_number: "S1-A", display_name: "Alice A", grade_level: "10", school_id: "s1", school_name: "Maple" }] };
    case "/api/students/c9/history-privacy": return { data: { student: { id: "c9", name: "Alice A" }, guardians: [{ id: "u1", name: "Parent A", restricted: false }, { id: "u2", name: "Parent Two", restricted: true }],
      restrictions: [{ id: "r1", person: "Parent Two", kind: "court_order", basis: "Order 2026-114", documentRef: null, setBy: "Principal S1", setAt: now, endsOn: null, liftedAt: null }],
      transition: null, grants: [], emergency: [{ id: "e1", person: "Counselor S1", role: "counselor", reason: "Student in crisis; safety plan needed", openedAt: now, expiresAt: now, closed: true, reviewed: false }] } };
    case "/api/students/c9/history-transfers": return { data: { signingReady: true, keyFingerprint: "TEST-FP", transfers: [
      { id: "tr1", receivingDistrict: "Lakeside Unified", basis: "enrollment_request", note: "Request dated Nov 20", includeFamily: true, familyDecision: "approved", status: "ready",
        requestedBy: "Principal S1", createdAt: now, readyAt: now, items: 4, downloads: 1 }] } };
    // TC-06b: a transfer file received from another district, waiting to be checked.
    case "/api/history-imports": return { data: [{ id: "hi1", status: "received", from: { district: "Lakeside Unified", school: "Elm School" }, student: { name: "Alice A" },
      localStudent: null, items: 3, receivedAt: now }] };
    case "/api/history-imports/hi1": return { data: { id: "hi1", status: "received", from: { district: "Lakeside Unified", school: "Elm School", districtId: "x" }, addressedTo: "Maple District",
      basis: "enrollment_request", basisNote: "Request dated Nov 20", includesFamily: false, student: { name: "Alice A", number: "L-1", grade: "10" }, localStudent: null,
      fingerprint: "TEST-SENDER-FP", packagedAt: now, items: [{ pos: 1, title: "Report card", kind: "official_record", type: "event", body: "", occurredAt: now, decision: "pending" }], receivedBy: "Supt One", receivedAt: now, confirmedBy: null,
      candidates: [{ id: "c9", name: "Alice A", number: "S1-A", grade: "10", school: "Maple", sameName: true, sameNumber: false }], knownFingerprints: [],
      accepted: 0, rejected: 0 } };
    case "/api/family/history-transfers": return { data: [{ id: "tr2", studentId: "c1", studentName: "Alice A", school: "Maple", receivingDistrict: "Lakeside Unified",
      basis: "enrollment_request", note: "Request dated Nov 20", createdAt: now }] };
    case "/api/students/c9/history-access-log": return { data: [{ who: "Teacher S1", access: "teacher", action: "view_history", items: 3, at: now }] };
    case "/api/history/emergency-access": return { data: [{ id: "e1", person: "Counselor S1", role: "counselor", student: "Alice A", school: "Maple", reason: "Student in crisis; safety plan needed", openedAt: now, expiresAt: now }] };
    // RANK-01: the U.S. News indicators.
    case "/api/rankings/indicators": return { data: { note: "EduOS tracks your own figures; it doesn't compute or predict a rank.",
      indicators: [["college_readiness", "College readiness", 30], ["curriculum_breadth", "College curriculum breadth", 10], ["assessment_proficiency", "State assessment proficiency", 20],
        ["assessment_performance", "State assessment performance", 20], ["underserved_performance", "Underserved student performance", 10], ["graduation_rate", "Graduation rate", 10]]
        .map(([key, name, weight]) => ({ key, name, weight, about: `${name}.`, fields: key === "graduation_rate" ? [{ key: "rate", label: "Four-year graduation rate, %" }] : [{ key: "x", label: "Figure" }] })),
      published: { key: "published_rank", name: "Published U.S. News result", about: "For the record.", fields: [{ key: "nationalRank", label: "National rank" }] } } };
    case "/api/rankings/schools": return { data: { year: "2024-25", years: ["2024-25"], schools: [{ id: "s1", name: "Maple", entered: 2, verified: 1, weightCovered: 40,
      missing: ["curriculum_breadth", "assessment_proficiency", "assessment_performance", "underserved_performance"] }] } };
    case "/api/rankings/schools/s1": return { data: { id: "s1", name: "Maple", years: ["2024-25", "2023-24"], changesKept: 1, indicators: ["college_readiness", "curriculum_breadth",
      "assessment_proficiency", "assessment_performance", "underserved_performance", "graduation_rate", "published_rank"].map(key => ({ key, name: key, weight: key === "published_rank" ? null : 10,
        byYear: key === "graduation_rate" ? [{ id: "re1", year: "2024-25", indicator: key, values: { rate: 91.4 }, shown: { "Graduation rate": 91.4 }, sourceUrl: "https://example.gov/rc", sourceNote: "State report card",
          enteredBy: "Principal S1", enteredAt: now, verifiedBy: null }, { id: "re0", year: "2023-24", indicator: key, values: { rate: 89 }, shown: { "Graduation rate": 89 }, sourceNote: "State report card", enteredBy: "Principal S1" }] : [null, null] })) } };
    // SPORTS-02: connectors.
    case "/api/activities/a1/film": return { data: [{ title: "Home opener: full game", url: "https://www.hudl.com/video/3/123", event: "Home opener" }] };
    case "/api/activities/a1/connectors": return { data: { connectors: [{ service: "hudl", name: "Hudl", status: "approved", externalTeamId: "team-123", sendRoster: true, sendSchedule: true, pullResults: true, pullFilm: true }],
      runs: [{ service: "hudl", action: "send_roster", ok: true, count: 1, withheld: 1, message: null, at: now, by: "Smoke Test" }],
      waiting: [{ id: "in1", service: "hudl", event: "Home opener", date: "2026-09-05", opponent: "Central", homeScore: 3, awayScore: 1, teamStats: { shots: 12 } }],
      film: [{ id: "fl1", title: "Home opener: full game", url: "https://www.hudl.com/video/3/123", hidden: false }] } };
    case "/api/sports/connectors": return { data: [{ id: "cn1", schoolId: "s1", school: "Maple", service: "hudl", name: "Hudl", baseUrl: "https://api.hudl.com/partner", keyHint: "…6789",
      sendRoster: true, sendSchedule: true, pullResults: true, pullFilm: true, status: role === "it_admin" ? "pending" : "approved", requestedBy: "Principal S1", requestedAt: now }] };
    // TEACH-06: approved storage.
    case "/api/storage/devices": return { data: [{ id: "sd1", owner: "Teacher S1", ownerId: "u1", name: "Blue drive", kind: "usb_drive", serial: "SN-42", status: role === "teacher" ? "approved" : "pending", requestedAt: now }] };
    case "/api/storage/settings": return { data: { cloudEnabled: true, retentionDays: 365 } };
    case "/api/portfolio/cloud": return { data: [] };
    case "/api/storage/offloads": return { data: [{ owner: "Teacher S1", target: "device", device: "Blue drive", items: 2, at: now, sha256: "a".repeat(64) }] };
    // TEACH-05: the portable teacher profile.
    case "/api/portfolio/preview": return { data: { items: [{ id: "u1", kind: "unit", title: "Fractions", approval: { by: "Principal S1", at: "2026-10-01", district: "Riverside" }, rights: null, schoolKeepsCopy: true },
      { id: "cp1", kind: "coaching_plan", title: "Tuesday practice", approval: null, rights: { type: "copyright" }, schoolKeepsCopy: false }], licenses: 1, excluded: [{ kind: "unit", title: "Class stories", reason: "may_mention_students" }] } };
    case "/api/portfolio/claims": return { data: role === "teacher" ? [] : [{ id: "cl1", owner: "Teacher S1", itemKind: "unit", itemId: "u1", title: "Fractions", claimType: "copyright", registration: "TX0009999999",
      evidenceUrl: "https://publicrecords.copyright.gov/x", statement: "Registered before joining.", status: "pending", createdAt: now }] };
    case "/api/portfolio/packages": return { data: [{ id: "pk1", issuedAt: now, items: 2, district: "Hill County", sha256: "a".repeat(64), signed: true, withdrawn: false, fromHere: false },
      { id: "pk2", issuedAt: now, items: 1, district: "Riverside", sha256: "b".repeat(64), signed: true, withdrawn: false, fromHere: true }] };
    case "/api/portfolio/imports": return { data: [{ id: "im1", owner: "Teacher S1", ownerId: "u1", fromDistrict: "Hill County", signed: true, status: "pending", createdAt: now, licenses: [{ stateCode: "TX" }],
      items: [{ index: 0, kind: "unit", title: "Fractions", approval: { by: "Ms Lee", at: "2026-01-01", district: "Hill County" }, rights: null, decision: null }] }] };
    case "/api/portfolio/library": return { data: [{ id: "lb1", kind: "lesson", title: "Halves", body: {}, origin: "Hill County", priorApproval: { by: "Ms Lee" }, rights: null, approvedBy: "Supt One", approvedAt: now }] };
    // ROOM-02: remote lessons (students get the link only from Join).
    case "/api/my/remote-lessons": return { data: [{ id: "rl1", courseId: "k1", course: "Math 3", date: now.slice(0, 10), starts: "08:00", ends: "09:00", provider: "Zoom", lessonId: "ls1", lesson: "Fraction strips",
      note: "Have your workbook ready", today: true, open: true, joined: false, ...(role === "teacher" ? { joinUrl: "https://zoom.us/j/123" } : {}) }] };
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
        decisions: [{ decision: "submitted", reasonCode: null, note: null, by: "teacher", at: now }, { decision: "changes_requested", reasonCode: "needs_edits", note: "Add the date.", by: "school_lead", at: now }],
        photos: [{ id: "a1", alt: "Volcano model erupting", caption: "Science fair" }] },
      { id: "h2", studentId: "c1", studentName: "Alice A", entryType: "achievement", title: "Spelling bee", body: "", occurredAt: now, status: "published", updatedAt: now, decisions: [] }] };
    // TC-04 portfolio.
    case "/api/history/portfolio": return { data: { student: { id: "c1", name: "Alice A" }, nextCursor: "next",
      items: [{ id: "p1", entryType: "project", kind: "teacher_artifact", title: "Volcano project", body: "Built a model.", occurredAt: now, schoolYear: "2026-27", source: "teacher", authorName: "Teacher S1",
        photos: [{ id: "a1", alt: "Volcano model erupting", caption: "Science fair", width: 800, height: 600 }] },
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
      items: [{ position: 0, entryId: "e1", withheld: false, entryType: "reflection", kind: "family_memory", title: "The day you were born", body: "So happy.", occurredAt: now,
        photos: [{ id: "a3", alt: "Newborn Alice", caption: "" }] }],
      photos: [{ id: "a4", alt: "Our family on the porch", caption: "Spring 2026" }],
      recipients: [{ userId: "u9", name: "Pupil A", type: "student", consent: "pending" }], events: [] } };
    case "/api/history/capsules/cap1/candidates": return { data: [{ id: "e2", title: "First day of school", entryType: "event", kind: "family_memory", occurredAt: now }] };
    case "/api/history/capsule-recipient-options": return { data: [{ userId: "u9", name: "Pupil A", type: "student" }, { userId: "u1", name: "Smoke Test", type: "guardian" }] };
    // TC-11: the family storage dashboard.
    case "/api/history/storage": return { data: { student: { id: "c1", name: "Alice A" }, limits: { photosAllowed: true, maxPhotoBytes: 10485760, maxPhotosPerItem: 6, maxBytesPerStudent: 262144000, types: ["image/jpeg"], setBy: "district" },
      usage: { usedBytes: 26214400, percent: 10, photos: 14, inLongTermStorage: 3, roomForAnotherPhoto: true }, items: { inHistory: 9, waitingForReview: 1, drafts: 0 },
      ...(role === "parent" ? { myContributions: { waiting: 1, accepted: 4, declined: 1, withdrawn: 0 } } : {}),
      capsules: [{ id: "cap1", title: "For Alice at 18", status: "scheduled", opens: { on: now } }],
      retention: { recordsScheduleRef: "Board policy 8310", text: "Official school records are kept by the district under its records schedule." },
      export: { allowed: true, href: "/api/history/export?studentId=c1" }, guidance: ["JPEG, PNG and WebP photos are accepted."],
      donations: { changeStorage: false, text: "Donations never change this limit." } } };
    // TC-09: preservation gifts (sandbox only).
    case "/api/donations/status": return { data: { enabled: true, districtEnabled: true, canGive: role !== "pupil", sandboxOnly: true, minCents: 500, maxCents: 50000,
      suggestedCents: [1000, 2500], schools: [{ id: "s1", name: "Maple" }], methods: [{ method: "sandbox", label: "Sandbox", available: true, default: true }],
      statement: "Gifts are voluntary. They never change storage limits, what is kept, or anything a student gets.", changesStorage: false } };
    case "/api/donations/mine": return { data: [{ id: "g1", status: "succeeded", amountCents: 2500, currency: "USD", designation: { schoolId: "s1", name: "Maple" }, acknowledgement: { id: "a1", number: "GIFT-2026-000001" } }] };
    case "/api/donations/settings": return { data: { enabled: true, minCents: 500, maxCents: 50000, suggestedCents: [1000, 2500], acknowledgementText: "Thank you for your voluntary gift.", taxWordingEnabled: false, taxWording: null } };
    case "/api/donations": return { data: { totals: { gifts: 3, grossCents: 7500, feesCents: 400, netCents: 7100 }, sandboxOnly: true,
      gifts: [{ id: "g2", status: "succeeded", amountCents: 2500, processingFeeCents: 103, donor: "Parent A", acknowledgement: { id: "a2", number: "GIFT-2026-000002" }, refundNotice: null }] } };
    // TC-10: gift accounts (superintendent; reviewers are named staff).
    case "/api/donations/finance/access": return { data: { finance: role === "superintendent" } };
    case "/api/donations/reconciliation": return { data: { gifts: 3, grossCents: 7500, feesCents: 400, refunds: 1, refundedCents: 1000, netCents: 6100, ledgerNetCents: 6100,
      ledgerLines: 7, matched: true, discrepancies: [], canSignOff: true, signOffBlocked: null, sandboxOnly: true } };
    case "/api/donations/reconciliations": return { data: [{ id: "r1", periodStart: "2026-10-01", periodEnd: "2026-10-31", matched: true, reconciledBy: "Supt One" }] };
    case "/api/donations/finance/reviewers": return { data: { reviewers: [{ userId: "u7", name: "Pat Finance" }], history: [], staff: [{ id: "u7", name: "Pat Finance" }, { id: "u8", name: "Sam Office" }], rules: [] } };
    // TC-12: the preservation fund.
    case "/api/preservation-fund": return { data: { fundName: "Student history preservation fund", purpose: "Keeping student histories safe for every student.",
      eligibleCategories: [{ key: "storage", label: "Storage" }, { key: "backup", label: "Backups" }], allocationRules: "Unrestricted gifts pay district-wide costs.",
      governanceText: "The finance committee reviews requests.", refundPolicy: "Ask the district office within 30 days.", approvalRule: "Every payment needs three approvals, all required: the principal of the school it's for and two district administrators. None of them can be the person who asked for it, and each confirms they have no conflict of interest.", approvalsRequired: 3, collecting: true, paused: null,
      limits: "The fund pays only for district-wide preservation. It can't buy any student more storage or any kind of preferential access.",
      summary: { shown: true, givenCents: 8500, feesCents: 400, spentCents: 3000, spentByCategory: { storage: 3000 } }, sandboxOnly: true } };
    case "/api/preservation-fund/settings": return { data: { enabled: true, collectionPaused: false, disbursementPaused: false, pauseReason: null, fundName: "Student history preservation fund",
      purpose: "Keeping student histories safe for every student.", eligibleCategories: ["storage", "backup"], allocationRules: null, governanceText: null, refundPolicy: null,
      approvalRule: "Every payment needs three approvals, all required: the principal of the school it's for and two district administrators. None of them can be the person who asked for it, and each confirms they have no conflict of interest.", approvalsRequired: 3, publicReport: false, gradeCardFootnote: true, reportMinDonors: 5, categories: { storage: "Storage", backup: "Backups", archival_media: "Archival media" },
      governance: { records: [{ id: "gr1", kind: "legal", reference: "Counsel memo 12", approvedOn: "2026-11-01", recordedBy: "Supt One" }, { id: "gr2", kind: "finance", reference: "Finance committee minutes", approvedOn: "2026-11-02", recordedBy: "Supt One" }], missing: ["governance"] } } };
    case "/api/preservation-fund/report": return { data: { settings: { enabled: true, approvalRule: "Every payment needs three approvals, all required: the principal of the school it's for and two district administrators. None of them can be the person who asked for it, and each confirms they have no conflict of interest.", approvalsRequired: 3, disbursementPaused: false, eligibleCategories: ["storage", "backup"] }, me: "u1",
      schools: [{ id: "s1", name: "Lincoln Elementary" }],
      categories: { storage: "Storage", backup: "Backups" }, sandboxOnly: true,
      balances: [{ source: { unrestricted: true, name: "Unrestricted" }, giftsNetCents: 7100, paidCents: 3000, availableCents: 4100 }],
      disbursements: [{ id: "fd1", status: "pending", category: "storage", categoryLabel: "Storage", description: "Archive storage for the year", payee: "Example Storage Co", amountCents: 3000,
        school: { schoolId: "s1", name: "Lincoln Elementary" }, panel: { principal: 0, principalNeeded: 1, districtAdmins: 0, districtAdminsNeeded: 2 },
        requestedBy: "Pat Finance", requestedById: "u7", votes: [] },
        { id: "fd2", status: "approved", category: "backup", categoryLabel: "Backups", description: "Offsite backup copies", payee: "Backup Co", amountCents: 1000,
        school: { schoolId: "s1", name: "Lincoln Elementary" }, panel: { principal: 1, principalNeeded: 1, districtAdmins: 2, districtAdminsNeeded: 2 },
        requestedBy: "Pat Finance", requestedById: "u7", votes: [{ voter: "Lee Principal", voterId: "u3", seat: "school_principal", seatLabel: "Principal", decision: "approve" },
          { voter: "Supt Two", voterId: "u2", seat: "district_admin", seatLabel: "District administrator", decision: "approve" },
          { voter: "Ira Admin", voterId: "u9", seat: "district_admin", seatLabel: "District administrator", decision: "approve" }] }] } };
    case "/api/preservation-fund/approvals": return { data: { rule: "Every payment needs three approvals, all required: the principal of the school it's for and two district administrators. None of them can be the person who asked for it, and each confirms they have no conflict of interest.", me: "u1", sandboxOnly: true,
      waiting: [{ id: "fd1", status: "pending", category: "storage", categoryLabel: "Storage", description: "Archive storage for the year", payee: "Example Storage Co", amountCents: 3000,
        school: { schoolId: "s1", name: "Lincoln Elementary" }, panel: { principal: 0, principalNeeded: 1, districtAdmins: 0, districtAdminsNeeded: 2 },
        requestedBy: "Pat Finance", requestedById: "u7", votes: [], mySeat: "district_admin" }] } };
    // TC-08: preservation and legal holds.
    case "/api/history/preservation": return { data: { policy: { verifyEveryDays: 90, archiveAfterDays: null, capacityAlertPercent: 80, recordsScheduleRef: "" },
      canEdit: role === "superintendent", storageReady: true, archiveStorageClass: null, maxBytesPerStudent: 262144000, lastCheckedAt: now, donationsAffectLimits: false,
      schools: [{ schoolId: "s1", school: "Maple", studentsWithMedia: 12, usedBytes: 52428800, archiveBytes: 0, nearLimit: 1, atLimit: 0, activeHolds: 1, integrity: { unverified: 0, ok: 40, mismatch: 1, missing: 0 } }],
      problems: [{ kind: "mismatch", school: "Maple", at: now, text: "A photo at Maple failed its integrity check" }] } };
    case "/api/history/legal-holds": return { data: [{ id: "lh1", student: { id: "c9", name: "Alice A" }, school: "Maple", reason: "Records request in litigation", matterRef: "Case 26-CV-0142", placedBy: "Principal S1", placedAt: now }] };
    case "/api/students/c9/legal-holds": return { data: { student: { id: "c9", name: "Alice A" }, onHold: true, canRelease: role === "superintendent",
      holds: [{ id: "lh1", reason: "Records request in litigation", matterRef: "Case 26-CV-0142", placedBy: "Principal S1", placedAt: now, releasedAt: null }] } };
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
      if (/^\/api\/remote-lessons\/[^/]+\/join$/.test(pathname) && req.method === "POST") {
        remoteJoins.push(pathname);
        res.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify({ data: { joinUrl: "https://zoom.us/j/123", already: false } }));
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
      if (pathname === "/api/safety/incidents/inc1/room-status" && req.method === "POST") {
        let raw = ""; req.on("data", c => { raw += c; });
        return req.on("end", () => { roomReports.push(JSON.parse(raw || "{}"));
          res.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ data: { id: "rr1", status: "needs_help", room: "Room 12", alerted: 2, at: new Date().toISOString() } })); });
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
      const body = req.method === "GET" || /^\/api\/integrations\/connectors\/[^/]+\/sync$/.test(pathname) ? (pathname === "/api/me" ? mockApi(state.role, pathname) : mockApi(state.role === "vice_principal" ? "principal" : state.role, pathname, state.failWebhookLoads)) : { data: {} };
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

test("web app boots and every role's tabs render", { skip: !CHROME && !required && "Chrome not installed (set EDUOS_REQUIRE_BROWSER=1 to require it)", timeout: 600000 }, async (t) => {
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
        // TC-11: the family storage dashboard on the history page.
        const storageExpect = { "parent/portfolio": ["Storage: 25.0 MB of 250.0 MB used", "14 photos (3 in long-term storage", "4 accepted · 1 waiting · 1 declined", "can't be raised by payment or donation", "Board policy 8310"],
          "pupil/portfolio": ["Storage: 25.0 MB of 250.0 MB used"] }[`${role}/${tab}`];
        for (const want of storageExpect || []) if (!text.includes(want)) failures.push(`${role} #/${tab}: "${want}" is missing`);
        // TC-09: the gift card for parents; the settings for the superintendent.
        const giftExpect = { "parent/portfolio": ["Support preservation", "never change storage limits", "Give (test)", "GIFT-2026-000001",
            "About the Student history preservation fund", "can't buy any student more storage", "$85.00 given", "the principal of the school it's for and two district administrators"],
          "superintendent/history": ["Preservation gifts", "3 gifts · $75.00 given", "Accept gifts", "no claim that a gift is tax-deductible",
            "Gift accounts", "The gift records and the ledger match.", "Sign off this month", "2026-10-01 to 2026-10-31 · matched · Supt One", "GIFT-2026-000002", "Pat Finance", "Name reviewer",
            "Preservation fund", "Still needed before gifts open: governance approval.", "Record approval", "Fund payments", "$41.00 available",
            "Waiting for approvals", "Supt Two (District administrator) approved", "Lee Principal (Principal) approved", "principal 0/1 · district administrators 0/2",
            "Fund payments to approve", "you approve as a district administrator", "Add the totals as a footnote on student grade cards", "Record payment", "Save fund settings"] }[`${role}/${tab}`];
        for (const want of giftExpect || []) if (!text.includes(want)) failures.push(`${role} #/${tab}: "${want}" is missing`);
        if (["principal", "teacher"].includes(role) && tab === "history" && text.includes("Gift accounts")) failures.push(`${role} #/history: gift accounts shown without being named`);
        if (role === "pupil" && tab === "portfolio" && text.includes("Support preservation")) failures.push("pupil #/portfolio: students must not be asked to give");
        // TC-08: preservation for the records office; settings and holds for the superintendent.
        const preserveExpect = { "principal/history": ["Preservation", "Maple", "failed its integrity check"],
          "superintendent/history": ["Preservation", "Preservation settings", "Legal holds (1)", "Case 26-CV-0142"] }[`${role}/${tab}`];
        for (const want of preserveExpect || []) if (!text.includes(want)) failures.push(`${role} #/${tab}: "${want}" is missing`);
        if (["superintendent", "it_admin"].includes(role) && tab === "payments") {
          if (!text.includes("Payment webhook operations") || !text.includes("Late payment captures needing a refund") || !text.includes("Webhook events requiring investigation"))
            failures.push(`${role} #/payments: webhook operations panel is incomplete`);
          if (!text.includes("CAPTURE-123") || !text.includes("evt-123")) failures.push(`${role} #/payments: webhook recovery records did not render`);
        }
        // TC-03: the teacher, reviewer and family screens show their items and actions.
        const expect = { "teacher/dashboard": ["Teacher command dashboard", "Alerts and time-sensitive notices", "Today\u2019s schedule and classes", "Work queue", "Classroom operations", "Transportation and school-day duties", "Staff connections", "Mark read", "Confirm handoff", "Complete", "Acknowledge", "classroom roll", "2 of 3 checked in", "Pair this device to use live classroom controls.", "Weather advisories", "Winter Weather Advisory"],
          "teacher/schoolday": ["School day", "Library / media center duty", "Transport duty", "Confirm handoff", "Staff handoffs", "All duties", "Leave a handoff"],
          "teacher/contributions": ["Volcano project", "Changes requested · Needs edits", "Save and resubmit", "In the student's history", "Add a photo", "Science fair"],
          "principal/history": ["Teacher contributions", "Science fair", "Ask for changes", "Reject"],
          "vice_principal/history": ["Teacher contributions", "Science fair", "Ask for changes"],
          "superintendent/history": ["Teacher contributions", "Science fair"],
          "parent/children": ["From teachers (1 to decide)", "Volcano project", "Keep in history", "Decline", "History & portfolio"],
          "parent/portfolio": ["Alice A's history", "School year 2026-27", "Volcano project", "Search", "Download a copy", "Science fair", "A records transfer needs your decision"],
          "pupil/portfolio": ["Download a copy", "My history", "School year 2026-27", "School year 2025-26", "Volcano project", "From a teacher", "Family day", "All school years", "Show more"] }[`${role}/${tab}`];
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
      for (const w of ["Share aggregates (exchange gateway)", "Build and sign", "Agreement terms file"])
        if (!text.includes(w)) failures.push(`superintendent #/integrations: exchange "${w}" is missing`);
      for (const w of ["Policies from Master Control", "Version 2", "security.mfa.required_for_staff", "Locked", "Earlier versions received: 1", "Check and keep"])
        if (!text.includes(w)) failures.push(`superintendent #/integrations: policy bundles "${w}" is missing`);
      for (const w of ["Athletic associations", "University Interscholastic League", "12 families agreed", "New access token", "Approve agreement"])
        if (!text.includes(w)) failures.push(`superintendent #/integrations: athletic associations "${w}" is missing`);
      for (const w of ["Jurisdiction rules", "Legal hold: no district records", "In the district's state", "Meets the rule (as declared)", "7 years", "Exchanges need a recorded consent"])
        if (!text.includes(w)) failures.push(`superintendent #/integrations: jurisdiction rules "${w}" is missing`);
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
  // ROOM-02: a student joins a remote lesson from home (checked in, then the link); the teacher's plan has the remote lesson form. Both pass axe.
  {
    remoteJoins = [];
    let page;
    const waitFor = async js => { for (let i = 0; i < 100; i++) { if (await page.eval(js)) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
    try {
      state.role = "pupil"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/home` });
      await page.mainText();
      if (!(await waitFor(`!!document.querySelector('main button[aria-label="Join: Math 3"]')`))) failures.push("pupil: no remote lesson Join");
      if (await page.eval(`!!document.querySelector('main a[href*="zoom.us"]')`)) failures.push("pupil: the link shows before joining");
      await page.eval(`document.querySelector('main button[aria-label="Join: Math 3"]').click()`);
      if (!(await waitFor(`!!document.querySelector('main a[href="https://zoom.us/j/123"][rel~="noopener"]')`))) failures.push("pupil: no Open Zoom link after joining");
      if (JSON.stringify(remoteJoins) !== JSON.stringify(["/api/remote-lessons/rl1/join"])) failures.push(`remote joins: ${JSON.stringify(remoteJoins)}`);
      await axeScan(page, "pupil: remote lesson joined", a11y);
      if (page.errors.length) failures.push(`pupil remote: ${page.errors[0].split("\n")[0]}`);
      page.close();

      state.role = "teacher"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/classes` });
      await page.mainText();
      await waitFor(`!!document.querySelector('main button[aria-label^="Open plan: Math 3"]')`);
      await page.eval(`document.querySelector('main button[aria-label^="Open plan: Math 3"]').click()`);
      if (!(await waitFor(`!!document.querySelector("main #rl-u")`))) failures.push("teacher plan: no remote lesson form");
      await axeScan(page, "teacher: plan with remote lesson", a11y);
      if (page.errors.length) failures.push(`teacher remote: ${page.errors[0].split("\n")[0]}`);
    } finally { page?.close(); }
  }
  // TEACH-05: a teacher's work to take along (claims, packages, library); a principal's review of claims and imports. All pass axe.
  {
    let page;
    const waitFor = async js => { for (let i = 0; i < 100; i++) { if (await page.eval(js)) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
    try {
      state.role = "teacher"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/mywork` });
      await page.mainText();
      if (!(await waitFor(`(document.querySelector("main")?.textContent || "").includes("Left out until you edit them")`))) failures.push("teacher portfolio: excluded items");
      const t = await page.eval(`document.querySelector("main").textContent`);
      for (const w of ["School keeps a copy", "Your rights: school won't keep a copy", "Bring into this district", "Add my 1 license here", "Copy into a course"]) if (!t.includes(w)) failures.push(`teacher portfolio: ${w}`);
      await axeScan(page, "teacher: my work", a11y);
      await page.eval(`document.querySelector('main button[aria-label="Claim rights: Fractions"]').click()`);
      if (!(await waitFor(`!!document.querySelector("dialog[open] #cr-s")`))) failures.push("teacher: no claim dialog");
      await axeScan(page, "teacher: claim rights dialog", a11y);
      await page.eval(`document.querySelector("dialog[open] .btns .btn:not(.primary)").click()`);
      for (const w of ["Approved storage", "Open a package file", "Save to approved storage"]) if (!(await page.eval(`document.querySelector("main").textContent.includes(${JSON.stringify(w)})`))) failures.push(`teacher storage: ${w}`);
      await page.eval(`[...document.querySelectorAll("main button")].find(b => b.textContent === "Save to approved storage").click()`);
      if (!(await waitFor(`!!document.querySelector("dialog[open] #of-t")`))) failures.push("teacher: no save-to-storage dialog");
      const opts = await page.eval(`[...document.querySelectorAll("dialog[open] #of-t option")].map(o => o.textContent).join("|")`);
      if (opts !== "Blue drive (USB drive)|The district cloud") failures.push(`storage options: ${opts}`);
      await axeScan(page, "teacher: save to approved storage", a11y);
      await page.eval(`document.querySelector("dialog[open] .btns .btn:not(.primary)").click()`);
      await page.eval(`[...document.querySelectorAll("main button")].find(b => b.textContent === "Open a package file").click()`);
      if (!(await waitFor(`!!document.querySelector("dialog[open] #pf-c")`))) failures.push("teacher: no open-file dialog");
      await axeScan(page, "teacher: open a package file", a11y);
      if (page.errors.length) failures.push(`teacher portfolio: ${page.errors[0].split("\n")[0]}`);
      page.close();

      state.role = "principal"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/portfolioreview` });
      await page.mainText();
      if (!(await waitFor(`!!document.querySelector('main button[aria-label="Approve claim: Fractions"]')`))) failures.push("principal: no claim to review");
      if (!(await page.eval(`(document.querySelector("main").textContent).includes("Save decisions for Teacher S1")`))) failures.push("principal: no import to review");
      await axeScan(page, "principal: teachers' work review", a11y);
      if (!(await page.eval(`document.querySelector("main").textContent.includes("Teacher S1: 2 items to Blue drive")`))) failures.push("principal: offload log");
      page.close();
      state.role = "it_admin"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/devices` });
      await page.mainText();
      await page.eval(`[...document.querySelectorAll("main button")].find(b => b.textContent === "Teachers' storage").click()`);
      if (!(await waitFor(`!!document.querySelector('main button[aria-label="Approve storage: Blue drive"]')`))) failures.push("IT: no storage approval");
      await axeScan(page, "it_admin: teachers' storage", a11y);
      if (page.errors.length) failures.push(`principal review: ${page.errors[0].split("\n")[0]}`);
    } finally { page?.close(); }
  }
  // SPORTS-01: a coach sees team pages and the MaxPreps/Hudl files; a family sees its opt-in. Both pass axe.
  {
    let page;
    const waitFor = async js => { for (let i = 0; i < 100; i++) { if (await page.eval(js)) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
    try {
      state.role = "teacher"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/activities` });
      await page.mainText();
      await waitFor(`!!document.querySelector('main button[aria-label="MaxPreps & Hudl: Falcons Soccer"]')`);
      // A coach gets the Arbiter scheduling and officials links, opening in a new tab.
      const arbiter = await page.eval(`JSON.stringify([...document.querySelectorAll('main section[aria-label="Scheduling and officials"] a')].map(a => [a.textContent, a.getAttribute("href"), a.target, a.rel]))`);
      if (arbiter !== JSON.stringify([["Arbiter: sign in", "https://www.arbitersports.com/", "_blank", "noopener noreferrer"], ["Game and event scheduling", "https://arbiter.io/products/scheduling/", "_blank", "noopener noreferrer"], ["Officials assigning", "https://arbiter.io/products/assigning/", "_blank", "noopener noreferrer"]]))
        failures.push(`coach: Arbiter links ${arbiter}`);
      await page.eval(`document.querySelector('main button[aria-label="MaxPreps & Hudl: Falcons Soccer"]').click()`);
      if (!(await waitFor(`!!document.querySelector('dialog[open] button[aria-label="MaxPreps roster file"]')`))) failures.push("coach: no MaxPreps roster file");
      const d = await page.eval(`document.querySelector("dialog[open]").textContent`);
      if (!d.includes("roster: 1 opted in, 1 not") || !d.includes("Falcons Soccer on MaxPreps")) failures.push(`coach dialog: ${d.slice(0, 200)}`);
      for (const w of ["Game film", "Connected accounts", "Results to approve", "Home opener (2026-09-05): 3–1 vs Central"]) if (!d.includes(w)) failures.push(`coach connector: ${w}`);
      if (!(await page.eval(`!!document.querySelector('dialog[open] button[aria-label="Sync now with Hudl"]')`))) failures.push("coach: no Sync now");
      await axeScan(page, "teacher: MaxPreps & Hudl", a11y);
      if (page.errors.length) failures.push(`coach sports: ${page.errors[0].split("\n")[0]}`);
      page.close();

      state.role = "parent"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/activities` });
      await page.mainText();
      if (!(await waitFor(`(document.querySelector("main")?.textContent || "").includes("Sharing with MaxPreps and Hudl")`))) failures.push("parent: no sharing card");
      const boxes = await page.eval(`[...document.querySelectorAll('section[aria-label="Sharing with MaxPreps and Hudl"] input[type=checkbox]')].map(b => b.checked).join()`);
      if (boxes !== "true,false") failures.push(`parent sharing: ${boxes}`);
      if (await page.eval(`!!document.querySelector('section[aria-label="MaxPreps and Hudl connectors"]')`)) failures.push("parent sees connectors");
      await axeScan(page, "parent: sharing with MaxPreps and Hudl", a11y);
      if (page.errors.length) failures.push(`parent sports: ${page.errors[0].split("\n")[0]}`);
      page.close();
      state.role = "it_admin"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/devices` });
      await page.mainText();
      await page.eval(`[...document.querySelectorAll("main button")].find(b => b.textContent === "Sports connectors").click()`);
      if (!(await waitFor(`!!document.querySelector('main button[aria-label="Approve Hudl for Maple"]')`))) failures.push("IT: no connector approval");
      await axeScan(page, "it_admin: sports connectors", a11y);
      page.close();
      state.role = "principal"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/activities` });
      await page.mainText();
      if (!(await waitFor(`!!document.querySelector('section[aria-label="MaxPreps and Hudl connectors"]')`))) failures.push("principal: no connectors card");
      await page.eval(`[...document.querySelectorAll("main button")].find(b => b.textContent === "Connect an account").click()`);
      if (!(await waitFor(`!!document.querySelector("dialog[open] #cn-k")`))) failures.push("principal: no connect dialog");
      await axeScan(page, "principal: connect an account", a11y);
      if (page.errors.length) failures.push(`principal connectors: ${page.errors[0].split("\n")[0]}`);
    } finally { page?.close(); }
  }
  // RANK-01: the superintendent sees every school's coverage, opens one, and can verify; the principal enters figures. Pass axe.
  {
    let page;
    const waitFor = async js => { for (let i = 0; i < 100; i++) { if (await page.eval(js)) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
    try {
      state.role = "superintendent"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/rankings` });
      await page.mainText();
      if (!(await waitFor(`(document.querySelector("main")?.textContent || "").includes("2 of 6 · 40% of the weight")`))) failures.push("superintendent: rankings coverage");
      await axeScan(page, "superintendent: U.S. News indicators", a11y);
      await page.eval(`document.querySelector('main button[aria-label="Open: Maple"]').click()`);
      if (!(await waitFor(`!!document.querySelector('main button[aria-label="Verify: graduation_rate"]')`))) failures.push("superintendent: no Verify");
      const t = await page.eval(`document.querySelector("main").textContent`);
      for (const w of ["91.4%", "2023-24: Graduation rate 89%", "Not verified yet", "1 earlier figure is kept as history"]) if (!t.includes(w)) failures.push(`school rankings: ${w}`);
      await axeScan(page, "superintendent: one school's indicators", a11y);
      if (page.errors.length) failures.push(`rankings: ${page.errors[0].split("\n")[0]}`);
      page.close();
      state.role = "principal"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/rankings` });
      await page.mainText();
      await waitFor(`!!document.querySelector('main button[aria-label="Enter figures: graduation_rate"]')`);
      await page.eval(`document.querySelector('main button[aria-label="Enter figures: graduation_rate"]').click()`);
      if (!(await waitFor(`!!document.querySelector("dialog[open] #rk-rate")`))) failures.push("principal: no enter-figures dialog");
      await axeScan(page, "principal: enter figures", a11y);
      if (page.errors.length) failures.push(`principal rankings: ${page.errors[0].split("\n")[0]}`);
    } finally { page?.close(); }
  }
  // TC-05: the records office's privacy page; the superintendent's emergency reviews; an adult student's sharing; a counselor's emergency form. All pass axe.
  {
    let page;
    const waitFor = async js => { for (let i = 0; i < 100; i++) { if (await page.eval(js)) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
    try {
      state.role = "superintendent"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/history` });
      await page.mainText();
      if (!(await waitFor(`(document.querySelector("main")?.textContent || "").includes("Emergency access to review")`))) failures.push("superintendent: no emergency reviews");
      if (!(await page.eval(`!!document.querySelector('section[aria-label="Records and privacy"]')`))) failures.push("superintendent: no records & privacy");
      await axeScan(page, "superintendent: history with privacy controls", a11y);
      if (!(await waitFor(`!!document.querySelector('main button[aria-label="Open transfer: Alice A"]')`))) failures.push("superintendent: no incoming transfers");
      await page.eval(`document.querySelector('main button[aria-label="Open transfer: Alice A"]').click()`);
      if (!(await waitFor(`(document.querySelector("main")?.textContent || "").includes("1. Check who sent it")`))) failures.push("superintendent: no transfer check page");
      const ti = await page.eval(`document.querySelector("main").textContent`);
      for (const w of ["Alice A: history from Lakeside Unified", "TEST-SENDER-FP", "Possible matches", "Choose the student", "Reject the whole file"]) if (!ti.includes(w)) failures.push(`incoming transfer: ${w}`);
      await axeScan(page, "superintendent: incoming history transfer", a11y);
      if (page.errors.length) failures.push(`incoming transfer: ${page.errors[0].split("\n")[0]}`);
      page.close();

      state.role = "principal"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/history` });
      await page.mainText();
      await waitFor(`!!document.querySelector("#rp-q")`);
      await page.eval(`(() => { document.querySelector("#rp-q").value = "Alice"; document.querySelector("#rp-q").form.requestSubmit(); })()`);
      await waitFor(`!!document.querySelector('main button[aria-label="Privacy: Alice A"]')`);
      await page.eval(`document.querySelector('main button[aria-label="Privacy: Alice A"]').click()`);
      if (!(await waitFor(`(document.querySelector("main")?.textContent || "").includes("Alice A: records & privacy")`))) failures.push("principal: no privacy page");
      const t = await page.eval(`document.querySelector("main").textContent`);
      for (const w of ["Restricted", "Order 2026-114", "Who looked", "Teacher S1 (teacher)", "Transfer to another district", "Download transfer file", "TEST-FP"]) if (!t.includes(w)) failures.push(`privacy page: ${w}`);
      for (const w of ["Legal hold", "Case 26-CV-0142", "nothing can be deleted"]) if (!t.includes(w)) failures.push(`privacy page (TC-08): ${w}`);
      await axeScan(page, "principal: records & privacy", a11y);
      if (page.errors.length) failures.push(`privacy page: ${page.errors[0].split("\n")[0]}`);
      page.close();

      adultStudent = true; state.role = "pupil"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/portfolio` });
      await page.mainText();
      if (!(await waitFor(`!!document.querySelector('main button[aria-label="Stop sharing with Smoke Parent"]')`))) failures.push("adult student: no sharing controls");
      await axeScan(page, "pupil: sharing my history", a11y);
      page.close(); adultStudent = false;

      state.role = "counselor"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/emergencyrecords` });
      await page.mainText();
      if (!(await waitFor(`!!document.querySelector("main #em-r")`))) failures.push("counselor: no emergency form");
      await axeScan(page, "counselor: emergency access", a11y);
      if (page.errors.length) failures.push(`counselor emergency: ${page.errors[0].split("\n")[0]}`);
    } finally { page?.close(); adultStudent = false; }
  }
  // SAFE-01: in a lockdown a teacher reports their room (needs help: medical); the SRO and a nurse see their screens. All pass axe.
  {
    let page;
    const waitFor = async js => { for (let i = 0; i < 100; i++) { if (await page.eval(js)) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
    try {
      liveLockdown = true; state.role = "teacher"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/safety` });
      await page.mainText();
      if (!(await waitFor(`!!document.querySelector("main #rs-room")`))) failures.push("teacher lockdown: no room status");
      if ((await page.eval(`document.querySelector("#rs-room").value`)) !== "r12") failures.push("teacher lockdown: timetabled room not chosen");
      await axeScan(page, "teacher: room status in a lockdown", a11y);
      await page.eval(`[...document.querySelectorAll('main [aria-label="Room status"] button')].find(b => b.textContent === "Needs help").click()`);
      await waitFor(`!!document.querySelector("main #rs-need")`);
      await page.eval(`(() => { document.querySelector("#rs-st").value = "2"; [...document.querySelectorAll("main button")].find(b => b.textContent.includes("Send room status")).click(); })()`);
      for (let k = 0; k < 50 && !roomReports.length; k++) await new Promise(r => setTimeout(r, 100));
      const sent = roomReports.at(-1);
      if (!sent || sent.status !== "needs_help" || sent.need !== "medical" || sent.roomId !== "r12" || sent.students !== 2) failures.push(`teacher lockdown: sent ${JSON.stringify(sent)}`);
      if (page.errors.length) failures.push(`teacher lockdown: ${page.errors[0].split("\n")[0]}`);
      page.close();

      state.role = "sro"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/safety` });
      await page.mainText();
      if (!(await waitFor(`(document.querySelector('main section[aria-label="Rooms"]')?.textContent || "").includes("Needs help: Medical")`))) failures.push("sro: no room board");
      if (!(await page.eval(`document.querySelector('main section[aria-label="Rooms"]').textContent.includes("Classroom screens: 2 of 3 switched (dark and silent). Not yet: Front board (Room 14)")`))) failures.push("sro: no display check");
      await waitFor(`!!document.querySelector("main #rs-room")`);
      await axeScan(page, "sro: room board", a11y);
      if (page.errors.length) failures.push(`sro board: ${page.errors[0].split("\n")[0]}`);
      page.close();

      state.role = "nurse"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/safety` });
      await page.mainText();
      if (!(await waitFor(`!!document.querySelector("main #rs-room")`))) failures.push("nurse lockdown: no room status");
      await axeScan(page, "nurse: room status", a11y);
    } finally { page?.close(); liveLockdown = false; }
  }
  // SAFE-03: the principal's shelter areas, and the start-an-alert hazard picker. Both pass axe.
  {
    let page;
    const waitFor = async js => { for (let i = 0; i < 100; i++) { if (await page.eval(js)) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
    try {
      state.role = "principal"; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/devices` });
      await page.mainText();
      await waitFor(`[...document.querySelectorAll("main button")].some(b => b.textContent === "Shelter areas")`);
      await page.eval(`[...document.querySelectorAll("main button")].find(b => b.textContent === "Shelter areas").click()`);
      if (!(await waitFor(`document.querySelector("#sa-r12")?.value === "Interior hallway B" && document.querySelector("#sa-default")?.value === "Gym hallway"`))) failures.push("principal: shelter areas");
      await axeScan(page, "principal: shelter areas", a11y);
      page.close();
      sosCaps = true; page = await Page.open(chrome.port);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/sos` });
      await page.mainText();
      await waitFor(`!!document.querySelector('main button.kind.shelter')`);
      await page.eval(`document.querySelector('main button.kind.shelter').click()`);
      if (!(await waitFor(`!!document.querySelector("main #sos-hazard")`))) failures.push("sos: no hazard picker for shelter");
      // SAFE-04: the NWS prompt starts a shelter for the tornado; the weather card lists locations and advisories.
      if (!(await waitFor(`!!document.querySelector('main section[aria-label="Weather warnings"]') && !!document.querySelector("main #wx-lat-s1")`))) failures.push("sos: no weather prompt or settings");
      await page.eval(`document.querySelector('main button[aria-label="Start shelter: Tornado warning, Maple"]').click()`);
      if (!(await waitFor(`document.querySelector("main #sos-hazard")?.value === "tornado"`))) failures.push("sos: weather prompt didn't choose the tornado");
      await axeScan(page, "principal: start a shelter with a hazard", a11y);
      if (page.errors.length) failures.push(`sos hazard: ${page.errors[0].split("\n")[0]}`);
    } finally { page?.close(); sosCaps = false; }
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
  // HSP-01: a homeschool family session shows its own workspace, not district tabs.
  state.role = "homeschool";
  {
    const page = await Page.open(chrome.port);
    try {
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/` });
      let text = "";
      for (const end = Date.now() + 8000; Date.now() < end && !text.includes("Add a learner"); await new Promise(r => setTimeout(r, 100))) text = await page.mainText();
      for (const w of ["Ortiz Homeschool", "Learners", "Mia", "2 this week", "Coming up", "Fractions", "Tutor Tess", "Invite an adult", "Add a learner", "Add to the calendar", "Receive records", "Transfer code", "Co-ops", "Creek Co-op", "Compliance planning · 2026-2027", "Mia: 42/180 days", "Notice of intent · 2026-08-15", "Example Department of Education", "not legal advice", "Organizer · 3 families", "Mia · Creek Co-op · Science lab · 120 min", "Add to log", "Start a co-op"])
        if (!text.includes(w)) failures.push(`homeschool workspace: "${w}" is missing`);
      await axeScan(page, "homeschool workspace", a11y);
      await page.eval(`([...document.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === "Open Mia") || {}).click?.()`);
      for (const end = Date.now() + 8000; Date.now() < end && !text.includes("Work and evidence"); await new Promise(r => setTimeout(r, 100))) text = await page.mainText();
      for (const w of ["Algebra I", "Two-step equations", "12 days · 48 hours · 1 absent", "Unit 1 test", "18/20", "Export transcript", "Progress report (last 90 days)", "Add a course", "Transfer records", "sent to Hillside Academy", "Reading", "3 finished this school year", "Charlotte's Web", "Add a book", "Prepare transfer", "Courses and final grades"])
        if (!text.includes(w)) failures.push(`homeschool learner: "${w}" is missing`);
      await axeScan(page, "homeschool learner", a11y);
      if (page.errors.length) failures.push(`homeschool workspace: ${page.errors[0].split("\n")[0]}`);
    } finally { page.close(); }
  }
  // HSP-03: a private school session shows the school workspace.
  state.role = "private_school";
  {
    const page = await Page.open(chrome.port);
    try {
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/` });
      let text = "";
      for (const end = Date.now() + 8000; Date.now() < end && !text.includes("Export the school's records"); await new Promise(r => setTimeout(r, 100))) text = await page.mainText();
      for (const w of ["Hillside Academy", "School administrator", "Ava Lin", "Main Campus", "#H-001", "First day of term", "Rita Registrar", "Enroll a learner", "Invite someone", "Billing", "INV-2026-0001", "Messages", "Math homework", "No plan for this school year yet.", "Or set your own targets", "2 new", "New conversation", "Rita Registrar (Registrar)", "Transfers", "from Ortiz Homeschool", "Send a learner's records", "Published report cards", "Receive records", "RCT-2026-0001", "needs approval", "Sign off", "Draft invoice", "Export the school's records", "Ask to close the school",
        "Admissions", "Cy Park", "Under review", "documents 1/2", "Offered", "New inquiry", "This week's schedule", "Mon 09:00–09:50 · Math 4", "Classes", "18 learners", "Report cards", "Draft"])
        if (!text.includes(w)) failures.push(`private school workspace: "${w}" is missing`);
      await axeScan(page, "private school workspace", a11y);
      if (page.errors.length) failures.push(`private school workspace: ${page.errors[0].split("\n")[0]}`);
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
