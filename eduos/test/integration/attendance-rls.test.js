// SEC-01 part 3 (db/178): attendance, as the runtime role.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, run, baseEnv, createDatabase, seed } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("attendance row security (178)", { skip }, () => {
  let db, admin, app;
  const as = async (who, role, school, fn) => {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role',$3,true), set_config('app.school_id',$4,true)",
        [who === "supt2" ? ID.d2 : ID.d1, USERS[who][0], role, school || ""]);
      return await fn();
    } finally { await app.query("ROLLBACK"); }
  };
  const seen = (who, role, school) => as(who, role, school, async () => (await app.query("SELECT DISTINCT student_id FROM attendance_events ORDER BY 1")).rows.map(r => r.student_id));
  const ALL = () => [ID.alice, ID.bob, ID.carol].sort();

  before(async () => {
    db = await createDatabase();
    const m = await run(["src/migrate.js"], { ...baseEnv({ EDUOS_APP_ROLE: db.names.app }), DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, "https://idp.test");
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query(`INSERT INTO attendance_events(district_id,student_id,event_date,status) VALUES ($1,$2,current_date,'absent'), ($1,$3,current_date,'present'), ($1,$4,current_date,'tardy')`,
      [ID.d1, ID.alice, ID.bob, ID.carol]);
    app = new pg.Client(db.appUrl); await app.connect();
  });
  after(async () => { await app?.end(); await admin?.end(); await db?.drop(); });

  it("reads: district leaders, staff at the student's school, the student and their family", async () => {
    assert.deepEqual(await seen("supt1", "superintendent", null), ALL());
    assert.deepEqual(await seen("p1", "principal", ID.s1), [ID.alice, ID.bob].sort());
    assert.deepEqual(await seen("vp1", "principal", ID.s1), [ID.alice, ID.bob].sort());
    assert.deepEqual(await seen("t1", "teacher", ID.s1), [ID.alice, ID.bob].sort());
    assert.deepEqual(await seen("p2", "principal", ID.s2), [ID.carol]);
    assert.deepEqual(await seen("pa", "parent", ID.s1), [ID.alice]);
    assert.deepEqual(await seen("pb", "parent", ID.s1), [ID.bob]);
    assert.deepEqual(await seen("pu", "pupil", ID.s1), [ID.alice]);
    assert.deepEqual(await seen("supt2", "superintendent", null), []);
    assert.deepEqual(await seen("t1", "counselor", ID.s1), [], "roles with no attendance route see nothing");
    // The inline read policy and eduos_can_see_attendance agree for every role tried.
    for (const [who, role, school] of [["supt1", "superintendent", null], ["p1", "principal", ID.s1], ["t1", "teacher", ID.s1], ["pa", "parent", ID.s1], ["pu", "pupil", ID.s1], ["t1", "counselor", ID.s1]])
      assert.deepEqual(await as(who, role, school, async () => (await app.query("SELECT DISTINCT student_id FROM attendance_events WHERE eduos_can_see_attendance(student_id) ORDER BY 1")).rows.map(r => r.student_id)),
        await seen(who, role, school), `${role}: policy and function agree`);
  });

  it("writes: school staff mark; a parent only acknowledges their own child's, as themselves", async () => {
    await as("t1", "teacher", ID.s1, () => app.query("INSERT INTO attendance_events(district_id,student_id,event_date,status) VALUES($1,$2,current_date,'present')", [ID.d1, ID.alice]));
    await assert.rejects(as("t1", "teacher", ID.s1, () => app.query("INSERT INTO attendance_events(district_id,student_id,event_date,status) VALUES($1,$2,current_date,'present')", [ID.d1, ID.carol])), /row-level security/, "another school");
    await assert.rejects(as("pa", "parent", ID.s1, () => app.query("INSERT INTO attendance_events(district_id,student_id,event_date,status) VALUES($1,$2,current_date,'present')", [ID.d1, ID.alice])), /row-level security/);
    assert.equal(await as("pa", "parent", ID.s1, async () => (await app.query("UPDATE attendance_events SET family_acknowledged_at=now(), family_acknowledged_by=$1", [USERS.pa[0]])).rowCount), 1, "only their child's");
    await assert.rejects(as("pa", "parent", ID.s1, () => app.query("UPDATE attendance_events SET status='present'")), /only acknowledge/);
    await assert.rejects(as("pa", "parent", ID.s1, () => app.query("UPDATE attendance_events SET family_acknowledged_at=now(), family_acknowledged_by=$1", [USERS.pb[0]])), /only acknowledge/, "as someone else");
    assert.equal(await as("pu", "pupil", ID.s1, async () => (await app.query("UPDATE attendance_events SET family_acknowledged_at=now()")).rowCount), 0, "students don't change attendance");
    await assert.rejects(as("supt1", "superintendent", null, () => app.query("DELETE FROM attendance_events")), /permission denied|row-level/);
  });
});
