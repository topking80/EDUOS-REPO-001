// ROOM-02: remote lessons against real PostgreSQL, as the runtime role: only
// the course's teacher adds one, with an approved meeting link and a published
// lesson from the course; enrolled students see it and join (checking in as
// remote) only during the session; the room's roll shows them; attendance is
// still the teacher's to confirm; who can read what.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const COURSE = "c0000000-0000-4000-8000-0000000000c1", UNIT = "c0000000-0000-4000-8000-0000000000e1";
const LESSON = "c0000000-0000-4000-8000-0000000000f1", DRAFT = "c0000000-0000-4000-8000-0000000000f2";

describe("ROOM-02 remote lessons against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, today, tomorrow, session, room;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const body = (o = {}) => ({ starts: "00:00", ends: "23:59", joinUrl: "https://meet.google.com/abc-defg-hij", lessonId: LESSON, note: "Cameras optional", ...o });

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query(`INSERT INTO courses(id,district_id,school_id,teacher_user_id,title,subject,grade_level) VALUES ($1,$2,$3,$4,'Math 3','Math','3')`, [COURSE, ID.d1, ID.s1, USERS.t1[0]]);
    await admin.query(`INSERT INTO course_enrollments(course_id,district_id,student_id) VALUES ($1,$2,$3),($1,$2,$4)`, [COURSE, ID.d1, ID.alice, ID.bob]);
    await admin.query(`INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES ($1,$2,$3,$4,$5),($1,$2,$3,$6,$5) ON CONFLICT DO NOTHING`,
      [ID.d1, ID.s1, USERS.t1[0], ID.alice, USERS.p1[0], ID.bob]);
    await admin.query(`INSERT INTO course_units(id,district_id,course_id,seq,title) VALUES ($1,$2,$3,1,'Fractions')`, [UNIT, ID.d1, COURSE]);
    await admin.query(`INSERT INTO lessons(id,district_id,course_id,unit_id,seq,title,objective,content,status,created_by) VALUES
      ($1,$3,$4,$5,1,'Halves','Show halves','Fold.','published',$6),($2,$3,$4,$5,2,'Quarters','Show quarters','Fold twice.','draft',$6)`, [LESSON, DRAFT, ID.d1, COURSE, UNIT, USERS.t1[0]]);
    const d = (await admin.query(`SELECT (now() AT TIME ZONE timezone)::date::text AS t, ((now() AT TIME ZONE timezone)::date + 1)::text AS n FROM schools WHERE id=$1`, [ID.s1])).rows[0];
    today = d.t; tomorrow = d.n;
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "tp", "pa", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("only the course's teacher adds a remote lesson, with an approved meeting link and a published lesson", async () => {
    const put = (who, o, date = today) => as(who)("PUT", `/api/courses/${COURSE}/remote-lessons/${date}`, body(o));
    assert.equal((await put("tp")).status, 404, "not their course");
    assert.equal((await put("p1")).status, 403);
    assert.equal((await put("t1", { joinUrl: "https://example.org/meet" })).body.error, "meeting_link_not_allowed");
    assert.equal((await put("t1", { joinUrl: "https://meet.google.com.evil.example/x" })).body.error, "meeting_link_not_allowed");
    assert.equal((await put("t1", { lessonId: DRAFT })).body.error, "lesson_must_be_published_in_this_course");
    assert.equal((await put("t1", { starts: "10:00", ends: "09:00" })).body.error, "invalid_times");
    session = ok(await put("t1"));
    assert.deepEqual([session.provider, session.date, session.starts], ["Google Meet", today, "00:00"]);
    const again = ok(await put("t1", { joinUrl: "https://US02WEB.zoom.us/j/123" }));
    assert.equal(again.id, session.id, "one per class and day: changing it updates it");
    assert.deepEqual([again.provider, again.joinUrl], ["Zoom", "https://us02web.zoom.us/j/123"]);
    ok(await put("t1", {}, tomorrow));
    await assert.rejects(admin.query(`UPDATE class_remote_lessons SET join_url='https://example.org/x' WHERE id=$1`, [session.id]), /check constraint/, "the database keeps the same list");
  });

  it("enrolled students see it; the link comes only from Join, which checks them in as remote", async () => {
    const mine = ok(await as("pu")("GET", "/api/my/remote-lessons"));
    assert.deepEqual(mine.map(m => [m.course, m.date, m.today, m.open, m.lesson, m.joinUrl]), [["Math 3", today, true, true, "Halves", undefined], ["Math 3", tomorrow, false, false, "Halves", undefined]]);
    assert.equal(ok(await as("t1")("GET", "/api/my/remote-lessons"))[0].joinUrl, "https://us02web.zoom.us/j/123", "the teacher sees the link");
    assert.deepEqual(ok(await as("tp")("GET", "/api/my/remote-lessons")), [], "another teacher sees none");
    assert.equal((await as("pa")("GET", "/api/my/remote-lessons")).status, 403);

    const j = ok(await as("pu")("POST", `/api/remote-lessons/${session.id}/join`, {}), 201);
    assert.deepEqual(j, { joinUrl: "https://us02web.zoom.us/j/123", already: false });
    assert.equal(ok(await as("pu")("POST", `/api/remote-lessons/${session.id}/join`, {}), 201).already, true);
    assert.equal((await as("pu")("POST", `/api/remote-lessons/${mine[1].id}/join`, {})).body.error, "not_now", "tomorrow's opens tomorrow");
    assert.equal((await as("t1")("POST", `/api/remote-lessons/${session.id}/join`, {})).status, 403);
  });

  it("the roll shows remote students as checked in; the teacher confirms attendance", async () => {
    room = ok(await as("p1")("POST", "/api/rooms", { name: "Room 101" }), 201);
    ok(await as("p1")("POST", `/api/rooms/${room.id}/timetable`, { teacherId: USERS.t1[0], courseId: COURSE, weekdays: [1, 2, 3, 4, 5, 6, 7], starts: "00:00", ends: "23:59" }), 201);
    const roll = ok(await as("t1")("GET", `/api/rooms/${room.id}/roll`));
    assert.deepEqual(roll.periods[0].roster.map(r => [r.name, r.method, r.attendance]), [["Alice A", "remote", null], ["Bob B", null, null]]);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM attendance_events`)).rows[0].n, 0, "joining wrote no attendance");
    const list = ok(await as("t1")("GET", `/api/courses/${COURSE}/remote-lessons?from=${today}&to=${today}`));
    assert.deepEqual(list[0].joined.map(j => j.name), ["Alice A"]);
    assert.equal(ok(await as("p1")("GET", `/api/courses/${COURSE}/remote-lessons`)).length, 2, "the school's leaders read them");
    assert.deepEqual(ok(await as("p2")("GET", `/api/courses/${COURSE}/remote-lessons`)), [], "another school's don't");
  });

  it("cancelling takes it off students' schedules; check-ins can't be written around the function", async () => {
    assert.equal((await as("tp")("POST", `/api/remote-lessons/${session.id}/cancel`, {})).status, 404);
    ok(await as("t1")("POST", `/api/remote-lessons/${session.id}/cancel`, {}));
    assert.deepEqual(ok(await as("pu")("GET", "/api/my/remote-lessons")).map(m => m.date), [tomorrow]);
    assert.equal((await as("pu")("POST", `/api/remote-lessons/${session.id}/join`, {})).status, 404);
    await admin.query(`SET ROLE ${db.names.app}`);
    try {
      await assert.rejects(admin.query(`INSERT INTO remote_lesson_checkins(session_id,district_id,student_id,user_id) VALUES('${session.id}','${ID.d1}','${ID.bob}','${USERS.pu[0]}')`), /permission denied/);
    } finally { await admin.query("RESET ROLE"); }
  });
});
