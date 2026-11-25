// Clubs & sports operations against real PostgreSQL (runtime role): event
// attendance by the activity's staff only, physical clearance dates recorded by
// the school lead / athletic director, family reads of their own learner, the
// db/152 RLS and append-only rules, and the teacher dashboard activities block.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("clubs & sports attendance and physicals against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, team, club, game, meeting, future;
  const as = name => client(server.base, s[name]);
  const asApp = async (role, user, school, fn) => {
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      for (const [k, v] of [["app.district_id", ID.d1], ["app.user_id", user], ["app.role", role], ["app.school_id", school || ""]]) await app.query("SELECT set_config($1,$2,true)", [k, v]);
      return await fn(app);
    } finally { await app.query("ROLLBACK").catch(() => {}); await app.end(); }
  };
  const event = async (activityId, title, offsetHours) => (await admin.query(
    `INSERT INTO school_events(district_id,school_id,activity_id,title,starts_at,ends_at,status,created_by)
     VALUES($1,$2,$3,$4,now()+make_interval(hours=>$5::int),now()+make_interval(hours=>$5::int+2),'published',$6) RETURNING id`,
    [ID.d1, ID.s1, activityId, title, offsetHours, USERS.p1[0]])).rows[0].id;

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "t1", "vp1", "pa", "pb", "pu", "supt1"]) s[name] = await login(server.base, idp, name, { email_verified: true });

    team = (await as("p1")("POST", "/api/activities", { kind: "sport", title: "Falcons Soccer", status: "published" })).body.data;
    club = (await as("p1")("POST", "/api/activities", { kind: "club", title: "Robotics Club", status: "published" })).body.data;
    assert.equal((await as("p1")("POST", `/api/activities/${team.id}/staff`, { userId: USERS.t1[0], staffRole: "coach" })).status, 201);
    assert.equal((await as("p1")("POST", `/api/activities/${club.id}/staff`, { userId: USERS.t1[0], staffRole: "advisor" })).status, 201);
    assert.equal((await as("pu")("POST", `/api/activities/${team.id}/join`)).status, 201);
    assert.equal((await as("pu")("POST", `/api/activities/${club.id}/join`)).status, 201);
    assert.equal((await as("t1")("POST", `/api/activities/${team.id}/roster`, { studentId: ID.alice, jerseyNumber: 9 })).status, 201);
    await admin.query("INSERT INTO activity_roster_entries(district_id,school_id,activity_id,student_id,jersey_number,added_by) VALUES($1,$2,$3,$4,4,$5)", [ID.d1, ID.s1, team.id, ID.bob, USERS.p1[0]]);
    game = await event(team.id, "Home game", -3);
    meeting = await event(club.id, "Build night", -2);
    future = await event(team.id, "Away game", 72);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("the coach lists the team for a game and marks attendance; the audit has counts only", async () => {
    const list = await as("t1")("GET", `/api/events/${game}/attendance`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.data.students.map(x => x.name).sort(), ["Alice A", "Bob B"]);
    assert.equal(list.body.data.unmarked, 2);
    const put = await as("t1")("PUT", `/api/events/${game}/attendance`, { marks: [{ studentId: ID.alice, status: "present" }, { studentId: ID.bob, status: "excused" }] });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.data.saved, 2);
    const again = await as("t1")("PUT", `/api/events/${game}/attendance`, { marks: [{ studentId: ID.bob, status: "late" }] });
    assert.equal(again.status, 200);
    const after = (await as("t1")("GET", `/api/events/${game}/attendance`)).body.data;
    assert.equal(after.unmarked, 0);
    assert.deepEqual(after.counts, { present: 1, late: 1, excused: 0, absent: 0 });
    const a = await admin.query("SELECT detail FROM audit_events WHERE resource_type='activity_event_attendance' ORDER BY occurred_at DESC LIMIT 1");
    assert.match(String(a.rows[0].detail), /present=0;late=1;excused=0;absent=0/);
  });

  it("club attendance covers members through their pupil link; future events and outsiders are refused", async () => {
    const list = await as("t1")("GET", `/api/events/${meeting}/attendance`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.data.students.map(x => x.name), ["Alice A"]);
    assert.equal((await as("t1")("PUT", `/api/events/${meeting}/attendance`, { marks: [{ studentId: ID.bob, status: "present" }] })).status, 409);
    assert.equal((await as("t1")("PUT", `/api/events/${future}/attendance`, { marks: [{ studentId: ID.alice, status: "present" }] })).body.error, "event_not_started");
    for (const who of ["pa", "pu"]) assert.equal((await as(who)("GET", `/api/events/${game}/attendance`)).status, 404, who);
    assert.equal((await as("vp1")("GET", `/api/events/${game}/attendance`)).status, 200, "school leadership can review attendance");
    assert.equal((await as("t1")("PUT", `/api/events/${game}/attendance`, { marks: [{ studentId: ID.alice, status: "here" }] })).status, 400);
    // The database refuses a non-staff write even without the route.
    await assert.rejects(asApp("teacher", USERS.vp1[0], ID.s1, c => c.query(
      "INSERT INTO activity_event_attendance(district_id,school_id,activity_id,event_id,student_id,status,marked_by) VALUES($1,$2,$3,$4,$5,'absent',$6)",
      [ID.d1, ID.s1, team.id, game, ID.alice, USERS.vp1[0]])), /row-level security|permission denied/);
  });

  it("the principal records physical dates; the coach sees status, the family sees their own learner only", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const exp = new Date(Date.now() + 300 * 864e5).toISOString().slice(0, 10);
    assert.equal((await as("t1")("POST", `/api/students/${ID.alice}/physical-clearance`, { clearedOn: today, expiresOn: exp })).status, 403);
    const rec = await as("p1")("POST", `/api/students/${ID.alice}/physical-clearance`, { clearedOn: today, expiresOn: exp });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    assert.equal(rec.body.data.status, "cleared");
    assert.equal((await as("p1")("POST", `/api/students/${ID.alice}/physical-clearance`, { clearedOn: exp, expiresOn: today })).status, 400);
    const team1 = await as("t1")("GET", `/api/activities/${team.id}/physicals`);
    assert.equal(team1.status, 200, JSON.stringify(team1.body));
    assert.deepEqual(team1.body.data.summary, { cleared: 1, expiring: 0, expired: 0, missing: 1 });
    assert.equal((await as("t1")("GET", `/api/activities/${club.id}/physicals`)).status, 400);
    assert.equal((await as("pa")("GET", `/api/activities/${team.id}/physicals`)).status, 404);
    const mine = await as("pa")("GET", `/api/students/${ID.alice}/physical-clearance`);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.body.data.status, "cleared");
    assert.equal((await as("pb")("GET", `/api/students/${ID.alice}/physical-clearance`)).status, 404);
    await assert.rejects(admin.query("UPDATE student_physical_clearances SET expires_on=expires_on+1"), /append-only/);
  });

  it("the teacher dashboard shows my clubs and teams with attendance still due", async () => {
    const r = await as("t1")("GET", "/api/teacher/dashboard");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const act = r.body.data.activities;
    assert.equal(act.count, 2);
    assert.equal(act.attendanceDue, 1, "the club meeting is unmarked; the game was marked");
    const soccer = act.items.find(x => x.title === "Falcons Soccer");
    assert.equal(soccer.role, "coach");
    assert.equal(soccer.nextEvent.title, "Away game");
  });
});
