// Migration 173: assignment_submissions row security, as the runtime role.
// A submission is visible to the learner, their family and the staff who
// teach or lead at their school; only staff put a grade on it.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, run, baseEnv, createDatabase, seed } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const C1 = "c1000000-0000-4000-8000-0000000000c1", A1 = "a5000000-0000-4000-8000-0000000000a1", A2 = "a5000000-0000-4000-8000-0000000000a2";

describe("assignment_submissions row security (173)", { skip }, () => {
  let db, admin, app;
  const as = async (who, role, school, fn) => {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role',$3,true), set_config('app.school_id',$4,true)",
        [who === "supt2" ? ID.d2 : ID.d1, USERS[who][0], role, school || ""]);
      return await fn();
    } finally { await app.query("ROLLBACK"); }
  };
  const seen = (who, role, school) => as(who, role, school, async () => (await app.query("SELECT student_id FROM assignment_submissions ORDER BY student_id")).rows.map(r => r.student_id));

  before(async () => {
    db = await createDatabase();
    const env = baseEnv({ EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, "https://idp.test");
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("INSERT INTO courses(id, district_id, school_id, teacher_user_id, title, subject, grade_level) VALUES ($1,$2,$3,$4,'Math 3','Math','3')", [C1, ID.d1, ID.s1, USERS.t1[0]]);
    await admin.query("INSERT INTO course_enrollments(course_id, district_id, student_id) VALUES ($1,$2,$3), ($1,$2,$4)", [C1, ID.d1, ID.alice, ID.bob]);
    await admin.query(`INSERT INTO assignments(id, district_id, school_id, course_id, created_by, title, instructions, status, kind, points_possible) VALUES
      ($1,$3,$4,$5,$6,'Poster','Make one','published','work',10), ($2,$3,$4,$5,$6,'Essay','Write one','published','work',10)`, [A1, A2, ID.d1, ID.s1, C1, USERS.t1[0]]);
    await admin.query(`INSERT INTO assignment_submissions(district_id, assignment_id, student_id, response_text, score, feedback, graded_by, graded_at) VALUES
      ($1,$2,$3,'Alice poster',90,'Lovely',$5,now()), ($1,$2,$4,'Bob poster',70,'Check spelling',$5,now())`, [ID.d1, A1, ID.alice, ID.bob, USERS.t1[0]]);
    app = new pg.Client(db.appUrl); await app.connect();
  });
  after(async () => { await app?.end(); await admin?.end(); await db?.drop(); });

  it("each person sees only the rows they should", async () => {
    assert.deepEqual(await seen("pu", "pupil", ID.s1), [ID.alice], "the learner: their own");
    assert.deepEqual(await seen("pa", "parent", ID.s1), [ID.alice], "a parent: their child's");
    assert.deepEqual(await seen("pb", "parent", ID.s1), [ID.bob]);
    assert.deepEqual(await seen("t1", "teacher", ID.s1), [ID.alice, ID.bob].sort(), "the course teacher");
    assert.deepEqual(await seen("p1", "principal", ID.s1), [ID.alice, ID.bob].sort(), "the school's principal");
    assert.deepEqual(await seen("vp1", "principal", ID.s1), [ID.alice, ID.bob].sort(), "a vice principal runs as principal");
    assert.deepEqual(await seen("supt1", "superintendent", null), [ID.alice, ID.bob].sort());
    assert.deepEqual(await seen("p2", "principal", ID.s2), [], "another school's principal");
    assert.deepEqual(await seen("tp", "teacher", ID.s1), [], "a teacher who doesn't teach them");
    assert.deepEqual(await seen("supt2", "superintendent", null), [], "another district");
  });

  it("learners submit their own work only, and never a grade; families don't write", async () => {
    await as("pu", "pupil", ID.s1, async () => {
      await app.query("INSERT INTO assignment_submissions(district_id, assignment_id, student_id, response_text) VALUES ($1,$2,$3,'Alice essay')", [ID.d1, A2, ID.alice]);
    });
    await assert.rejects(as("pu", "pupil", ID.s1, () => app.query("INSERT INTO assignment_submissions(district_id, assignment_id, student_id, response_text) VALUES ($1,$2,$3,'as Bob')", [ID.d1, A2, ID.bob])), /row-level security/);
    await assert.rejects(as("pu", "pupil", ID.s1, () => app.query("INSERT INTO assignment_submissions(district_id, assignment_id, student_id, response_text, score) VALUES ($1,$2,$3,'x',100)", [ID.d1, A2, ID.alice])), /cannot grade/);
    await assert.rejects(as("pu", "pupil", ID.s1, () => app.query("UPDATE assignment_submissions SET score=100 WHERE student_id=$1", [ID.alice])), /cannot grade/);
    assert.equal(await as("pu", "pupil", ID.s1, async () => (await app.query("UPDATE assignment_submissions SET feedback=NULL WHERE student_id=$1", [ID.bob])).rowCount), 0, "another learner's row isn't reachable");
    // Resubmitting clears the grade (the legacy submit route does this).
    assert.equal(await as("pu", "pupil", ID.s1, async () => (await app.query(`UPDATE assignment_submissions SET response_text='v2', score=NULL, feedback=NULL, graded_by=NULL, graded_at=NULL
      WHERE student_id=$1 AND assignment_id=$2`, [ID.alice, A1])).rowCount), 1);
    await assert.rejects(as("pa", "parent", ID.s1, () => app.query("INSERT INTO assignment_submissions(district_id, assignment_id, student_id, response_text) VALUES ($1,$2,$3,'by parent')", [ID.d1, A2, ID.alice])), /row-level security/);
    await assert.rejects(as("pu", "pupil", ID.s1, () => app.query("DELETE FROM assignment_submissions WHERE student_id=$1", [ID.alice])), /permission denied/);
  });

  it("staff who teach the learner grade; others can't", async () => {
    assert.equal(await as("t1", "teacher", ID.s1, async () => (await app.query("UPDATE assignment_submissions SET score=95, graded_at=now() WHERE student_id=$1 AND assignment_id=$2", [ID.alice, A1])).rowCount), 1);
    assert.equal(await as("p2", "principal", ID.s2, async () => (await app.query("UPDATE assignment_submissions SET score=0 WHERE assignment_id=$1", [A1])).rowCount), 0);
    await assert.rejects(as("tp", "teacher", ID.s1, () => app.query("INSERT INTO assignment_submissions(district_id, assignment_id, student_id, response_text, score, graded_at) VALUES ($1,$2,$3,'x',50,now())", [ID.d1, A2, ID.bob])), /row-level security/);
  });
});
