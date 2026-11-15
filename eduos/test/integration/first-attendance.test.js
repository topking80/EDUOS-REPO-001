// First attendance after a morning arrival (audit P1), against real
// PostgreSQL: only the staff member who received the student records it; a
// principal at that school can record it for them only as an override with a
// reason, kept in the append-only handoff log and the audit log.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("first attendance after an arrival handoff against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {};
  const as = name => client(server.base, s[name]);
  const arrive = async (studentId) => {
    const c = await as("p1")("POST", "/api/arrival/handoffs", { studentId, method: "walk_in", assignedTeacherUserId: USERS.t1[0] });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const r = await as("t1")("POST", `/api/arrival/handoffs/${c.body.data.id}/receive`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return c.body.data.id;
  };
  const first = (name, id, body = {}) => as(name)("POST", `/api/arrival/handoffs/${id}/first-attendance`, { status: "present", ...body });

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    // A second teacher at the school who also has Alice and Bob on their roster.
    await admin.query(`INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by)
      VALUES ($1,$2,$3,$4,$5),($1,$2,$3,$6,$5)`, [ID.d1, ID.s1, USERS.tp[0], ID.alice, USERS.p1[0], ID.bob]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "tp"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("only the receiving teacher records it, once", async () => {
    const id = await arrive(ID.alice);
    let r = await first("tp", id);
    assert.equal(r.status, 403); assert.equal(r.body.error, "receiving_staff_required", "another rostered teacher");
    r = await first("tp", id, { overrideReason: "I'm covering" });
    assert.equal(r.body.error, "receiving_staff_required", "teachers can't override");
    r = await first("p2", id, { overrideReason: "wrong school" });
    assert.equal(r.status, 404, "another school's principal can't even see the handoff");
    r = await first("p1", id);
    assert.equal(r.status, 400); assert.equal(r.body.error, "override_reason_required");
    r = await first("t1", id);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const again = await first("t1", id, { status: "tardy" });
    assert.equal(again.status, 200); assert.equal(again.body.data.created, false);
    assert.equal(again.body.data.attendance.status, "present", "a repeat doesn't change or duplicate the record");
    const n = await admin.query("SELECT count(*)::int AS n FROM attendance_events WHERE student_id=$1", [ID.alice]);
    assert.equal(n.rows[0].n, 1);
  });

  it("a principal override needs a reason and is logged", async () => {
    const id = await arrive(ID.bob);
    const r = await first("p1", id, { status: "tardy", overrideReason: "Receiving teacher left sick" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const ev = await admin.query("SELECT actor_user_id, detail FROM arrival_handoff_events WHERE handoff_id=$1 AND event='attendance_recorded'", [id]);
    assert.equal(ev.rows[0].actor_user_id, USERS.p1[0]);
    assert.deepEqual([ev.rows[0].detail.override, ev.rows[0].detail.receivedBy, ev.rows[0].detail.reason], [true, USERS.t1[0], "Receiving teacher left sick"]);
    const au = await admin.query("SELECT action, detail FROM audit_events WHERE resource_type='attendance_event' AND action='override'");
    assert.equal(au.rows.length, 1);
    assert.match(au.rows[0].detail, /principal override .*Receiving teacher left sick/);
  });
});
