// End-to-end smoke test for a running EduOS stack (32.1.0; 32.2.0 adds the app mesh and role homes;
// 32.3.0 adds school branding; 32.4.0 the mobile role apps, transport, Christie and the Comms Hub;
// 32.5.0 SafetyOS incidents and car pick-up verification).
//   node dev/smoke.mjs            (normally via scripts/smoke.sh / make smoke)
// Env:
//   EDUOS_BASE        app origin through the edge (default https://localhost:8443)
//   EDUOS_INTERNAL    shell prefix that runs "node -e <code>" inside the API
//                     container (for /metrics and the loopback webhook sink)
//   EDUOS_RETENTION   shell command that runs the retention job once
//   METRICS_TOKEN     bearer token for /metrics
// Every run uses fresh names, subjects and batch ids, so it can be re-run
// against the same database. It exercises the real OIDC code flow through the
// local development provider; nothing is stubbed inside the API.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { verifySignature } from "../src/webhooks.js";
import { spawn } from "node:child_process";
import { DISTRICT, USERS, STUDENTS, SCHOOLS, ASSIGNMENTS, APPS, LTI_TOOL_ORIGIN } from "./demo-fixture.js";

const BASE = (process.env.EDUOS_BASE || "https://localhost:8443").replace(/\/$/, "");
const RUN = Date.now().toString(36);
const results = [];

