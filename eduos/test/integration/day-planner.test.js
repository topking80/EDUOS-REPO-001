// Student app Phase B: the day planner against real PostgreSQL, as the runtime
// role: class times, one-day changes, the school calendar, club events, and
// what a learner and their family can and can't see.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const C1 = "c1000000-0000-4000-8000-0000000000c1", C2 = "c1000000-0000-4000-8000-0000000000c2", R1 = "e1000000-0000-4000-8000-0000000000e1", R2 = "e1000000-0000-4000-8000-0000000000e2";
const R9 = "e1000000-0000-4000-8000-0000000000e9", ACT = "a1000000-0000-4000-8000-0000000000a1", BELL = "be000000-0000-4000-8000-0000000000be";

describe("Student app Phase B: day planner", { skip }, () => {
  let db, idp, server, admin, s = {}, ids = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const week = async (who = "pu", q = "from=2027-03-08&days=8") => ok(await as(who)("GET", `/api/learning/schedule?${q}`));
  const day = (w, d) => w.days.find(x => x.date === d);

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    const q = (sql, p) => admin.query(sql, p);
    await q("UPDATE schools SET timezone='America/New_York' WHERE id=$1", [ID.s1]);
    await q(`INSERT INTO courses(id, district_id, school_id, teacher_user_id, title, subject, grade_level) VALUES ($1,$3,$4,$5,'Math 3','Math','3'), ($2,$3,$6,$7,'Science 5','Science','5')`,
      [C1, C2, ID.d1, ID.s1, USERS.t1[0], ID.s2, USERS.p2[0]]);
    await q("INSERT INTO course_enrollments(course_id, district_id, student_id) VALUES ($1,$2,$3), ($1,$2,$4)", [C1, ID.d1, ID.alice, ID.bob]);
    await q("INSERT INTO classroom_rooms(id, district_id, school_id, name, created_by) VALUES ($1,$4,$5,'Room 101',$7), ($2,$4,$5,'Room 202',$7), ($3,$4,$6,'S2 Lab',$7)",
      [R1, R2, R9, ID.d1, ID.s1, ID.s2, USERS.p1[0]]);
    await q("INSERT INTO school_bell_schedules(id, district_id, school_id, name, day_type, created_by) VALUES ($1,$2,$3,'Early release','early_release',$4)", [BELL, ID.d1, ID.s1, USERS.p1[0]]);
    await q("INSERT INTO school_bell_periods(district_id, school_id, schedule_id, seq, label, starts, ends) VALUES ($1,$2,$3,1,'Period 1','08:30','09:00')", [ID.d1, ID.s1, BELL]);
    await q("INSERT INTO school_activities(id, district_id, school_id, kind, title, status, created_by) VALUES ($1,$2,$3,'club','Robotics','published',$4)", [ACT, ID.d1, ID.s1, USERS.t1[0]]);
    await q("INSERT INTO activity_memberships(district_id, school_id, activity_id, user_id, status) VALUES ($1,$2,$3,$4,'active')", [ID.d1, ID.s1, ACT, USERS.pu[0]]);
    // Friday before the daylight-saving change (EST) and the Sunday it happens (EDT): both 6 pm where the school is.
    await q(`INSERT INTO school_events(district_id, school_id, activity_id, title, starts_at, ends_at, venue, status, created_by, event_kind) VALUES
      ($1,$2,$3,'Robotics build night','2027-03-12 23:00Z','2027-03-13 01:00Z','Room 101','published',$4,'club_showcase'),
      ($1,$2,$3,'Robotics showcase','2027-03-14 22:00Z','2027-03-14 23:30Z','Gym','cancelled',$4,'club_showcase'),
      ($1,$2,$3,'Draft meetup','2027-03-09 22:00Z','2027-03-09 23:00Z','','draft',$4,'club_showcase')`, [ID.d1, ID.s1, ACT, USERS.t1[0]]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["t1", "p1", "p2", "pa", "pb", "pu", "supt1", "vp1"]) s[n] = await login(server.base, idp, n, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("a course's teacher sets class times; others can't", async () => {
    const meeting = { weekdays: [1, 3, 5], starts: "09:00", ends: "09:50", periodLabel: "Period 1", roomId: R1, effectiveFrom: "2027-01-04" };
    assert.deepEqual((await as("t1")("POST", `/api/courses/${C1}/meetings`, { ...meeting, weekdays: [0], ends: "08:00" })).body.fields, ["weekdays", "starts/ends"]);
    assert.equal((await as("t1")("POST", `/api/courses/${C1}/meetings`, { ...meeting, roomId: R9 })).body.error, "not_at_this_school", "a room at another school");
    for (const who of ["pu", "pa", "p2"]) assert.equal((await as(who)("POST", `/api/courses/${C1}/meetings`, meeting)).status, 404, who);
    ids.m = ok(await as("t1")("POST", `/api/courses/${C1}/meetings`, meeting), 201).id;
    ok(await as("t1")("POST", `/api/courses/${C1}/changes`, { day: "2027-03-08", kind: "moved", roomId: R2, studentNote: "Meet in Room 202 for the library visit", staffNote: "SECRET-STAFF sub covering" }), 201);
    ok(await as("p1")("POST", `/api/courses/${C1}/changes`, { day: "2027-03-15", kind: "cancelled", studentNote: "No math today" }), 201);
    assert.equal((await as("t1")("POST", `/api/courses/${C1}/changes`, { day: "2027-03-15", kind: "retimed", starts: "10:00", ends: "10:30" })).body.error, "already_set_for_that_day");
    const mine = ok(await as("t1")("GET", `/api/courses/${C1}/meetings`));
    assert.equal(mine.meetings[0].room, "Room 101"); assert.deepEqual(mine.rooms.map(r => r.name), ["Room 101", "Room 202"]);
  });

  it("the principal sets the school calendar; teachers and other schools can't", async () => {
    assert.equal((await as("t1")("POST", "/api/school-calendar", { day: "2027-03-10", kind: "no_school", label: "Teacher workday" })).body.error, "principal_or_vice_principal_only");
    assert.equal((await as("p1")("POST", "/api/school-calendar", { day: "2027-02-30", kind: "no_school", label: "X day" })).status, 400);
    ok(await as("p1")("POST", "/api/school-calendar", { day: "2027-03-10", kind: "no_school", label: "Teacher workday" }), 201);
    ids.er = ok(await as("p1")("POST", "/api/school-calendar", { day: "2027-03-12", kind: "early_release", label: "Early release", bellScheduleId: BELL }), 201).id;
    assert.equal((await as("p2")("POST", `/api/school-calendar/${ids.er}/remove`, {})).status, 404, "another school's day");
    ok(await as("vp1")("POST", "/api/school-calendar", { day: "2027-04-01", kind: "modified", label: "State testing" }), 201);
    assert.equal(ok(await as("t1")("GET", "/api/school-calendar?from=2027-03-01")).length, 3);
    assert.equal((await as("pu")("GET", "/api/school-calendar")).status, 403);
  });

  it("the learner sees their week: room moves, no-school days, adjusted times, cancellations, and their club's events across a daylight-saving change", async () => {
    const w = await week();
    assert.equal(w.timezone, "America/New_York"); assert.equal(w.from, "2027-03-08"); assert.equal(w.days.length, 8); assert.ok(w.updatedAt && w.generatedAt);
    const mon = day(w, "2027-03-08").classes[0];
    assert.deepEqual([mon.title, mon.starts, mon.ends, mon.room, mon.status, mon.note, mon.teacher], ["Math 3", "09:00", "09:50", "Room 202", "changed", "Meet in Room 202 for the library visit", "Teacher S1"]);
    assert.deepEqual(day(w, "2027-03-09").classes, [], "Tuesday has no class");
    const wed = day(w, "2027-03-10");
    assert.deepEqual(wed.calendar, { kind: "no_school", label: "Teacher workday" }); assert.equal(wed.classes[0].status, "no_school");
    const fri = day(w, "2027-03-12");
    assert.deepEqual([fri.classes[0].starts, fri.classes[0].ends, fri.classes[0].status], ["08:30", "09:00", "adjusted"], "early-release bell schedule");
    assert.deepEqual(fri.events.map(e => [e.title, e.starts, e.status, e.endsNextDay]), [["Robotics build night", "18:00", "published", false]]);
    assert.deepEqual(day(w, "2027-03-14").events.map(e => [e.title, e.starts, e.venue, e.status]), [["Robotics showcase", "18:00", "Gym", "cancelled"]], "6 pm on the day clocks change");
    const mon2 = day(w, "2027-03-15").classes[0];
    assert.deepEqual([mon2.starts, mon2.status, mon2.note], ["09:00", "cancelled", "No math today"], "still 9:00 after the change");
    const json = JSON.stringify(w);
    for (const hidden of ["SECRET-STAFF", "Bob", "Draft meetup", "Science 5"]) assert.ok(!json.includes(hidden), hidden);
  });

  it("only the learner and their own family read it", async () => {
    assert.equal((await week("pa", `from=2027-03-08&days=3&studentId=${ID.alice}`)).days[0].classes[0].title, "Math 3");
    assert.equal((await as("pb")("GET", `/api/learning/schedule?studentId=${ID.alice}`)).body.error, "not_your_child");
    assert.deepEqual((await week("pb", `from=2027-03-08&days=1&studentId=${ID.bob}`)).days[0].events, [], "Bob isn't in Robotics");
    for (const who of ["t1", "p1", "supt1"]) assert.equal((await as(who)("GET", "/api/learning/schedule")).status, 403, who);
    assert.equal((await as("pu")("GET", "/api/learning/schedule?days=43")).body.error, "days_1_to_42");
    assert.equal((await as("pu")("GET", "/api/learning/schedule?from=2027-13-01")).body.error, "invalid_from");
    const today = ok(await as("pu")("GET", "/api/learning/schedule?days=1"));
    assert.equal(today.from, today.today, "no date: today where the school is");
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role','pupil',true), set_config('app.school_id',$3,true)", [ID.d1, USERS.pu[0], ID.s1]);
      for (const t of ["course_meetings", "course_meeting_changes", "school_calendar_days"]) assert.equal((await app.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, 0, `${t}: no direct reads`);
      assert.equal((await app.query("SELECT eduos_learner_schedule($1, '2027-03-08', 1) AS s", [ID.bob])).rows[0].s, null, "another learner");
      await app.query("ROLLBACK");
      await assert.rejects(app.query("DELETE FROM course_meeting_changes"), /permission denied/);
    } finally { await app.end(); }
  });

  it("a dropped course, a move to another school, or an ended link removes what's shown; actions are audited", async () => {
    await admin.query("UPDATE course_enrollments SET status='dropped' WHERE course_id=$1 AND student_id=$2", [C1, ID.alice]);
    assert.deepEqual(day(await week(), "2027-03-08").classes, []);
    await admin.query("UPDATE course_enrollments SET status='active' WHERE course_id=$1 AND student_id=$2", [C1, ID.alice]);
    assert.equal(day(await week(), "2027-03-08").classes.length, 1);
    await admin.query("UPDATE students SET school_id=$2 WHERE id=$1", [ID.alice, ID.s2]);
    const moved = await week();
    assert.deepEqual([day(moved, "2027-03-08").classes, day(moved, "2027-03-12").events], [[], []], "the old school's classes and clubs");
    await admin.query("UPDATE students SET school_id=$2 WHERE id=$1", [ID.alice, ID.s1]);
    ok(await as("t1")("POST", `/api/course-meetings/${ids.m}/end`, {}));
    assert.deepEqual(day(await week(), "2027-03-08").classes, [], "ended class times");
    const { rows } = await admin.query("SELECT DISTINCT action FROM audit_events WHERE district_id=$1 AND resource_type IN ('course_meeting','course_meeting_change','school_calendar_day')", [ID.d1]);
    for (const a of ["create", "moved", "cancelled", "end"]) assert.ok(rows.some(r => r.action === a), a);
    await admin.query("UPDATE student_user_links SET status='disabled' WHERE user_id=$1 AND student_id=$2", [USERS.pu[0], ID.alice]);
    assert.equal((await as("pu")("GET", "/api/learning/schedule")).status, 403);
  });
});
