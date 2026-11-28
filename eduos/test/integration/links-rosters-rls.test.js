// SEC-01 part 5 (db/180): family links and teacher rosters, as the runtime role.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, run, baseEnv, createDatabase, seed } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("family links and teacher rosters row security (180)", { skip }, () => {
  let db, admin, app;
  const as = async (who, role, school, fn) => {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role',$3,true), set_config('app.school_id',$4,true)",
        [who === "supt2" ? ID.d2 : ID.d1, USERS[who][0], role, school || ""]);
      return await fn();
    } finally { await app.query("ROLLBACK"); }
  };
  const linkStudents = (who, role, school) => as(who, role, school, async () => [...new Set((await app.query("SELECT student_id FROM student_user_links")).rows.map(r => r.student_id))].sort());
  const rosterStudents = (who, role, school) => as(who, role, school, async () => [...new Set((await app.query("SELECT student_id FROM teacher_student_rosters")).rows.map(r => r.student_id))].sort());

  before(async () => {
    db = await createDatabase();
    const m = await run(["src/migrate.js"], { ...baseEnv({ EDUOS_APP_ROLE: db.names.app }), DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, "https://idp.test");
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$5),($1,$2,$3,$6,$5)", [ID.d1, ID.s1, USERS.t1[0], ID.alice, USERS.p1[0], ID.bob]);
    app = new pg.Client(db.appUrl); await app.connect();
  });
  after(async () => { await app?.end(); await admin?.end(); await db?.drop(); });

  it("families see links and teachers only for their own students; staff keep district-wide reads", async () => {
    assert.deepEqual(await linkStudents("pa", "parent", ID.s1), [ID.alice]);
    assert.deepEqual(await linkStudents("pb", "parent", ID.s1), [ID.bob]);
    assert.deepEqual(await linkStudents("pu", "pupil", ID.s1), [ID.alice]);
    assert.deepEqual(await rosterStudents("pa", "parent", ID.s1), [ID.alice], "their child's teacher, not Bob's class list");
    assert.deepEqual(await rosterStudents("pu", "pupil", ID.s1), [ID.alice]);
    const allD1 = [...new Set((await admin.query("SELECT student_id FROM student_user_links WHERE district_id=$1", [ID.d1])).rows.map(r => r.student_id))].sort();
    assert.deepEqual(await linkStudents("t1", "teacher", ID.s1), allD1, "staff: district-wide for now (SEC-08)");
    assert.deepEqual(await rosterStudents("t1", "teacher", ID.s1), [ID.alice, ID.bob].sort());
    // A co-guardian's link to the same child is visible (pick-up lists the child's adults).
    assert.ok(await as("pa", "parent", ID.s1, async () => (await app.query("SELECT 1 FROM student_user_links WHERE student_id=$1 AND user_id=$2", [ID.alice, USERS.pu[0]])).rowCount === 1));
  });

  it("families never add rosters or links for others; they can add only their own guardian link", async () => {
    await assert.rejects(as("pa", "parent", ID.s1, () => app.query("INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$3)", [ID.d1, ID.s1, USERS.pa[0], ID.bob])), /row-level security/);
    await assert.rejects(as("pa", "parent", ID.s1, () => app.query("INSERT INTO student_user_links(district_id,user_id,student_id,relationship,status) VALUES($1,$2,$3,'guardian','active')", [ID.d1, USERS.pb[0], ID.alice])), /row-level security/, "for someone else");
    await assert.rejects(as("pu", "pupil", ID.s1, () => app.query("INSERT INTO student_user_links(district_id,user_id,student_id,relationship,status) VALUES($1,$2,$3,'pupil','active')", [ID.d1, USERS.pu[0], ID.bob])), /row-level security/);
    await as("pb", "parent", ID.s1, () => app.query("INSERT INTO student_user_links(district_id,user_id,student_id,relationship,status) VALUES($1,$2,$3,'guardian','active')", [ID.d1, USERS.pb[0], ID.alice]));
    assert.equal(await as("pa", "parent", ID.s1, async () => (await app.query("UPDATE student_user_links SET status='revoked' WHERE student_id=$1 AND user_id<>$2", [ID.alice, USERS.pa[0]])).rowCount), 0, "can't revoke a co-guardian");
  });
});
