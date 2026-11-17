// 37.6.0 enrollment funnel: pure model, migration wiring and UI wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as M from "../src/enrollment-model.js";
import { ROLE_PERMISSIONS } from "../src/policy.js";

const sql = fs.readFileSync(new URL("../db/059_enrollment_funnel.sql", import.meta.url), "utf8");
const grants = fs.readFileSync(new URL("../db/runtime_grants.template.sql", import.meta.url), "utf8");
const migrate = fs.readFileSync(new URL("../src/migrate.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../public/app/app.js", import.meta.url), "utf8");

test("families can only submit, send to review, and answer an offer", () => {
  assert.deepEqual(M.nextActions("inquiry", { family: true }), ["applied", "withdrawn"]);
  assert.deepEqual(M.nextActions("offered", { family: true }), ["accepted", "declined", "withdrawn"]);
  assert.equal(M.canTransition("review", "offered", { family: true }), false);
  assert.equal(M.canTransition("accepted", "enrolled", { family: true }), false);
  assert.equal(M.canTransition("waitlisted", "withdrawn", { family: true }), true);
});
test("staff follow the funnel; terminal states stay terminal", () => {
  assert.equal(M.canTransition("review", "offered"), true);
  assert.equal(M.canTransition("applied", "offered"), false, "no offer without review");
  for (const t of M.TERMINAL) assert.deepEqual(M.nextActions(t), [], t);
  assert.deepEqual(M.STAGES, ["inquiry", "applied", "documents", "review", "offered", "accepted", "enrolled"]);
});
test("the SQL status machine matches the model for every pair", () => {
  // Parse eduos_enrollment_transition_ok's lists and compare with the model.
  const body = sql.slice(sql.indexOf("FUNCTION eduos_enrollment_transition_ok"), sql.indexOf("CREATE FUNCTION eduos_enrollment_guard"));
  const pairs = s => [...s.matchAll(/\('([a-z]+)','([a-z]+)'\)/g)].map(m => `${m[1]}>${m[2]}`).sort();
  const fam = body.slice(body.indexOf("WHEN p_family"), body.indexOf("ELSE"));
  const staff = body.slice(body.indexOf("ELSE"));
  const model = family => M.STATUSES.flatMap(a => M.STATUSES.filter(b => b !== "withdrawn" && M.canTransition(a, b, { family })).map(b => `${a}>${b}`)).sort();
  assert.deepEqual(pairs(fam), model(true));
  assert.deepEqual(pairs(staff), model(false));
});
test("seat state and document checks", () => {
  assert.deepEqual(M.seatState({ seats: null, committed: 3 }), { available: null, full: false });
  assert.deepEqual(M.seatState({ seats: 2, committed: 2 }), { available: 0, full: true });
  assert.equal(M.sniffDocument(Buffer.from("%PDF-1.7 xxxx")), "application/pdf");
  assert.equal(M.sniffDocument(Buffer.from("<script>alert(1)</script>")), null);
  const f = M.safeFilename("../../etc/passwd.exe", "application/pdf");
  assert.ok(f.endsWith(".pdf") && !f.includes("/") && !f.startsWith("."), f);
  assert.ok(!M.safeFilename("../../x.html", "image/png").includes("/"));
  assert.ok(M.safeFilename("a\"b.pdf", "application/pdf").endsWith(".pdf"));
});
test("migration 059 is registered, RLS-forced, append-only history, purge-chained", () => {
  assert.match(migrate, /"059_enrollment_funnel\.sql"/);
  for (const t of ["enrollment_capacity", "enrollment_applications", "enrollment_events", "enrollment_documents"]) assert.match(sql, new RegExp(`'${t}'`));
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /enrollment_events[\s\S]*reject_append_only_mutation/);
  assert.match(sql, /RENAME TO eduos_purge_student_pre_enrollment/);
  assert.match(sql, /CREATE FUNCTION eduos_retention_feature_enrollment\(p jsonb\)/);
  assert.match(grants, /REVOKE UPDATE, DELETE, TRUNCATE ON enrollment_events FROM eduos_app/);
  assert.match(grants, /REVOKE ALL ON FUNCTION eduos_purge_student_pre_enrollment\(uuid\), eduos_retention_feature_enrollment\(jsonb\) FROM eduos_app/);
  assert.doesNotMatch(grants, /GRANT[^;]*DELETE[^;]*enrollment_/);
});
test("only parents apply; only principals and superintendents manage", () => {
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    assert.equal((perms.enrollment || []).includes("apply"), role === "parent", role);
    assert.equal((perms.enrollment || []).includes("manage"), ["principal", "superintendent"].includes(role), role);
  }
});
test("the app has the family view and the leaders' board", () => {
  assert.match(app, /SUBVIEWS\.push\("enroll", "enrollboard", "enrollapp"\)/);
  for (const v of ["enroll", "enrollboard", "enrollapp"]) assert.match(app, new RegExp(`VIEWS\\.${v} = async`));
});
