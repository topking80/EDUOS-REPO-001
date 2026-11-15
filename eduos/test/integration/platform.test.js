// EduOS 32.1.0 platform flows against a real PostgreSQL server, running as the
// non-owner runtime role: administration API (with the new column grants),
// SIS CSV import, assignment drafts and immediate access revocation.
// Run: EDUOS_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres npm run test:integration
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("EduOS 32.1.0 platform flows against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {};
  const as = name => client(server.base, s[name]);
  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "p1", "p2", "t1", "pu", "vp1"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("db:bootstrap creates a district and its first superintendent, idempotently", async () => {
    const args = ["src/bootstrap-district.js", "--district", "Lakeside Public Schools", "--sub", "lakeside-supt", "--name", "Lee Lakeside", "--email", "lee@lakeside.test"];
    const env = { ...baseEnv({ OIDC_ISSUER: idp.issuer }), DATABASE_URL: db.ownerUrl };
    const first = await run(args, env);
    assert.equal(first.code, 0, first.out); assert.match(first.out, /Created district .* provisioned/);
    const again = await run(args, env);
    assert.equal(again.code, 0, again.out); assert.match(again.out, /Using existing district .* was already provisioned/);
    const sess = await login(server.base, idp, "lakeside-supt", { email_verified: true });
    const me = (await client(server.base, sess)("GET", "/api/me")).body;
    assert.equal(me.role, "superintendent");
    assert.notEqual(me.districtId, ID.d1);
    assert.equal((await client(server.base, sess)("GET", "/api/students")).body.data.length, 0, "a new district starts empty");
    const steal = await run(["src/bootstrap-district.js", "--district", "Lakeside Public Schools", "--sub", "supt1", "--name", "X", "--email", "x@x.test"], env);
    assert.notEqual(steal.code, 0); assert.match(steal.out, /another district/);
  });

  it("superintendent creates and renames a school; duplicates and principals are refused", async () => {
    const created = await as("supt1")("POST", "/api/schools", { name: "North High", schoolLevel: "high" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await as("supt1")("POST", "/api/schools", { name: "north high" })).status, 409);
    assert.equal((await as("p1")("POST", "/api/schools", { name: "Rogue School" })).status, 403);
    const renamed = await as("supt1")("PATCH", `/api/schools/${created.body.data.id}`, { name: "North High School", status: "inactive" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    const listed = await as("supt1")("GET", "/api/schools");
    assert.equal(listed.body.data.find(x => x.id === created.body.data.id)?.status, "inactive");
  });

  it("provisioned users can sign in; principals are limited to their school and to non-leadership roles", async () => {
    const t = await as("supt1")("POST", "/api/users", { displayName: "New Teacher", email: "new.teacher@d1.test", oidcSubject: "new-teacher", role: "teacher", schoolId: ID.s1 });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    const sess = await login(server.base, idp, "new-teacher", { email_verified: true });
    assert.ok(sess.cookie, "provisioned teacher signs in");
    assert.equal((await client(server.base, sess)("GET", "/api/me")).body.role, "teacher");

    assert.equal((await as("p1")("POST", "/api/users", { displayName: "Fam", email: "fam@d1.test", oidcSubject: "fam-1", role: "parent", schoolId: ID.s1 })).status, 201);
    assert.equal((await as("p1")("POST", "/api/users", { displayName: "X", email: "x@d1.test", oidcSubject: "x-1", role: "teacher", schoolId: ID.s2 })).status, 403);
    assert.equal((await as("p1")("POST", "/api/users", { displayName: "X", email: "x@d1.test", oidcSubject: "x-2", role: "principal", schoolId: ID.s1 })).status, 403);
    assert.equal((await as("t1")("GET", "/api/users")).status, 403);

    const mine = await as("p1")("GET", "/api/users");
    assert.equal(mine.status, 200);
    assert.ok(mine.body.data.every(u => u.memberships.every(m => m.schoolId === ID.s1)), "principal sees only their school");
    assert.ok(mine.body.data.every(u => u.oidcSubject === undefined), "principal does not see sign-in subjects");
    const all = await as("supt1")("GET", "/api/users");
    assert.ok(all.body.data.some(u => u.oidcSubject === "new-teacher"));
    assert.ok(!all.body.data.some(u => u.oidcSubject === "supt2"), "other districts are invisible");

    // An identity already provisioned in another district cannot be claimed.
    const elsewhere = await as("supt1")("POST", "/api/users", { displayName: "Hijack", email: "h@d1.test", oidcSubject: "supt2", role: "teacher", schoolId: ID.s1 });
    assert.equal(elsewhere.status, 409); assert.equal(elsewhere.body.error, "identity_provisioned_in_another_district");
    assert.equal((await as("supt1")("PATCH", `/api/users/${USERS.supt2[0]}`, { status: "disabled" })).status, 404);
  });

  it("disabling a membership or an account takes effect on the next request", async () => {
    const created = await as("supt1")("POST", "/api/users", { displayName: "Temp", email: "temp@d1.test", oidcSubject: "temp-1", role: "teacher", schoolId: ID.s1 });
    const sess = await login(server.base, idp, "temp-1", { email_verified: true });
    assert.equal((await client(server.base, sess)("GET", "/api/me")).status, 200);
    assert.equal((await as("supt1")("PATCH", `/api/memberships/${created.body.data.membershipId}`, { status: "disabled" })).status, 200);
    assert.equal((await client(server.base, sess)("GET", "/api/me")).status, 401);
    assert.equal((await as("supt1")("PATCH", `/api/memberships/${created.body.data.membershipId}`, { status: "active" })).status, 200);
    const again = await login(server.base, idp, "temp-1", { email_verified: true });
    assert.equal((await client(server.base, again)("GET", "/api/me")).status, 200);
    assert.equal((await as("supt1")("PATCH", `/api/users/${created.body.data.id}`, { status: "disabled" })).status, 200);
    assert.equal((await client(server.base, again)("GET", "/api/me")).status, 401);
    assert.equal((await login(server.base, idp, "temp-1", { email_verified: true })).status, 403);
    const audited = await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE resource_type IN ('user','membership') AND resource_id=ANY($1)", [[created.body.data.id, created.body.data.membershipId]]);
    assert.ok(audited.rows[0].n >= 4);
  });

  it("the runtime role can create and update people but never delete them", async () => {
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await assert.rejects(app.query("DELETE FROM users WHERE false"), /permission denied/);
      await assert.rejects(app.query("DELETE FROM memberships WHERE false"), /permission denied/);
      await assert.rejects(app.query("UPDATE users SET oidc_subject='x' WHERE false"), /permission denied/);
    } finally { await app.end(); }
  });

  it("SIS CSV import: creates students and attendance, is idempotent and reports bad lines", async () => {
    const batch = {
      schoolId: ID.s1, sourceSystem: "csv-test", sourceBatchId: "b-1",
      studentsCsv: 'local_student_number,display_name,grade_level\r\nCSV-1,"Diaz, Rowan",5\r\n',
      attendanceCsv: "source_event_id,local_student_number,event_date,status\r\nev-1,CSV-1,2026-11-02,absent\r\n"
    };
    const r = await as("supt1")("POST", "/api/integrations/sis/import-csv", batch);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.studentsUpserted, 1); assert.equal(r.body.data.attendanceImported, 1);
    assert.equal((await as("supt1")("POST", "/api/integrations/sis/import-csv", batch)).status, 409);
    const bad = await as("supt1")("POST", "/api/integrations/sis/import-csv", { ...batch, sourceBatchId: "b-2", attendanceCsv: "source_event_id,local_student_number,event_date,status\nev-2,CSV-1,2026-02-31,absent\n" });
    assert.equal(bad.status, 400); assert.equal(bad.body.error, "csv_invalid_date"); assert.equal(bad.body.line, 2);
    assert.equal((await as("p2")("POST", "/api/integrations/sis/import-csv", { ...batch, sourceBatchId: "b-3" })).status, 403);
    const runs = await as("supt1")("GET", "/api/integrations/sis/runs");
    assert.ok(runs.body.data.some(x => x.source_batch_id === "b-1"));
    // JSON attendance with an impossible date is a 400, not a database error.
    assert.equal((await as("t1")("POST", "/api/attendance", { studentId: ID.alice, eventDate: "2026-02-30", status: "present" })).status, 400);
  });

  it("a vice principal reads their own school's attendance, and only theirs", async () => {
    assert.equal((await as("p1")("POST", "/api/attendance", { studentId: ID.bob, eventDate: "2026-11-03", status: "tardy" })).status, 201);
    assert.equal((await as("p2")("POST", "/api/attendance", { studentId: ID.carol, eventDate: "2026-11-03", status: "absent" })).status, 201);
    const r = await as("vp1")("GET", "/api/attendance?limit=500");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const names = new Set(r.body.data.map(e => e.display_name));
    assert.ok(names.has("Bob B"), "sees a learner at their school");
    assert.ok(!names.has("Carol C"), "never sees another school's learners");
    assert.equal(r.body.data.find(e => e.display_name === "Bob B" && e.event_date === "2026-11-03")?.status, "tardy");
  });

  it("assignments can be saved as drafts and published later; pupils only see published work", async () => {
    const draft = await as("t1")("POST", "/api/assignments", { title: "Draft essay", instructions: "tbd", status: "draft" });
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    const id = draft.body.data?.id || draft.body.id;
    const seen = async () => (await as("pu")("GET", "/api/assignments")).body.data.some(a => a.id === id);
    assert.equal(await seen(), false);
    assert.equal((await as("pu")("PATCH", `/api/assignments/${id}`, { status: "published" })).status, 403);
    assert.equal((await as("t1")("PATCH", `/api/assignments/${id}`, { status: "published" })).status, 200);
    assert.equal(await seen(), true);
    assert.ok([403, 404].includes((await as("p2")("PATCH", `/api/assignments/${id}`, { status: "closed" })).status), "another school's principal cannot change it");
  });
});
