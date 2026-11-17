// 37.6.0 sports additions against real PostgreSQL (runtime role): eligibility
// pass/fail by rule for the coach and athletic director only, the athletic
// director role, guardian e-sign permission slips bound to the slip text, the
// database-level roster scoping (db/060), and the student-deletion hook.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("37.6.0 sports eligibility, athletic directors and permission slips against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, team, t2Id, slip;
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
    for (const name of ["p1", "p2", "t1", "t2", "vp1", "pa", "pb", "pu", "supt1"]) s[name] = await login(server.base, idp, name, { email_verified: true, ...(name === "t2" ? { email: "t2@d1.test" } : {}) });

    // A published sport with t1 as coach; Alice (via her pupil account) joins and is rostered.
    team = (await as("p1")("POST", "/api/activities", { kind: "sport", title: "Falcons Basketball", status: "published" })).body.data;
    assert.ok(team?.id);
    assert.equal((await as("p1")("POST", `/api/activities/${team.id}/staff`, { userId: USERS.t1[0], staffRole: "coach" })).status, 201);
    assert.equal((await as("pu")("POST", `/api/activities/${team.id}/join`)).status, 201);
    const added = await as("t1")("POST", `/api/activities/${team.id}/roster`, { studentId: ID.alice, jerseyNumber: 7, position: "Guard" });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    // Bob has no pupil account in the fixture; the school adds him directly.
    await admin.query("INSERT INTO activity_roster_entries(district_id,school_id,activity_id,student_id,jersey_number,added_by) VALUES($1,$2,$3,$4,12,$5)", [ID.d1, ID.s1, team.id, ID.bob, USERS.p1[0]]);

    // Records: Alice 10 days present, 95 in her course; Bob 5 of 10 days absent, 40 in his course.
    const course = (await admin.query(`INSERT INTO courses(district_id,school_id,teacher_user_id,title,subject,grade_level,status) VALUES($1,$2,$3,'Math 3','Math','3','active') RETURNING id`, [ID.d1, ID.s1, USERS.t1[0]])).rows[0].id;
    for (const st of [ID.alice, ID.bob]) await admin.query("INSERT INTO course_enrollments(district_id,course_id,student_id) VALUES($1,$2,$3)", [ID.d1, course, st]);
    const asg = (await admin.query(`INSERT INTO assignments(district_id,school_id,created_by,title,instructions,status,course_id,points_possible,category,due_at)
      VALUES($1,$2,$3,'Unit test','Fractions','published',$4,100,'Classwork',now()-interval '3 days') RETURNING id`, [ID.d1, ID.s1, USERS.t1[0], course])).rows[0].id;
    for (const [st, pts] of [[ID.alice, 95], [ID.bob, 40]])
      await admin.query("INSERT INTO assignment_submissions(district_id,assignment_id,student_id,score,points_earned,graded_by,graded_at) VALUES($1,$2,$3,$4,$4,$5,now())", [ID.d1, asg, st, pts, USERS.t1[0]]);
    for (let i = 1; i <= 10; i++) {
      await admin.query("INSERT INTO attendance_events(district_id,student_id,event_date,status) VALUES($1,$2,current_date-$3::int,'present')", [ID.d1, ID.alice, i]);
      await admin.query("INSERT INTO attendance_events(district_id,student_id,event_date,status) VALUES($1,$2,current_date-$3::int,$4)", [ID.d1, ID.bob, i, i <= 5 ? "absent" : "present"]);
    }
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("the coach sees pass/fail by rule for the roster, never a score", async () => {
    const r = await as("t1")("GET", `/api/activities/${team.id}/eligibility`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const byName = Object.fromEntries(r.body.data.students.map(x => [x.name, x]));
    assert.equal(byName["Alice A"].status, "eligible");
    assert.equal(byName["Bob B"].status, "not_eligible");
    assert.deepEqual(byName["Bob B"].reasons.map(x => x.rule).sort(), ["attendance", "grades"]);
    for (const st of r.body.data.students) assert.deepEqual(Object.keys(st).sort(), ["grade", "jersey", "name", "reasons", "status", "studentId"]);
    assert.doesNotMatch(JSON.stringify(r.body.data.students), /\b(95|40|50)\b/, "no percentages or scores leave the server");
    const a = await admin.query("SELECT detail FROM audit_events WHERE action='view' AND resource_type='sports_eligibility' ORDER BY occurred_at DESC LIMIT 1");
    assert.match(String(a.rows[0].detail), /eligible=1;not_eligible=1/);
  });

  it("nobody else sees eligibility: principal, other teachers, families, superintendent get 404", async () => {
    for (const who of ["p1", "t2", "vp1", "pa", "pu", "supt1", "p2"]) assert.equal((await as(who)("GET", `/api/activities/${team.id}/eligibility`)).status, 404, who);
    // Straight from SQL too: the inputs function refuses anyone but the coach / athletic director.
    await assert.rejects(asApp("principal", USERS.p1[0], ID.s1, c => c.query("SELECT eduos_sports_eligibility_inputs($1)", [team.id])), /coach and athletic director only/);
  });

  it("the principal names an athletic director, who then sees eligibility until revoked", async () => {
    assert.equal((await as("t1")("POST", `/api/schools/${ID.s1}/athletic-directors`, { userId: USERS.vp1[0] })).status, 403);
    assert.equal((await as("p2")("POST", `/api/schools/${ID.s1}/athletic-directors`, { userId: USERS.vp1[0] })).status, 403, "other school's principal");
    assert.equal((await as("p1")("POST", `/api/schools/${ID.s1}/athletic-directors`, { userId: USERS.pa[0] })).status, 400, "a parent can't be athletic director");
    const g = await as("p1")("POST", `/api/schools/${ID.s1}/athletic-directors`, { userId: USERS.vp1[0] });
    assert.equal(g.status, 201, JSON.stringify(g.body));
    assert.equal((await as("vp1")("GET", "/api/sports/my-roles")).body.data.athleticDirector, true);
    assert.equal((await as("vp1")("GET", `/api/activities/${team.id}/eligibility`)).status, 200);
    assert.equal((await as("vp1")("GET", `/api/activities/${team.id}/roster`)).status, 200, "athletic director manages the school's teams");
    const list = (await as("p1")("GET", `/api/schools/${ID.s1}/athletic-directors`)).body.data;
    assert.deepEqual(list.directors.map(d => d.userId), [USERS.vp1[0]]);
    assert.ok(list.candidates.some(x => x.userId === USERS.t1[0]) && !list.candidates.some(x => x.userId === USERS.pa[0]), "staff only");
    assert.equal((await as("t1")("GET", `/api/schools/${ID.s1}/athletic-directors`)).status, 403);
    assert.equal((await as("p1")("POST", `/api/athletic-directors/${g.body.data.id}/revoke`)).status, 200);
    assert.equal((await as("vp1")("GET", `/api/activities/${team.id}/eligibility`)).status, 404);
  });

  it("only the superintendent sets the district rules, and they change the outcome", async () => {
    assert.equal((await as("p1")("PUT", "/api/sports/eligibility-policy", { minCoursePercent: 50, minAttendancePercent: 40, windowDays: 30, minRecords: 5 })).status, 403);
    assert.equal((await as("supt1")("PUT", "/api/sports/eligibility-policy", { minCoursePercent: 150, minAttendancePercent: 40, windowDays: 30, minRecords: 5 })).status, 400);
    assert.equal((await as("supt1")("PUT", "/api/sports/eligibility-policy", { minCoursePercent: 60, minAttendancePercent: 40, windowDays: 30, minRecords: 5 })).status, 200);
    assert.equal((await as("t1")("GET", "/api/sports/eligibility-policy")).body.data.minAttendancePercent, 40);
    const bob = (await as("t1")("GET", `/api/activities/${team.id}/eligibility`)).body.data.students.find(x => x.name === "Bob B");
    assert.deepEqual(bob.reasons.map(x => x.rule), ["grades"], "attendance now meets the district rule");
    await assert.rejects(asApp("principal", USERS.p1[0], ID.s1, c => c.query("UPDATE sports_eligibility_policy SET min_records=1")).then(r => { if (r.rowCount === 0) throw new Error("row-level security"); }), /row-level security/);
  });

  it("roster rows are scoped in the database, not only in the routes", async () => {
    const count = (role, user, school) => asApp(role, user, school, async c => (await c.query("SELECT student_id FROM activity_roster_entries")).rows.map(r => r.student_id).sort());
    assert.deepEqual(await count("teacher", USERS.t1[0], ID.s1), [ID.alice, ID.bob].sort(), "coach");
    assert.deepEqual(await count("principal", USERS.p1[0], ID.s1), [ID.alice, ID.bob].sort(), "principal");
    assert.deepEqual(await count("teacher", t2Id, ID.s1), [], "a teacher who is not on the activity");
    assert.deepEqual(await count("vice_principal", USERS.vp1[0], ID.s1), [], "vice principal without the athletic director role");
    assert.deepEqual(await count("pupil", USERS.pu[0], ID.s1), [ID.alice], "learner sees own row");
    assert.deepEqual(await count("parent", USERS.pb[0], ID.s1), [ID.bob], "guardian sees own child's row");
    await assert.rejects(asApp("teacher", t2Id, ID.s1, c => c.query("INSERT INTO activity_roster_entries(district_id,school_id,activity_id,student_id,added_by) VALUES($1,$2,$3,$4,$5)",
      [ID.d1, ID.s1, team.id, ID.carol, t2Id])), /row-level security/);
    assert.equal((await as("t2")("GET", `/api/activities/${team.id}/roster`)).status, 403);
  });

  it("guardians e-sign the exact slip text; answers are append-only and the latest wins", async () => {
    assert.equal((await as("t2")("POST", `/api/activities/${team.id}/permission-slips`, { title: "Away game", body: "Bus to Central HS on Friday.", dueOn: "2099-01-01" })).status, 403);
    const made = await as("t1")("POST", `/api/activities/${team.id}/permission-slips`, { title: "Away game at Central", body: "The team rides the school bus to Central HS on Friday at 4 PM and returns by 9 PM.", dueOn: "2099-01-01" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    slip = made.body.data;
    assert.match(slip.bodySha256, /^[a-f0-9]{64}$/);
    const mine = (await as("pa")("GET", "/api/my/permission-slips")).body.data;
    assert.equal(mine.length, 1); assert.equal(mine[0].studentName, "Alice A"); assert.equal(mine[0].decision, "pending"); assert.equal(mine[0].canSign, true);
    const sign = (who, body) => as(who)("POST", `/api/permission-slips/${slip.id}/sign`, { consent: true, signedName: "Parent A", bodySha256: slip.bodySha256, ...body });
    assert.equal((await sign("pa", { studentId: ID.bob, decision: "granted" })).status, 404, "not their child");
    assert.equal((await sign("pa", { studentId: ID.alice, decision: "granted", bodySha256: "0".repeat(64) })).status, 409, "text they did not see");
    assert.equal((await sign("pu", { studentId: ID.alice, decision: "granted" })).status, 403, "learners don't sign");
    assert.equal((await sign("pa", { studentId: ID.alice, decision: "granted", consent: false })).status, 400);
    assert.equal((await sign("pa", { studentId: ID.alice, decision: "granted" })).status, 201);
    let list = (await as("t1")("GET", `/api/activities/${team.id}/permission-slips`)).body.data;
    assert.deepEqual(list[0].summary, { granted: 1, declined: 0, pending: 1 });
    assert.equal((await sign("pa", { studentId: ID.alice, decision: "declined" })).status, 201);
    list = (await as("t1")("GET", `/api/activities/${team.id}/permission-slips`)).body.data;
    assert.deepEqual(list[0].summary, { granted: 0, declined: 1, pending: 1 });
    assert.equal((await as("t2")("GET", `/api/activities/${team.id}/permission-slips`)).status, 404);
    await assert.rejects(admin.query("UPDATE activity_permission_slip_signatures SET decision='granted'"), /append-only/);
    await assert.rejects(admin.query("UPDATE activity_permission_slips SET body='changed text for everyone' WHERE id=$1", [slip.id]), /text is fixed/);
    // Other families don't see the slip rows at all.
    assert.equal((await asApp("parent", USERS.pb[0], ID.s1, c => c.query("SELECT id FROM activity_permission_slip_signatures"))).rowCount, 0);
    assert.equal((await as("t1")("POST", `/api/permission-slips/${slip.id}/close`)).status, 200);
    assert.equal((await sign("pa", { studentId: ID.alice, decision: "granted" })).status, 409);
  });

  it("deleting a student record removes their roster and slip rows", async () => {
    await admin.query("INSERT INTO activity_permission_slips(district_id,school_id,activity_id,title,body,body_sha256,due_on,created_by) VALUES($1,$2,$3,'Second slip','A second trip for the team on Saturday.',repeat('0',64),'2099-02-01',$4)", [ID.d1, ID.s1, team.id, USERS.t1[0]]);
    const r = await as("supt1")("POST", `/api/students/${ID.alice}/records-delete`, { confirmLocalStudentNumber: "S1-A", reason: "Family requested deletion under district policy." });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.counts.activity_roster_entries, 1);
    assert.equal(r.body.counts.permission_slip_signatures, 2);
    assert.equal((await admin.query("SELECT count(*)::int n FROM activity_roster_entries WHERE student_id=$1", [ID.alice])).rows[0].n, 0);
  });

  it("retention removes slips long past their due date with their signatures", async () => {
    await admin.query("UPDATE activity_permission_slips SET due_on=current_date-800 WHERE id=$1", [slip.id]);
    const c = new pg.Client(db.ownerUrl); await c.connect();
    try {
      await c.query("BEGIN"); await c.query("SELECT set_config('app.district_id',$1,true)", [ID.d1]);
      const out = (await c.query("SELECT eduos_retention_feature_activities('{}'::jsonb) AS counts")).rows[0].counts;
      await c.query("COMMIT");
      assert.equal(out.activity_permission_slips, 1);
    } finally { await c.end(); }
  });
});
