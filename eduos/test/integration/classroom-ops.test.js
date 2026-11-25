// Classrooms operations against real PostgreSQL (runtime role): school bell
// schedules (principal or vice principal manages, school reads) and course
// seating charts (course teacher / school lead; families see only their own
// learner's seat when share_with_families is on).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("classrooms bell schedules and seating charts against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, courseId, roomId, t2Id;
  const as = name => client(server.base, s[name]);
  const asApp = async (role, user, school, fn) => {
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      for (const [k, v] of [["app.district_id", ID.d1], ["app.user_id", user], ["app.role", role], ["app.school_id", school || ""]]) await app.query("SELECT set_config($1,$2,true)", [k, v]);
      return await fn(app);
    } finally { await app.query("ROLLBACK").catch(() => {}); await app.end(); }
  };

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    t2Id = (await admin.query("INSERT INTO users(oidc_issuer,oidc_subject,display_name,email) VALUES($1,'t2','Teacher Two','t2@d1.test') RETURNING id", [idp.issuer])).rows[0].id;
    await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES($1,$2,$3,'teacher',true)", [t2Id, ID.d1, ID.s1]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "t2", "vp1", "pa", "pb", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true, ...(name === "t2" ? { email: "t2@d1.test" } : {}) });

    courseId = (await admin.query(`INSERT INTO courses(district_id,school_id,teacher_user_id,title,subject,grade_level,status)
        VALUES($1,$2,$3,'Science 4','Science','4','active') RETURNING id`, [ID.d1, ID.s1, USERS.t1[0]])).rows[0].id;
    await admin.query("INSERT INTO course_enrollments(district_id,course_id,student_id) VALUES($1,$2,$3)", [ID.d1, courseId, ID.alice]);
    roomId = (await admin.query(`INSERT INTO classroom_rooms(district_id,school_id,name,capacity,created_by)
        VALUES($1,$2,'Room 204',28,$3) RETURNING id`, [ID.d1, ID.s1, USERS.p1[0]])).rows[0].id;
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("principal or vice principal sets bell schedules; teachers and families read only", async () => {
    for (const who of ["t1", "pa"]) {
      const denied = await as(who)("POST", "/api/schools/bell-schedules", { name: "Regular", periods: [{ label: "P1", starts: "08:00", ends: "08:50" }] });
      assert.equal(denied.status, 403, who);
    }
    const created = await as("p1")("POST", "/api/schools/bell-schedules", {
      name: "Regular Day", dayType: "regular", isDefault: true,
      periods: [{ label: "Period 1", kind: "instruction", starts: "08:00", ends: "08:50" }, { label: "Lunch", kind: "lunch", starts: "11:30", ends: "12:00" }]
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const updated = await as("vp1")("POST", "/api/schools/bell-schedules", {
      id: created.body.data.id, name: "Regular Day", dayType: "regular", isDefault: true,
      periods: [{ label: "Period 1", kind: "instruction", starts: "08:00", ends: "08:50" }, { label: "Lunch", kind: "lunch", starts: "11:30", ends: "12:00" }, { label: "Period 6", kind: "instruction", starts: "13:00", ends: "13:50" }]
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.periods.length, 3);
    const read = await as("t1")("GET", "/api/schools/bell-schedules");
    assert.equal(read.status, 200);
    assert.equal(read.body.data.todaySchedule.name, "Regular Day");
    assert.equal(read.body.data.todaySchedule.periods.length, 3);
    assert.equal((await as("pu")("GET", "/api/schools/bell-schedules")).status, 200);
    // School 2 cannot see School 1's schedule.
    assert.equal((await as("p2")("GET", "/api/schools/bell-schedules")).body.data.todaySchedule, null);
  });

  it("teacher manages seating chart for enrolled learners; others and non-enrolled learners are refused", async () => {
    const empty = await as("t1")("GET", `/api/learning/courses/${courseId}/seating`);
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(empty.body.data.students.length, 1);
    assert.equal(empty.body.data.rooms[0].name, "Room 204");

    // Bob is not enrolled in this course.
    const notEnrolled = await as("t1")("PUT", `/api/learning/courses/${courseId}/seating`, {
      roomId, rowsCount: 4, colsCount: 5, assignments: [{ studentId: ID.bob, row: 1, col: 1 }]
    });
    assert.equal(notEnrolled.status, 409);

    const saved = await as("t1")("PUT", `/api/learning/courses/${courseId}/seating`, {
      roomId, rowsCount: 4, colsCount: 5, assignments: [{ studentId: ID.alice, row: 2, col: 3, label: "Front row" }]
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.seated, 1);

    // Other teacher, family, pupil and other-school principal cannot read or write.
    for (const who of ["t2", "pa", "pu", "p2"]) {
      assert.equal((await as(who)("GET", `/api/learning/courses/${courseId}/seating`)).status, 404, who);
    }
    await assert.rejects(asApp("teacher", t2Id, ID.s1, c => c.query(
      "INSERT INTO course_seating_charts(district_id,school_id,course_id,rows_count,cols_count,updated_by) VALUES($1,$2,$3,3,3,$4)",
      [ID.d1, ID.s1, courseId, t2Id])), /row-level security|permission denied/);

    // Audit has counts only, never learner names. Sharing starts off.
    const a = await admin.query("SELECT detail FROM audit_events WHERE resource_type='course_seating_chart' ORDER BY occurred_at DESC LIMIT 1");
    assert.match(String(a.rows[0].detail), /rows=4;cols=5;seated=1;share=false/);
    assert.doesNotMatch(String(a.rows[0].detail), /Alice/i);
    assert.equal(saved.body.data.shareWithFamilies, false);
  });

  it("when the teacher shares the chart, a pupil and their guardian see only their own seat", async () => {
    const shared = await as("t1")("PUT", `/api/learning/courses/${courseId}/seating`, {
      roomId, rowsCount: 4, colsCount: 5, shareWithFamilies: true,
      assignments: [{ studentId: ID.alice, row: 2, col: 3, label: "Front row" }]
    });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.data.shareWithFamilies, true);

    const family = await as("pa")("GET", `/api/learning/courses/${courseId}/seating`);
    assert.equal(family.status, 200, JSON.stringify(family.body));
    assert.equal(family.body.data.canManage, false);
    assert.equal(family.body.data.students.length, 0);
    assert.deepEqual(family.body.data.assignments.map(x => ({ name: x.name, row: x.row, col: x.col })), [{ name: "Alice A", row: 2, col: 3 }]);
    const pupil = await as("pu")("GET", `/api/learning/courses/${courseId}/seating`);
    assert.equal(pupil.status, 200);
    assert.equal(pupil.body.data.assignments.length, 1);
    // Bob's parent and another teacher still cannot see the chart.
    for (const who of ["pb", "t2"]) assert.equal((await as(who)("GET", `/api/learning/courses/${courseId}/seating`)).status, 404, who);
    assert.equal((await as("pa")("PUT", `/api/learning/courses/${courseId}/seating`, { rowsCount: 4, colsCount: 5, shareWithFamilies: false, assignments: [] })).status, 404);
    const other = await asApp("parent", USERS.pa[0], ID.s1, c => c.query(
      "SELECT student_id FROM course_seat_assignments WHERE district_id=$1 AND course_id=$2", [ID.d1, courseId]));
    assert.deepEqual(other.rows.map(r => r.student_id), [ID.alice]);
    const view = await admin.query("SELECT detail FROM audit_events WHERE action='view' AND resource_type='course_seating_chart' ORDER BY occurred_at DESC LIMIT 1");
    assert.match(String(view.rows[0].detail), /shared=1;own=1/);
    assert.doesNotMatch(String(view.rows[0].detail), /Alice/i);
  });

  it("teacher dashboard surfaces bellSchedule and course seatedCount", async () => {
    const r = await as("t1")("GET", "/api/teacher/dashboard");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.overview.bellSchedule.name, "Regular Day");
    const c = r.body.data.overview.courses.find(x => x.id === courseId);
    assert.equal(c.seatedCount, 1);
  });
});
