// SEC-01 part 1 (db/176): intervention cases and case notes, as the runtime role.
// Who sees which rows, and who can write them.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, run, baseEnv, createDatabase, seed } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const K = { aShared: "ca000000-0000-4000-8000-000000000001", aPrivate: "ca000000-0000-4000-8000-000000000002", bob: "ca000000-0000-4000-8000-000000000003",
  carol: "ca000000-0000-4000-8000-000000000004", aTeacher: "ca000000-0000-4000-8000-000000000005" };

describe("intervention cases and case notes row security (176)", { skip }, () => {
  let db, admin, app;
  const as = async (who, role, school, fn) => {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role',$3,true), set_config('app.school_id',$4,true)",
        [who === "supt2" ? ID.d2 : ID.d1, USERS[who][0], role, school || ""]);
      return await fn();
    } finally { await app.query("ROLLBACK"); }
  };
  const cases = (who, role, school) => as(who, role, school, async () => (await app.query("SELECT id FROM student_intervention_cases ORDER BY id")).rows.map(r => r.id));
  const notes = (who, role, school) => as(who, role, school, async () => (await app.query("SELECT note FROM student_case_notes ORDER BY note")).rows.map(r => r.note));

  before(async () => {
    db = await createDatabase();
    const m = await run(["src/migrate.js"], { ...baseEnv({ EDUOS_APP_ROLE: db.names.app }), DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, "https://idp.test");
    admin = new pg.Client(db.adminUrl); await admin.connect();
    // t1 has Alice on their roster; tp (another S1 teacher) has no one.
    await admin.query("INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$5)", [ID.d1, ID.s1, USERS.t1[0], ID.alice, USERS.p1[0]]);
    const add = (id, student, school, by, owner, shared, title) => admin.query(`INSERT INTO student_intervention_cases(id,district_id,student_id,school_id,created_by,owner_user_id,category,priority,title,summary,family_visible)
      VALUES($1,$2,$3,$4,$5,$6,'academic','normal',$7,'Summary text',$8)`, [id, ID.d1, student, school, by, owner, title, shared]);
    await add(K.aShared, ID.alice, ID.s1, USERS.p1[0], null, true, "Alice shared");
    await add(K.aPrivate, ID.alice, ID.s1, USERS.p1[0], null, false, "Alice private");
    await add(K.bob, ID.bob, ID.s1, USERS.p1[0], null, false, "Bob case");
    await add(K.carol, ID.carol, ID.s2, USERS.p2[0], null, false, "Carol case");
    await add(K.aTeacher, ID.bob, ID.s1, USERS.tp[0], USERS.tp[0], false, "Bob case tp owns");
    const note = (c, student, text, shared) => admin.query("INSERT INTO student_case_notes(district_id,case_id,student_id,author_user_id,note,family_visible) VALUES($1,$2,$3,$4,$5,$6)", [ID.d1, c, student, USERS.p1[0], text, shared]);
    await note(K.aShared, ID.alice, "shared case, shared note", true);
    await note(K.aShared, ID.alice, "shared case, staff note", false);
    await note(K.aPrivate, ID.alice, "private case note", true);
    await note(K.bob, ID.bob, "bob note", false);
    await note(K.carol, ID.carol, "carol note", false);
    app = new pg.Client(db.appUrl); await app.connect();
  });
  after(async () => { await app?.end(); await admin?.end(); await db?.drop(); });

  it("cases: each role sees only what the routes allow", async () => {
    assert.deepEqual(await cases("supt1", "superintendent", null), Object.values(K).sort());
    assert.deepEqual(await cases("p1", "principal", ID.s1), [K.aShared, K.aPrivate, K.bob, K.aTeacher].sort(), "own school only");
    assert.deepEqual(await cases("vp1", "principal", ID.s1), [K.aShared, K.aPrivate, K.bob, K.aTeacher].sort(), "vice principal runs as principal");
    assert.deepEqual(await cases("p2", "principal", ID.s2), [K.carol]);
    assert.deepEqual(await cases("t1", "teacher", ID.s1), [K.aShared, K.aPrivate].sort(), "roster student only");
    assert.deepEqual(await cases("tp", "teacher", ID.s1), [K.aTeacher], "a case they own");
    assert.deepEqual(await cases("pa", "parent", ID.s1), [K.aShared], "their child, shared cases only");
    assert.deepEqual(await cases("pb", "parent", ID.s1), [], "Bob's case isn't shared");
    assert.deepEqual(await cases("pu", "pupil", ID.s1), [], "students see no cases");
    assert.deepEqual(await cases("supt2", "superintendent", null), [], "another district");
  });

  it("notes: inside a visible case, families see only notes shared with them", async () => {
    assert.deepEqual(await notes("pa", "parent", ID.s1), ["shared case, shared note"]);
    assert.deepEqual(await notes("t1", "teacher", ID.s1), ["private case note", "shared case, shared note", "shared case, staff note"]);
    assert.deepEqual(await notes("p2", "principal", ID.s2), ["carol note"]);
    assert.deepEqual(await notes("pu", "pupil", ID.s1), []);
    assert.equal((await notes("supt1", "superintendent", null)).length, 5);
  });

  it("writes: staff who can see the case; never families; notes stay with their case's student", async () => {
    assert.equal(await as("t1", "teacher", ID.s1, async () => (await app.query("UPDATE student_intervention_cases SET priority='high'")).rowCount), 2, "only the cases they can see");
    assert.equal(await as("pa", "parent", ID.s1, async () => (await app.query("UPDATE student_intervention_cases SET priority='high'")).rowCount), 0);
    await as("t1", "teacher", ID.s1, () => app.query("INSERT INTO student_case_notes(district_id,case_id,student_id,author_user_id,note) VALUES($1,$2,$3,$4,'follow-up')", [ID.d1, K.aPrivate, ID.alice, USERS.t1[0]]));
    await assert.rejects(as("t1", "teacher", ID.s1, () => app.query("INSERT INTO student_case_notes(district_id,case_id,student_id,author_user_id,note) VALUES($1,$2,$3,$4,'x')", [ID.d1, K.bob, ID.bob, USERS.t1[0]])), /row-level security/, "not their case");
    await assert.rejects(as("t1", "teacher", ID.s1, () => app.query("INSERT INTO student_case_notes(district_id,case_id,student_id,author_user_id,note) VALUES($1,$2,$3,$4,'x')", [ID.d1, K.aPrivate, ID.alice, USERS.p1[0]])), /row-level security/, "as someone else");
    await assert.rejects(as("t1", "teacher", ID.s1, () => app.query("INSERT INTO student_case_notes(district_id,case_id,student_id,author_user_id,note) VALUES($1,$2,$3,$4,'x')", [ID.d1, K.aPrivate, ID.bob, USERS.t1[0]])), /does not match its case/);
    await assert.rejects(as("pa", "parent", ID.s1, () => app.query("INSERT INTO student_case_notes(district_id,case_id,student_id,author_user_id,note,family_visible) VALUES($1,$2,$3,$4,'x',true)", [ID.d1, K.aShared, ID.alice, USERS.pa[0]])), /row-level security/);
    await assert.rejects(as("t1", "teacher", ID.s1, () => app.query(`INSERT INTO student_intervention_cases(district_id,student_id,school_id,created_by,category,priority,title,summary)
      VALUES($1,$2,$3,$4,'academic','normal','x','y')`, [ID.d1, ID.carol, ID.s2, USERS.t1[0]])), /row-level security/, "another school's student");
    await assert.rejects(as("supt1", "superintendent", null, () => app.query("DELETE FROM student_intervention_cases")), /permission denied|row-level/);
  });
});
