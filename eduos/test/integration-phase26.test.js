import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const server=await readFile(new URL("../src/server.js",import.meta.url),"utf8");
const bridge=await readFile(new URL("../public/api-bridge.js",import.meta.url),"utf8");
const schema=await readFile(new URL("../db/001_initial.sql",import.meta.url),"utf8");
const learning=await readFile(new URL("../db/002_learning_workflows.sql",import.meta.url),"utf8");
const ui=(await readFile(new URL("../public/index.html",import.meta.url),"utf8")+await readFile(new URL("../public/legacy-app.js",import.meta.url),"utf8"));
const auth=await readFile(new URL("../src/auth.js",import.meta.url),"utf8");
test("uploaded Phase 25 UI and bridge are served together",()=>{
 assert.ok(ui.includes('src="/api-bridge.js"'));
});
test("tenant RLS SQL contains properly quoted district setting",()=>{
 assert.ok(schema.includes("current_setting(''app.district_id'', true)"));
 assert.ok(schema.includes("nullif(current_setting(''app.district_id'', true), '''')::uuid"));
 assert.ok(!schema.includes("current_setting(app.district_id"));
});
test("session is revalidated against active membership and district",()=>{
 assert.match(auth,/JOIN memberships m/); assert.match(auth,/JOIN districts d/);
 assert.ok(auth.includes("m.status='active'"));
});
test("learning schema has district RLS for assignments and submissions",()=>{
 assert.match(learning,/CREATE TABLE assignments/); assert.match(learning,/CREATE TABLE assignment_submissions/);
 assert.match(learning,/FORCE ROW LEVEL SECURITY/);
});
test("API endpoints cover profiles, assignment lifecycle and attendance",()=>{
 for(const route of ["/api/students/:studentId","/api/assignments","/api/assignments/:assignmentId/submit","/api/assignments/:assignmentId/submissions","/api/assignments/:assignmentId/submissions/:submissionId/grade","/api/attendance"])
  assert.ok(server.includes(route),route);
});
test("new mutation routes enforce CSRF and server permissions",()=>{
 assert.ok(server.includes('app.post("/api/assignments",requireSession,requireCsrf,requirePermission'));
 assert.ok(server.includes('app.post("/api/attendance",requireSession,requireCsrf,requirePermission'));
 assert.ok(server.includes('app.post("/api/assignments/:assignmentId/submit",requireSession,requireCsrf,requirePermission'));
});
test("school directory is scoped to district roles or own school",()=>{
 assert.ok(server.includes("WHERE ($1 IN ('superintendent','it_admin') OR id=$2)"));
});
test("frontend has authenticated workflow controls",()=>{
 for(const term of ["/api/me","/api/students","/api/assignments","/api/attendance","X-CSRF-Token",'data-form="assignment"','data-form="attendance"','data-action="submissions"'])
  assert.ok(bridge.includes(term),term);
});

test("attendance API date regex accepts ISO dates and rejects slash-form dates",async()=>{
 // 32.1.0: the regex moved into isCalendarDate(), which also rejects impossible dates.
 assert.ok(server.includes("!isCalendarDate(eventDate)"),"attendance API must validate eventDate with isCalendarDate");
 const {isCalendarDate}=await import("../src/csv.js");
 assert.equal(isCalendarDate("2026-11-08"),true);
 assert.equal(isCalendarDate("11/08/2026"),false);
 assert.equal(isCalendarDate("2026-02-30"),false);
});
test("parent attendance acknowledgement is event-specific and wired in UI",()=>{
 assert.ok(server.includes('/api/attendance/:eventId/acknowledge'));
 assert.ok(server.includes("WHERE id=$2 AND family_acknowledged_at IS NULL"));
 assert.ok(bridge.includes('data-action="acknowledge"'));
});

test("student relationship links require a same-district membership",()=>{
 assert.ok(schema.includes("UNIQUE(district_id,user_id)"));
 assert.ok(schema.includes("FOREIGN KEY(district_id,user_id) REFERENCES memberships(district_id,user_id)"));
});
test("CSP forbids inline script and handlers while blocking cross-origin framing",async()=>{
 const csp=await readFile(new URL("../src/csp.js",import.meta.url),"utf8");
 assert.ok(server.includes("contentSecurityPolicy: { directives: cspDirectives }"));
 assert.ok(csp.includes("scriptSrc: [\"'self'\"],"));
 assert.ok(csp.includes("scriptSrcAttr: [\"'none'\"]"));
 // 'self' lets the same-origin Vision Studio iframe load; other origins are blocked.
 assert.ok(csp.includes("frameAncestors: [\"'self'\"]"));
});

test("audit CSV uses real CRLF separators and neutralizes spreadsheet formulas",()=>{
 // 32.2.0: the export streams one CRLF-terminated line per row.
 assert.ok(server.includes(String.raw`join(",")+"\r\n"`));
 assert.ok(!server.includes(String.raw`join("\\r\\n")`));
 const match=server.match(/if\(\/([^/]+)\/\.test\(text\)\)/);
 assert.ok(match,"CSV formula guard must exist in server source");
 const formulaGuard=new RegExp(match[1]);
 assert.equal(formulaGuard.test("=1+1"),true);
 assert.equal(formulaGuard.test("  @SUM(A1:A2)"),true);
 assert.equal(formulaGuard.test("ordinary text"),false);
});
test("parent cannot submit pupil work under the Phase 25 role matrix",async()=>{
 const policy=await readFile(new URL("../src/policy.js",import.meta.url),"utf8");
 const parent=policy.slice(policy.indexOf("parent:"),policy.indexOf("pupil:"));
 assert.ok(parent.includes('assignments: ["read"]'));
 assert.ok(!parent.includes('"submit"'));
});
test("OIDC state is bound to the initiating browser cookie",async()=>{
 const auth=await readFile(new URL("../src/auth.js",import.meta.url),"utf8");
 assert.ok(auth.includes('serialize(oidcStateCookieName(state), state')); // per-attempt browser binding
 assert.ok(auth.includes('safeEqual(stateCookie, state)')); // constant-time browser binding
 assert.ok(auth.includes('res.append("Set-Cookie"'));
});

test("server audit CSV export is leadership permission-gated",()=>{
 assert.ok(server.includes('app.post("/api/audit/export",requireSession,requireCsrf,requirePermission("audit","export")'));
 assert.ok(bridge.includes("/api/audit/export")); assert.ok(bridge.includes("X-CSRF-Token"));
});

test("migration RLS format call has its argument separator",async()=>{
 const initial=await readFile(new URL("../db/001_initial.sql",import.meta.url),"utf8");
 assert.ok(initial.includes("::uuid)',\n      t"));
});
test("runtime database grants include attendance inserts",async()=>{
 const grants=await readFile(new URL("../db/runtime_grants.template.sql",import.meta.url),"utf8");
 assert.ok(grants.includes("GRANT INSERT, UPDATE ON attendance_events TO eduos_app;"));
});