async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`  ✔ ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.error(`  ✖ ${name}\n    ${error.stack || error.message}`); summary(); process.exit(1); }
}
function summary() { const ok = results.filter(r => r.ok).length; console.log(`\n${ok}/${results.length} smoke steps passed`); }

class Session {
  constructor(label) { this.label = label; this.jar = new Map(); this.csrf = null; }
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (v && !/max-age=0/i.test(c)) this.jar.set(k, v); else this.jar.delete(k);
    }
  }
  async raw(method, path, { body, headers = {}, csrf = true } = {}) {
    const h = { cookie: this.cookie(), ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    if (csrf && this.csrf && !["GET", "HEAD"].includes(method)) h["x-csrf-token"] = this.csrf;
    const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    this.store(res);
    return res;
  }
  async call(method, path, body, opts = {}) {
    const res = await this.raw(method, path, { body, ...opts });
    const type = res.headers.get("content-type") || "";
    const data = type.includes("json") ? await res.json() : await res.text();
    return { status: res.status, body: data, headers: res.headers };
  }
  async ok(method, path, body, expected = [200, 201]) {
    const r = await this.call(method, path, body);
    assert.ok([].concat(expected).includes(r.status), `${this.label} ${method} ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  }
  /** Full browser-equivalent OIDC sign-in through the local provider. */
  async signIn(sub, extra = {}) {
    let res = await this.raw("GET", "/auth/login");
    assert.equal(res.status, 302, "login should redirect to the IdP");
    const authorize = new URL(res.headers.get("location"));
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    const page = await fetch(authorize);
    assert.equal(page.status, 200, "IdP sign-in page");
    const form = new URLSearchParams(authorize.searchParams); form.set("sub", sub);
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    res = await fetch(new URL("/authorize/approve", authorize), { method: "POST", body: form, redirect: "manual" });
    assert.equal(res.status, 302, "IdP should redirect back with a code");
    const callback = new URL(res.headers.get("location"));
    assert.equal(callback.origin, BASE, "callback must return to the app origin");
    res = await this.raw("GET", callback.pathname + callback.search);
    if (res.status !== 303) return { status: res.status, text: await res.text() };
    this.csrf = (await this.ok("GET", "/api/csrf")).csrfToken;
    this.me = await this.ok("GET", "/api/me");
    return { status: 303 };
  }
}
async function signedIn(sub, label = sub) {
  const s = new Session(label); const r = await s.signIn(sub);
  assert.equal(r.status, 303, `${sub} sign-in failed: ${r.status} ${r.text}`);
  return s;
}
const internal = code => {
  if (!process.env.EDUOS_INTERNAL) return null;
  return execSync(`${process.env.EDUOS_INTERNAL} ${JSON.stringify(code)}`, { encoding: "utf8" });
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log(`EduOS smoke test against ${BASE} (run ${RUN})`);
const S = {};
let newSchool, newTeacher, invite, webhook, webhookSecret, importedNumber, draftId;

await step("health endpoint reports ok and the release version", async () => {
  const r = await fetch(`${BASE}/health`); const body = await r.json();
  assert.equal(r.status, 200); assert.equal(body.status, "ok"); assert.match(body.version, /^\d+\.\d+\.\d+$/);
});
await step("edge serves the UI over HTTPS with security headers", async () => {
  const r = await fetch(`${BASE}/`); const html = await r.text();
  assert.equal(r.status, 200); assert.match(html, /EduOS District Edition/);
  assert.match(r.headers.get("content-security-policy") || "", /default-src 'self'/);
  assert.match(r.headers.get("strict-transport-security") || "", /max-age=/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});
await step("unauthenticated API calls are rejected", async () => {
  const anon = new Session("anon");
  assert.equal((await anon.call("GET", "/api/me")).status, 401);
  assert.equal((await anon.call("POST", "/api/schools", { name: "x" })).status, 401);
  const cfg = await anon.ok("GET", "/api/app-config"); assert.equal(cfg.demoMode, false);
});
await step("superintendent signs in through OIDC (PKCE, nonce, __Host- cookie)", async () => {
  S.supt = await signedIn(USERS.superintendent.sub, "superintendent");
  assert.equal(S.supt.me.role, "superintendent");
  assert.ok([...S.supt.jar.keys()].some(k => k.startsWith("__Host-")), "session cookie should be __Host- over HTTPS");
});
await step("an unprovisioned identity is refused", async () => {
  const s = new Session("stranger"); const r = await s.signIn(`unknown-${RUN}`);
  assert.equal(r.status, 403);
});
await step("CSRF: state-changing requests need the session's token", async () => {
  const r = await S.supt.call("POST", "/api/schools", { name: `No token ${RUN}` }, { csrf: false });
  assert.equal(r.status, 403); assert.equal(r.body.error, "csrf_validation_failed");
  const bad = await S.supt.call("POST", "/api/schools", { name: `Bad token ${RUN}` }, { csrf: false, headers: { "x-csrf-token": "forged" } });
  assert.equal(bad.status, 403);
});
await step("admin creates a school", async () => {
  newSchool = (await S.supt.ok("POST", "/api/schools", { name: `Harbor High School ${RUN}`, schoolLevel: "high" })).data;
  const schools = (await S.supt.ok("GET", "/api/schools")).data;
  assert.ok(schools.some(s => s.id === newSchool.id));
  assert.equal((await S.supt.call("POST", "/api/schools", { name: `Harbor High School ${RUN}` })).status, 409);
});
await step("admin creates a teacher, who can then sign in", async () => {
  newTeacher = (await S.supt.ok("POST", "/api/users", { displayName: `Casey Rivera ${RUN}`, email: `casey.${RUN}@riverside-usd.example`,
    oidcSubject: `smoke-teacher-${RUN}`, role: "teacher", schoolId: SCHOOLS.elementary.id })).data;
  const t = new Session("new teacher"); const r = await t.signIn(`smoke-teacher-${RUN}`);
  assert.equal(r.status, 303); assert.equal(t.me.role, "teacher"); assert.equal(t.me.schoolId, SCHOOLS.elementary.id);
  S.newTeacher = t;
});
await step("admin adds a second membership and lists district users", async () => {
  await S.supt.ok("POST", `/api/users/${newTeacher.id}/memberships`, { role: "teacher", schoolId: newSchool.id });
  const users = (await S.supt.ok("GET", "/api/users")).data;
  const u = users.find(x => x.id === newTeacher.id);
  assert.equal(u.memberships.length, 2);
  const memberships = (await S.newTeacher.ok("GET", "/api/memberships")).data;
  assert.equal(memberships.length, 2);
});
await step("principal cannot create leadership accounts or act outside the school", async () => {
  S.principal = await signedIn(USERS.principal.sub, "principal");
  const r = await S.principal.call("POST", "/api/users", { displayName: "X", email: `x.${RUN}@riverside-usd.example`, oidcSubject: `x-${RUN}`, role: "superintendent" });
  assert.equal(r.status, 403);
  const other = await S.principal.call("POST", "/api/users", { displayName: "Y", email: `y.${RUN}@riverside-usd.example`, oidcSubject: `y-${RUN}`, role: "teacher", schoolId: SCHOOLS.middle.id });
  assert.equal(other.status, 403);
  const teachers = (await S.principal.ok("GET", "/api/users?role=teacher")).data;
  assert.ok(teachers.some(t => t.id === USERS.teacher.id));
  assert.ok(teachers.every(t => t.oidcSubject === undefined), "principals do not see OIDC subjects");
});
await step("principal manages the teacher roster; the teacher sees only rostered students", async () => {
  S.teacher = await signedIn(USERS.teacher.sub, "teacher");
  const before = (await S.teacher.ok("GET", "/api/students")).data.map(s => s.id);
  assert.deepEqual(before.sort(), [STUDENTS.ava.id, STUDENTS.noah.id, STUDENTS.liam.id, STUDENTS.sofia.id].sort());
  await S.principal.ok("POST", "/api/rosters", { teacherUserId: USERS.teacher.id, studentId: STUDENTS.mia.id });
  assert.ok((await S.teacher.ok("GET", "/api/students")).data.some(s => s.id === STUDENTS.mia.id));
  await S.principal.ok("DELETE", `/api/rosters/${USERS.teacher.id}/${STUDENTS.mia.id}`);
  assert.ok(!(await S.teacher.ok("GET", "/api/students")).data.some(s => s.id === STUDENTS.mia.id));
  assert.equal((await S.teacher.call("GET", `/api/students/${STUDENTS.mia.id}`)).status, 404);
});
await step("teacher drafts an assignment; students cannot see drafts", async () => {
  S.pupil = await signedIn(USERS.pupil.sub, "student");
  draftId = (await S.teacher.ok("POST", "/api/assignments", { title: `Map skills ${RUN}`, instructions: "Label the seven continents.", status: "draft",
    dueAt: new Date(Date.now() + 7 * 864e5).toISOString() })).data.id;
  const seen = (await S.pupil.ok("GET", "/api/assignments")).data.map(a => a.id);
  assert.ok(!seen.includes(draftId)); assert.ok(!seen.includes(ASSIGNMENTS[2].id), "seeded draft hidden");
  assert.ok(seen.includes(ASSIGNMENTS[0].id), "seeded published assignment visible");
  assert.equal((await S.pupil.call("POST", `/api/assignments/${draftId}/submit`, { studentId: STUDENTS.ava.id, responseText: "early" })).status, 404);
});
await step("teacher publishes; the student submits; the teacher grades; the student sees the grade", async () => {
  await S.teacher.ok("PATCH", `/api/assignments/${draftId}`, { status: "published" });
  assert.ok((await S.pupil.ok("GET", "/api/assignments")).data.some(a => a.id === draftId));
  const sub = (await S.pupil.ok("POST", `/api/assignments/${draftId}/submit`, { studentId: STUDENTS.ava.id, responseText: "Africa, Antarctica, Asia, Australia, Europe, North America, South America" })).data;
  const subs = (await S.teacher.ok("GET", `/api/assignments/${draftId}/submissions`)).data;
  assert.ok(subs.some(s => s.id === sub.id));
  await S.teacher.ok("POST", `/api/assignments/${draftId}/submissions/${sub.id}/grade`, { score: 96, feedback: "Great work" });
  const profile = (await S.pupil.ok("GET", `/api/student-360/${STUDENTS.ava.id}`)).data;
  assert.ok(profile.academics.some(a => Number(a.score) === 96), "grade visible to the student");
  assert.equal((await S.pupil.call("GET", `/api/student-360/${STUDENTS.noah.id}`)).status, 404, "other students hidden");
});
await step("guardian portal: principal provisions a parent, invites, wrong account refused, invitee accepts", async () => {
  // A fresh guardian per run (the seeded "Taylor Brooks" is left for manual evaluation).
  const email = `guardian.${RUN}@riverside-usd.example`;
  await S.principal.ok("POST", "/api/users", { displayName: `Jamie Brooks ${RUN}`, email, oidcSubject: `smoke-parent-${RUN}`, role: "parent", schoolId: SCHOOLS.elementary.id });
  const r = await S.principal.ok("POST", "/api/guardian-invitations", { studentId: STUDENTS.noah.id, email, relationship: "guardian" });
  assert.equal(r.delivery, "not_configured");
  invite = decodeURIComponent(r.invitationUrl.split("guardianInvite=")[1]);
  S.parent = await signedIn(USERS.parent.sub, "parent");
  assert.equal((await S.parent.call("POST", "/api/guardian-invitations/accept", { token: invite })).status, 403);
  S.invitee = new Session("invitee");
  assert.equal((await S.invitee.signIn(`smoke-parent-${RUN}`, { email })).status, 303);
  assert.equal((await S.invitee.ok("GET", "/api/family/children")).data.length, 0);
  await S.invitee.ok("POST", "/api/guardian-invitations/accept", { token: invite });
  const kids = (await S.invitee.ok("GET", "/api/family/children")).data;
  assert.ok(kids.some(k => k.id === STUDENTS.noah.id || k.student_id === STUDENTS.noah.id), JSON.stringify(kids));
  assert.equal((await S.invitee.call("POST", "/api/guardian-invitations/accept", { token: invite })).status, 409, "single use");
  const summary = await S.invitee.ok("GET", `/api/family/children/${STUDENTS.noah.id}/summary`);
  assert.ok(summary.data || summary, "family summary");
});
await step("family messaging between the linked guardian and the teacher", async () => {
  await S.parent.ok("POST", "/api/family/messages", { studentId: STUDENTS.ava.id, recipientUserId: USERS.teacher.id, body: `Hello from Alex (${RUN})` });
  const inbox = (await S.teacher.ok("GET", `/api/family/messages?studentId=${STUDENTS.ava.id}`)).data;
  assert.ok(inbox.some(m => String(m.body).includes(RUN)));
});
await step("SIS CSV import: students and attendance, idempotent batch, line-numbered errors", async () => {
  importedNumber = `SIS-${RUN}`;
  const body = { schoolId: SCHOOLS.elementary.id, sourceSystem: "PowerSchool-demo", sourceBatchId: `batch-${RUN}`,
    studentsCsv: `local_student_number,display_name,grade_level\r\n${importedNumber},"Quinn, Harper",5\r\n${importedNumber}-2,Rowan Diaz,5\r\n`,
    attendanceCsv: `source_event_id,local_student_number,event_date,status\nev-${RUN}-1,${importedNumber},2026-11-02,present\nev-${RUN}-2,${importedNumber}-2,2026-11-02,absent\n` };
  const r = await S.supt.ok("POST", "/api/integrations/sis/import-csv", body);
  assert.equal(r.data.studentsUpserted, 2); assert.equal(r.data.attendanceImported, 2);
  assert.equal((await S.supt.call("POST", "/api/integrations/sis/import-csv", body)).status, 409, "same batch twice");
  const bad = await S.supt.call("POST", "/api/integrations/sis/import-csv", { ...body, sourceBatchId: `bad-${RUN}`, attendanceCsv: "source_event_id,local_student_number,event_date,status\nx,y,2026-13-40,present\n" });
  assert.equal(bad.status, 400); assert.equal(bad.body.error, "csv_invalid_date"); assert.equal(bad.body.line, 2);
  const runs = (await S.supt.ok("GET", "/api/integrations/sis/runs")).data;
  assert.ok(runs.some(x => x.source_batch_id === `batch-${RUN}`));
  assert.equal((await S.principal.call("POST", "/api/integrations/sis/import-csv", { ...body, sourceBatchId: `p-${RUN}` })).status, 403, "principal needs a grant");
});
await step("access request: a teacher requests schools:update, a superintendent approves, the grant works", async () => {
  const t = S.newTeacher;
  const csv = { schoolId: SCHOOLS.elementary.id, sourceSystem: "teacher-upload", sourceBatchId: `grant-${RUN}`,
    attendanceCsv: `source_event_id,local_student_number,event_date,status\ng-${RUN},${importedNumber},2026-11-03,tardy\n` };
  assert.equal((await t.call("POST", "/api/integrations/sis/import-csv", csv)).status, 403, "no grant yet");
  const req = (await t.ok("POST", "/api/access-requests", { resource: "schools", action: "update",
    reason: `Smoke test ${RUN}: import a corrected attendance file for my class`, expiresAt: new Date(Date.now() + 2 * 864e5).toISOString() })).data;
  await S.supt.ok("POST", `/api/access-requests/${req.id}/decision`, { decision: "approved", note: "ok" });
  const mine = (await t.ok("GET", "/api/access-requests")).data;
  assert.ok(mine.some(x => x.id === req.id && x.status === "approved"));
  assert.equal((await t.ok("POST", "/api/integrations/sis/import-csv", csv)).data.attendanceImported, 1, "grant applies");
});
await step("webhooks: register a loopback receiver, test delivery, signed event on publish", async () => {
  const created = await S.supt.ok("POST", "/api/webhooks", { url: `http://127.0.0.1:9999/hooks/smoke-${RUN}`, eventTypes: ["assignment.created"] });
  webhook = created.data; webhookSecret = created.secret; assert.match(webhookSecret, /^whsec_/);
  const test = await S.supt.ok("POST", `/api/webhooks/${webhook.id}/test`, {});
  assert.equal(test.outcome, "delivered", JSON.stringify(test));
  await S.teacher.ok("POST", "/api/assignments", { title: `Webhook check ${RUN}`, instructions: "", status: "published" });
  let deliveries = [];
  for (let i = 0; i < 20; i++) {
    deliveries = (await S.supt.ok("GET", `/api/webhooks/${webhook.id}/deliveries`)).data;
    if (deliveries.some(d => d.eventType === "assignment.created" && d.outcome === "delivered")) break;
    await sleep(500);
  }
  assert.ok(deliveries.some(d => d.eventType === "assignment.created" && d.outcome === "delivered"), JSON.stringify(deliveries));
  const sink = internal(`fetch("http://127.0.0.1:9999/deliveries").then(r=>r.text()).then(t=>process.stdout.write(t))`);
  if (sink !== null) {
    const mine = JSON.parse(sink).data.filter(d => d.path === `/hooks/smoke-${RUN}`);
    assert.ok(mine.length >= 2, "receiver got the test and the event");
    for (const d of mine) assert.ok(verifySignature(webhookSecret, d.signature, d.body), "signature verifies with the one-time secret");
    assert.ok(!mine.some(d => /Ava|Noah|@/.test(d.body)), "payloads carry no student names or emails");
  }
});
await step("flow events feed records server events", async () => {
  // assignment.created is addressed to pupils, parents and principals.
  const events = (await S.principal.ok("GET", "/api/flow-events")).data;
  assert.ok(events.some(e => e.type === "assignment.created"), JSON.stringify(events.slice(0, 3)));
  assert.ok((await S.pupil.ok("GET", "/api/flow-events")).data.some(e => e.type === "assignment.created"));
});
await step("audit log records administrative actions and exports as CSV", async () => {
  const audit = (await S.supt.ok("GET", "/api/audit")).data;
  for (const action of ["create", "sis_import", "read"]) assert.ok(audit.some(a => a.action === action), `audit has ${action}`);
  const res = await S.supt.raw("POST", "/api/audit/export");
  assert.equal(res.status, 200); assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(await res.text(), /^"occurred_at","actor_role"/);
  assert.equal((await S.teacher.call("GET", "/api/audit")).status, 403);
});
await step("FERPA: record export and superintendent-only deletion", async () => {
  const students = (await S.supt.ok("GET", `/api/students?schoolId=${SCHOOLS.elementary.id}`)).data;
  const target = students.find(s => s.local_student_number === `${importedNumber}-2`);
  const exp = await S.supt.raw("POST", `/api/students/${target.id}/records-export`);
  assert.equal(exp.status, 200); assert.match(exp.headers.get("content-disposition"), /attachment/);
  const record = await exp.json(); assert.equal(record.student.local_student_number, `${importedNumber}-2`); assert.equal(record.attendance.length, 1);
  assert.equal((await S.principal.call("POST", `/api/students/${target.id}/records-delete`, { confirmLocalStudentNumber: `${importedNumber}-2`, reason: "x".repeat(25) })).status, 403);
  assert.equal((await S.supt.call("POST", `/api/students/${target.id}/records-delete`, { confirmLocalStudentNumber: "wrong", reason: "Parent request under FERPA, verified by phone" })).status, 409);
  await S.supt.ok("POST", `/api/students/${target.id}/records-delete`, { confirmLocalStudentNumber: `${importedNumber}-2`, reason: "Parent request under FERPA, verified by phone" });
  assert.equal((await S.supt.call("GET", `/api/students/${target.id}`)).status, 404);
});
// ---- 32.2.0: district resource mesh and role homes ----
const appByName = name => APPS.find(a => a.name === name);
await step("IT admin manages apps and accounts but cannot read student records", async () => {
  S.it = await signedIn(USERS.itAdmin.sub, "it_admin");
  const home = await S.it.ok("GET", "/api/home");
  assert.equal(home.role, "it_admin"); assert.equal(home.data.students, undefined);
  assert.equal((await S.it.call("GET", "/api/students")).status, 403);
  const names = (await S.it.ok("GET", "/api/apps?limit=100")).data.map(a => a.name);
  for (const a of APPS) assert.ok(names.includes(a.name), `catalog has ${a.name}`);
  assert.equal((await S.it.call("POST", "/api/users", { displayName: "x", email: `x-${RUN}@example.test`, oidcSubject: `x-${RUN}`, role: "superintendent" })).status, 403);
});
await step("one district purchase works in every school; a school's purchase is shared only where assigned", async () => {
  const teacherApps = (await S.teacher.ok("GET", "/api/my/apps")).data.map(a => a.name);
  for (const n of ["Riverside Reading Room", "MathQuest", "Lincoln Lab Notebook", "Science Lab (LTI demo)"]) assert.ok(teacherApps.includes(n), `teacher sees ${n}`);
  const pupilApps = (await S.pupil.ok("GET", "/api/my/apps")).data.map(a => a.name);
  assert.ok(pupilApps.includes("MathQuest")); assert.ok(!pupilApps.includes("Lincoln Lab Notebook"), "shared to teachers only");
  S.principalMiddle = await signedIn(USERS.principalMiddle.sub, "principal-middle");
  const middle = (await S.principalMiddle.ok("GET", "/api/my/apps")).data.map(a => a.name);
  assert.ok(middle.includes("Lincoln Lab Notebook") && middle.includes("Riverside Reading Room"));
  const launch = await S.pupil.ok("POST", `/api/apps/${appByName("MathQuest").id}/launch`);
  assert.equal(launch.data.url, appByName("MathQuest").url);
  assert.ok([403, 404].includes((await S.pupil.call("POST", `/api/apps/${appByName("Lincoln Lab Notebook").id}/launch`)).status), "not assigned to students");
  const usage = (await S.supt.ok("GET", `/api/apps/${appByName("MathQuest").id}/usage`)).data;
  assert.equal(usage.scope, "district"); assert.ok(usage.bySchool.find(s => s.schoolId === SCHOOLS.elementary.id)?.launches >= 1);
  // Sharing never widens record access: the middle-school principal still cannot read elementary students.
  assert.equal((await S.principalMiddle.call("GET", `/api/students/${STUDENTS.ava.id}`)).status, 404);
  const mine = (await S.principalMiddle.ok("GET", `/api/apps/${appByName("MathQuest").id}/usage`)).data;
  assert.equal(mine.scope, "my_school"); assert.ok(mine.bySchool.every(s => s.schoolId === SCHOOLS.middle.id));
});
await step("LTI 1.3 launch: the tool verifies the district-signed id_token", async () => {
  const tool = spawn(process.execPath, [new URL("./lti-tool.js", import.meta.url).pathname], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise((ok, bad) => { tool.stdout.once("data", ok); tool.once("exit", c => bad(new Error(`lti-tool exited ${c}`))); });
    const l = await S.teacher.ok("POST", `/api/apps/${appByName("Science Lab (LTI demo)").id}/launch`);
    const login = new URL(l.data.url); assert.equal(login.origin, LTI_TOOL_ORIGIN); assert.equal(login.searchParams.get("iss"), BASE);
    const toAuth = await fetch(login, { redirect: "manual" }); assert.equal(toAuth.status, 302);
    const authorize = new URL(toAuth.headers.get("location")); assert.equal(authorize.origin, BASE);
    const form = await S.teacher.call("GET", authorize.pathname + authorize.search);
    assert.equal(form.status, 200, String(form.body).slice(0, 200));
    const field = n => String(form.body).match(new RegExp(`name="${n}" value="([^"]*)"`))?.[1];
    const posted = await fetch(`${LTI_TOOL_ORIGIN}/launch`, { method: "POST", body: new URLSearchParams({ id_token: field("id_token"), state: field("state") }) });
    const page = await posted.text(); assert.equal(posted.status, 200, page.slice(0, 300)); assert.match(page, /data-lti-verified="true"/);
    // The hint is single-use.
    assert.notEqual((await S.teacher.call("GET", authorize.pathname + authorize.search)).status, 200);
  } finally { tool.kill(); }
});
await step("principal requests an app; the district approves it", async () => {
  const req = await S.principal.ok("POST", "/api/app-requests", { name: `Smoke Atlas ${RUN}`, vendor: "Maps Co", url: "https://atlas.example", reason: "Grade 4 geography unit" });
  const pending = (await S.supt.ok("GET", "/api/app-requests?status=pending")).data;
  assert.ok(pending.some(r => r.id === req.data.id));
  await S.supt.ok("PATCH", `/api/app-requests/${req.data.id}`, { decision: "approved", note: "Added to next year's budget" });
  const after = (await S.principal.ok("GET", "/api/app-requests")).data.find(r => r.id === req.data.id);
  assert.equal(after.status, "approved");
});
await step("role homes: grade-1 learner gets the simplified home; the guardian sees child cards", async () => {
  const young = await signedIn(USERS.pupilYoung.sub, "young-pupil");
  assert.equal((await young.ok("GET", "/api/home")).data.youngLearner, true);
  assert.equal((await young.ok("GET", "/api/my/apps")).learner.youngLearner, true);
  assert.equal((await S.pupil.ok("GET", "/api/home")).data.youngLearner, false);
  const fam = (await S.parent.ok("GET", "/api/home")).data;
  assert.ok(fam.children.some(c => c.id === STUDENTS.ava.id || c.student_id === STUDENTS.ava.id));
  for (const s of [S.supt, S.principal, S.teacher]) assert.equal((await s.call("GET", "/api/home")).status, 200);
});
await step("school branding: design, AA gate, sanitized upload, publish, every audience sees it, restore", async () => {
  const E = SCHOOLS.elementary.id, M = SCHOOLS.middle.id;
  const before = (await S.principal.ok("GET", `/api/branding/${E}`)).data;
  const live = before.published?.version;
  assert.ok(live, "seeded branding is published");
  assert.equal((await S.principal.call("PUT", `/api/branding/${M}/draft`, { motto: "x" })).status, 403, "principal cannot brand another school");
  assert.equal((await S.teacher.call("PUT", `/api/branding/${E}/draft`, { motto: "x" })).status, 403, "teachers cannot edit");
  const bad = await S.principal.ok("PUT", `/api/branding/${E}/draft`, { motto: `Smoke ${RUN}`, tiles: { preset: "custom", base: { bg: "accent", labelColor: "#ffffff" }, overrides: {} } });
  assert.equal(bad.data.contrast.summary.ok, false);
  const blocked = await S.principal.call("POST", `/api/branding/${E}/publish`);
  assert.equal(blocked.status, 422); assert.equal(blocked.body.error, "contrast_failed");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" onload="alert(1)"><script>alert(1)</script><circle cx="32" cy="32" r="30" fill="#1b4f8a"/></svg>`;
  const up = await S.principal.raw("POST", `/api/branding/${E}/mascot`, { headers: { "content-type": "image/svg+xml" }, body: undefined });
  assert.equal(up.status, 422, "an empty upload is refused");
  const res = await fetch(`${BASE}/api/branding/${E}/mascot`, { method: "POST", headers: { cookie: S.principal.cookie(), "x-csrf-token": S.principal.csrf, "content-type": "image/svg+xml" }, body: svg });
  const upBody = await res.json(); assert.equal(res.status, 201, JSON.stringify(upBody)); assert.ok(upBody.data.removed.includes("<script>"));
  await S.principal.ok("PUT", `/api/branding/${E}/draft`, { tiles: before.published.tiles });
  const pub = await S.principal.ok("POST", `/api/branding/${E}/publish`);
  for (const s of [S.teacher, S.pupil, S.parent]) {
    const cur = (await s.ok("GET", "/api/branding/current")).data;
    assert.equal(cur.branding.motto, `Smoke ${RUN}`, `${s.label} sees the new version`);
    assert.equal(cur.branding.mascotUploadId, upBody.data.uploadId);
  }
  const pubJson = await (await fetch(`${BASE}/api/public/branding/${DISTRICT.id}/${E}`)).json();
  assert.equal(pubJson.data.schoolName, SCHOOLS.elementary.name);
  const icon = await fetch(`${BASE}/api/public/branding/${DISTRICT.id}/${E}/icon-192.png`);
  assert.equal(icon.status, 200); assert.equal(icon.headers.get("content-type"), "image/png");
  const man = await (await fetch(`${BASE}/api/public/branding/${DISTRICT.id}/${E}/manifest.webmanifest`)).json();
  assert.equal(man.icons.length, 2);
  // Put the seeded design back (restore + publish), so repeated runs keep the demo look.
  await S.principal.ok("POST", `/api/branding/${E}/restore`, { version: live });
  const again = await S.principal.ok("POST", `/api/branding/${E}/publish`);
  assert.ok(again.data.version > pub.data.version);
  assert.equal((await S.pupil.ok("GET", "/api/branding/current")).data.branding.mascotName, "Otters");
  const audit = (await S.supt.ok("GET", "/api/audit?limit=250")).data;
  assert.ok(audit.some(a => a.resource_type === "branding" && a.action === "publish"));
});
// ---- 32.4.0: mobile role apps, transport, Christie, Comms Hub ----
await step("mobile app shell: /app/ is served by the edge with its manifest and service worker", async () => {
  const r = await fetch(`${BASE}/app/`); const html = await r.text();
  assert.equal(r.status, 200); assert.match(html, /EduOS Mobile/); assert.match(html, /\/app\/app\.js/);
  assert.match(r.headers.get("content-security-policy") || "", /default-src 'self'/);
  const deep = await fetch(`${BASE}/app/route`); assert.equal(deep.status, 200); assert.match(await deep.text(), /EduOS Mobile/);
  const m = await (await fetch(`${BASE}/app/manifest.webmanifest`)).json(); assert.equal(m.scope, "/app/");
  assert.match(await (await fetch(`${BASE}/app/sw.js`)).text(), /never caches/);
  const branded = await (await fetch(`${BASE}/api/public/branding/${DISTRICT.id}/${SCHOOLS.elementary.id}/manifest.webmanifest?app=mobile`)).json();
  assert.match(branded.start_url, /^\/app\/\?school=/); assert.equal(branded.background_color, "#0b0f19");
});
await step("driver: signs in to the mobile app, starts the run, checks a rider ON BOARD; location data is refused", async () => {
  const d = new Session("driver"); const r = await d.signIn(USERS.driver.sub); assert.equal(r.status, 303);
  S.driver = d;
  const today = (await d.ok("GET", "/api/transport/today")).data;
  assert.ok(today.routes.length >= 2, "two seeded routes");
  const am = today.routes.find(x => x.direction === "am");
  const run = (await d.ok("POST", "/api/transport/runs", { routeId: am.id })).data;
  const stop = am.stops.find(st => (st.riders || []).some(x => x.studentId === STUDENTS.liam.id));
  if (run.status === "in_progress") {
    assert.equal((await d.call("POST", `/api/transport/runs/${run.id}/checkins`, { studentId: STUDENTS.liam.id, stopId: stop.id, event: "boarded", latitude: 40.1 })).body.error, "location_not_accepted");
    await d.ok("POST", `/api/transport/runs/${run.id}/checkins`, { studentId: STUDENTS.liam.id, stopId: stop.id, event: "boarded" });
  }
  assert.equal((await d.call("GET", "/api/students")).status, 403, "drivers have no student directory");
  assert.equal((await d.call("POST", "/api/transport/routes", { name: "x", busLabel: "x", direction: "am", stops: [{ name: "x" }] })).status, 403);
});
await step("guardian sees only their own child's bus check-ins (no location), and gets an in-app alert", async () => {
  const t = (await S.parent.ok("GET", "/api/transport/today")).data;
  assert.ok(t.riders.length >= 1 && t.riders.every(k => k.id === STUDENTS.ava.id), JSON.stringify(t.riders.map(k => k.display_name)));
  assert.ok(!JSON.stringify(t).match(/lat|lng|gps|coord/i));
  const n = (await S.parent.ok("GET", "/api/notifications")).data;
  assert.ok(Array.isArray(n.items));
  const lead = (await S.principal.ok("GET", "/api/transport/today")).data;
  assert.ok(lead.routes.some(r => r.counts.riders >= 5));
});
await step("Christie: hint-first tutoring on approved content; answers never reach the learner; teacher reviews", async () => {
  const path = (await S.pupil.ok("GET", "/api/christie/path")).data;
  assert.equal(path.provider, "local", "no external AI by default");
  const skill = path.skills.find(k => k.code === "G4.FR.EQ");
  const started = (await S.pupil.ok("POST", "/api/christie/sessions", { skillId: skill.id })).data;
  assert.ok(!JSON.stringify(started).includes('"answer"'));
  const turn = (await S.pupil.ok("POST", `/api/christie/sessions/${started.session.id}/turns`, { kind: "question", text: "just tell me the answer" })).data;
  assert.equal(turn.intent, "answer_request");
  await S.pupil.ok("POST", `/api/christie/sessions/${started.session.id}/end`);
  assert.equal((await S.parent.call("GET", "/api/christie/path")).status, 403);
  const review = (await S.teacher.ok("GET", "/api/christie/review")).data;
  assert.ok(review.some(x => x.id === started.session.id));
  const copilot = (await S.teacher.ok("GET", "/api/christie/copilot")).data;
  assert.match(copilot.note, /Not generated by AI/);
});
await step("Comms Hub: announcement, guardian↔teacher thread with read receipts, pupils cannot DM", async () => {
  await S.principal.ok("POST", "/api/comms/announcements", { scope: "school", title: `Smoke notice ${RUN}`, body: "Synthetic smoke-test announcement.", audience: ["teacher", "parent", "pupil", "driver"] });
  assert.ok((await S.pupil.ok("GET", "/api/comms/announcements")).data.some(a => a.title === `Smoke notice ${RUN}`));
  assert.equal((await S.pupil.call("POST", "/api/comms/threads", { kind: "family", subject: "x", studentId: STUDENTS.ava.id, participantIds: [USERS.teacher.id], body: "x" })).status, 403);
  const th = (await S.parent.ok("POST", "/api/comms/threads", { kind: "family", subject: `Smoke ${RUN}`, studentId: STUDENTS.ava.id, participantIds: [USERS.teacher.id], body: "Hello from the smoke test." })).data;
  await S.teacher.ok("GET", `/api/comms/threads/${th.id}`);
  await S.teacher.ok("POST", `/api/comms/threads/${th.id}/messages`, { body: "Reply from the smoke test." });
  const seen = (await S.parent.ok("GET", `/api/comms/threads/${th.id}`)).data;
  assert.equal(seen.messages[0].read_by[0].userId, USERS.teacher.id);
  assert.equal((await S.driver.call("GET", `/api/comms/threads/${th.id}`)).status, 404);
});
await step("car pick-up: pass verify + ID check releases; custody order needs acknowledgement; do-not-release blocks", async () => {
  for (const i of (await S.principal.ok("GET", "/api/safety/status")).data.incidents.filter(x => ["active", "reunification"].includes(x.status)))
    await S.principal.ok("POST", `/api/safety/incidents/${i.id}/all-clear`, { kind: i.kind }); // leftover from an interrupted run
  let fam = (await S.parent.ok("GET", "/api/pickup/family")).data;
  for (const a of fam.children.flatMap(k => k.adults).filter(x => x.full_name.startsWith("Smoke Neighbor ")))
    await S.parent.ok("POST", `/api/pickup/adults/${a.id}/revoke`); // leftovers from an interrupted run
  fam = (await S.parent.ok("GET", "/api/pickup/family")).data;
  assert.ok(JSON.stringify(fam).includes("Ruth Morgan") && !JSON.stringify(fam).includes("Noah"), "parent sees only their own child's adults");
  assert.equal((await S.pupil.call("GET", "/api/pickup/family")).status, 403);
  const add = (await S.parent.ok("POST", "/api/pickup/adults", { studentId: STUDENTS.ava.id, fullName: `Smoke Neighbor ${RUN}`, relationship: "Neighbor" })).data;
  assert.equal(add.status, "pending");
  assert.equal((await S.parent.call("POST", "/api/pickup/tags", { adultId: add.id })).status, 409, "no pass before school approval");
  await S.principal.ok("POST", `/api/pickup/adults/${add.id}/decision`, { decision: "approve" });
  const pass = (await S.parent.ok("POST", "/api/pickup/tags", { adultId: add.id })).data;
  assert.match(pass.code, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/); assert.ok(Array.isArray(pass.qr) && pass.qr.length >= 21);
  const v = (await S.teacher.ok("POST", "/api/pickup/verify", { code: pass.code.toLowerCase() })).data;
  assert.ok(v.students[0].eligible && v.adult.name === `Smoke Neighbor ${RUN}`);
  assert.equal((await S.teacher.call("POST", "/api/pickup/release", { code: pass.code, studentIds: [STUDENTS.ava.id] })).body.error, "photo_id_check_required");
  await S.teacher.ok("POST", "/api/pickup/release", { code: pass.code, studentIds: [STUDENTS.ava.id], idChecked: true });
  const custody = (await S.teacher.ok("POST", "/api/pickup/verify", { code: "CHR1S-N0AH7" })).data;
  assert.ok(custody.students[0].eligible && custody.students[0].custodyOrder);
  assert.equal((await S.teacher.call("POST", "/api/pickup/release", { code: "CHR1S-N0AH7", studentIds: [STUDENTS.noah.id], idChecked: true })).body.error, "custody_order_acknowledgement_required");
  await S.teacher.ok("POST", "/api/pickup/release", { code: "CHR1S-N0AH7", studentIds: [STUDENTS.noah.id], idChecked: true, custodyAcknowledged: true });
  const blocked = (await S.teacher.ok("POST", "/api/pickup/verify", { code: "PATB7-N0AH5" })).data;
  assert.equal(blocked.blocked, true); assert.equal(blocked.students[0].reason, "do_not_release");
  assert.equal((await S.teacher.call("POST", "/api/pickup/release", { code: "PATB7-N0AH5", studentIds: [STUDENTS.noah.id], idChecked: true, custodyAcknowledged: true })).body.error, "release_blocked");
  assert.equal((await S.teacher.call("POST", "/api/pickup/verify", { code: "ZZZZZ-ZZZZZ" })).status, 404);
  assert.equal((await S.driver.call("POST", "/api/pickup/verify", { code: "RTHM2-AVA4K" })).status, 403);
  const q = (await S.teacher.ok("GET", "/api/pickup/queue")).data;
  assert.ok(q.released.some(e => e.student_id === STUDENTS.ava.id || e.studentId === STUDENTS.ava.id), JSON.stringify(q).slice(0, 200));
  const adm = (await S.principal.ok("GET", "/api/pickup/admin")).data;
  assert.ok(JSON.stringify(adm).includes("Protective order"), "leads see restrictions");
  assert.ok(!JSON.stringify(await S.teacher.call("GET", "/api/pickup/admin")).includes("Protective order"));
  await S.parent.ok("POST", `/api/pickup/adults/${add.id}/revoke`);
});
await step("SafetyOS: two-step drill start, every role sees it, roll call, board, reunification release, all clear", async () => {
  assert.equal((await S.pupil.call("POST", "/api/safety/incidents", { kind: "hold", isDrill: true })).status, 403);
  assert.equal((await S.teacher.call("POST", "/api/safety/incidents", { kind: "threat", isDrill: true })).status, 400);
  const inc = (await S.teacher.ok("POST", "/api/safety/incidents", { kind: "hold", isDrill: true, notes: "Smoke drill" })).data;
  assert.equal(inc.status, "pending");
  assert.equal((await S.pupil.ok("GET", "/api/safety/status")).data.incidents.length, 0, "pending is not broadcast");
  assert.equal((await S.teacher.call("POST", `/api/safety/incidents/${inc.id}/confirm`, { kind: "hold", isDrill: false })).status, 400, "drill flag must be repeated");
  const live = (await S.teacher.ok("POST", `/api/safety/incidents/${inc.id}/confirm`, { kind: "hold", isDrill: true })).data;
  assert.equal(live.status, "active");
  assert.equal((await S.principal.call("POST", "/api/safety/incidents", { kind: "lockdown", isDrill: true })).status, 409, "one live incident per school");
  for (const who of ["pupil", "driver", "parent"]) {
    const st = (await S[who].ok("GET", "/api/safety/status")).data.incidents.find(i => i.id === inc.id);
    assert.ok(st && st.isDrill && st.message, `${who} sees the incident`);
    assert.ok(!JSON.stringify(st).match(/missing|injured|Smoke drill/i), `${who} gets no roll call or staff notes`);
  }
  assert.equal((await S.parent.call("GET", `/api/safety/incidents/${inc.id}/board`)).status, 403);
  assert.equal((await S.parent.call("GET", `/api/safety/incidents/${inc.id}/rollcall`)).status, 403);
  const roster = (await S.teacher.ok("GET", `/api/safety/incidents/${inc.id}/rollcall`)).data;
  const kids = roster.learners;
  assert.ok(kids.length >= 4, JSON.stringify(roster).slice(0, 200));
  const id = k => k.studentId || k.id;
  const entries = kids.map((k, n) => ({ studentId: id(k), status: n === 0 ? "missing" : "present" }));
  assert.equal((await S.teacher.call("POST", `/api/safety/incidents/${inc.id}/rollcall`, { entries: [{ studentId: STUDENTS.mia.id, status: "present" }] })).body.error, "not_on_roster");
  await S.teacher.ok("POST", `/api/safety/incidents/${inc.id}/rollcall`, { entries: [...entries, { studentId: STUDENTS.mia.id, status: "extra" }] });
  await S.teacher.ok("POST", `/api/safety/incidents/${inc.id}/rollcall`, { entries: [{ studentId: id(kids[0]), status: "present", note: "Found in library" }] });
  const board = (await S.principal.ok("GET", `/api/safety/incidents/${inc.id}/board`)).data;
  assert.equal(board.totals.missing, 0, "latest report wins"); assert.ok(board.totals.present >= 4 && board.totals.extra === 1);
  assert.equal((await S.teacher.call("GET", `/api/safety/incidents/${inc.id}/board`)).status, 403);
  assert.equal((await S.teacher.ok("POST", "/api/pickup/verify", { code: "RTHM2-AVA4K" })).data.students[0].reason, "safety_incident_live", "releases pause while active");
  await S.principal.ok("POST", `/api/safety/incidents/${inc.id}/events`, { event: "responders" });
  await S.principal.ok("POST", `/api/safety/incidents/${inc.id}/reunification`, { point: "Gym, east doors" });
  const fam = (await S.parent.ok("GET", "/api/safety/status")).data.incidents.find(i => i.id === inc.id);
  assert.equal(fam.status, "reunification"); assert.deepEqual(fam.children.map(c => c.name), ["Ava Morgan"]);
  await S.teacher.ok("POST", "/api/pickup/release", { code: "RTHM2-AVA4K", studentIds: [STUDENTS.ava.id], idChecked: true });
  const after = (await S.parent.ok("GET", "/api/safety/status")).data.incidents.find(i => i.id === inc.id);
  assert.match(after.children[0].released?.adult || "", /Ruth Morgan/);
  assert.equal((await S.principal.ok("GET", `/api/safety/incidents/${inc.id}/board`)).data.totals.released, 1);
  assert.equal((await S.principal.call("POST", `/api/safety/incidents/${inc.id}/all-clear`, { kind: "lockdown" })).status, 400);
  await S.principal.ok("POST", `/api/safety/incidents/${inc.id}/all-clear`, { kind: "hold" });
  assert.equal((await S.pupil.ok("GET", "/api/safety/status")).data.incidents.length, 0);
  await S.principal.ok("POST", `/api/safety/incidents/${inc.id}/debrief`, { text: "Smoke drill: all accounted for; one learner found in the library." });
  const hist = (await S.principal.ok("GET", "/api/safety/incidents")).data;
  assert.ok(hist.some(i => i.id === inc.id && i.debrief) && hist.some(i => i.debrief?.includes("Room 12")), "history includes the seeded drill");
  const n = (await S.parent.ok("GET", "/api/notifications")).data.items.filter(x => x.kind === "safety");
  assert.ok(n.length >= 2 && n.every(x => !/missing|injured|Noah|Liam|Sofia/.test(`${x.title} ${x.body || ""}`)), "family notices are generic");
});
await step("32.6 learning: courses, key secrecy, family progress, sources only from real archives, EDAL verify + proof + CLI", async () => {
  const mine = (await S.pupil.ok("GET", "/api/learning/courses")).data.courses;
  const math = mine.find(c => c.title === "Grade 4 Math: Fractions");
  assert.ok(math && !mine.some(c => c.title === "Grade 3 Math"), "active courses only");
  const course = (await S.pupil.ok("GET", `/api/learning/courses/${math.id}`)).data;
  const quiz = course.assignments.find(a => a.kind === "quiz");
  const q = (await S.pupil.ok("GET", `/api/learning/assignments/${quiz.id}`)).data;
  assert.ok(!("items" in q) && !JSON.stringify(q).includes("answerKey"), "learners never get quiz keys up front");
  assert.equal((await S.pupil.call("GET", `/api/learning/courses/${math.id}/gradebook`)).status, 403);
  const kids = (await S.parent.ok("GET", "/api/learning/progress")).data.children;
  assert.deepEqual(kids.map(k => k.id), [STUDENTS.ava.id]);
  const prog = (await S.parent.ok("GET", `/api/learning/progress?studentId=${STUDENTS.ava.id}`)).data;
  assert.ok(prog.finalGrades.length >= 1 && prog.credentials.length >= 1);
  assert.equal((await S.parent.call("GET", `/api/learning/progress?studentId=${STUDENTS.noah.id}`)).status, 403);
  const bad = await S.teacher.call("POST", "/api/learning/sources", { title: "Made-up letter", archive: "Library of Congress", url: "https://example.com/fake", rights: "Public domain", description: "Not real", kind: "letter" });
  assert.equal(bad.status, 400, "only loc.gov / archives.gov links");
  const v = (await S.principal.ok("GET", "/api/edal/verify")).data;
  assert.equal(v.ok, true); assert.match(v.statement, /not a blockchain/);
  const proof = (await S.parent.ok("GET", `/api/edal/records/${prog.finalGrades[0].edal_entry_id}`)).data;
  assert.equal(proof.ok, true);
  assert.equal((await S.teacher.call("GET", "/api/edal/verify")).status, 403);
  assert.equal((await S.principal.call("GET", "/api/edal/export")).status, 403, "export is district-only");
  if (process.env.EDUOS_RETENTION) {
    // exits non-zero (and execSync throws) if any district's chain fails
    const out = execSync(`${process.env.EDUOS_RETENTION} node src/edal-verify.js`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.match(out, /OK +district/); assert.doesNotMatch(out, /FAIL/);
  }
});
await step("disabling a membership ends that access on the next request", async () => {
  const users = (await S.supt.ok("GET", "/api/users")).data;
  const m = users.find(u => u.id === newTeacher.id).memberships.find(x => x.schoolId === SCHOOLS.elementary.id);
  await S.supt.ok("PATCH", `/api/memberships/${m.id}`, { status: "disabled" });
  assert.equal((await S.newTeacher.call("GET", "/api/me")).status, 401);
  await S.supt.ok("PATCH", `/api/users/${newTeacher.id}`, { status: "disabled" });
  const again = new Session("disabled"); assert.equal((await again.signIn(`smoke-teacher-${RUN}`)).status, 403);
});
await step("metrics endpoint (internal, bearer token)", async () => {
  const token = process.env.METRICS_TOKEN;
  const out = internal(`fetch("http://127.0.0.1:8080/metrics",{headers:{authorization:"Bearer ${token}"}}).then(async r=>process.stdout.write(r.status+"\\n"+await r.text()))`);
  if (out === null) return console.log("    (skipped: EDUOS_INTERNAL not set)");
  assert.match(out, /^200\n/); assert.match(out, /eduos_http_requests_total\{method="GET",route="\/api\/students",status="2xx"\}/);
  const denied = internal(`fetch("http://127.0.0.1:8080/metrics").then(r=>process.stdout.write(String(r.status)))`);
  assert.equal(denied.trim(), "401");
  assert.equal((await fetch(`${BASE}/metrics`)).status !== 200 || !(await (await fetch(`${BASE}/metrics`)).text()).includes("eduos_http"), true, "edge does not expose metrics");
});
await step("retention job runs as the owner role", async () => {
  if (!process.env.EDUOS_RETENTION) return console.log("    (skipped: EDUOS_RETENTION not set)");
  const out = execSync(process.env.EDUOS_RETENTION, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const json = JSON.parse(out.trim().split("\n").filter(l => l.startsWith("{")).pop());
  assert.ok(json.districts && json.sessions, out);
});
await step("logout revokes the session", async () => {
  await S.supt.ok("POST", "/auth/logout", undefined, [204]);
  assert.equal((await S.supt.call("GET", "/api/me")).status, 401);
});
summary();
