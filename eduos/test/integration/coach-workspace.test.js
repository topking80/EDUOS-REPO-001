// COACH-01: coaching a team at another school, and the coach workspace,
// against real PostgreSQL as the runtime role. A principal at S2 assigns a
// teacher from S1 as coach; the teacher gets a coach profile at S2 that
// reaches only that team; the workspace shows roster, eligibility and slips;
// ending the assignment disables the profile.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("COACH-01 cross-school coaches and the coach workspace against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, team, other, coachMembership, coach;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const future = h => new Date(Date.now() + h * 3600_000).toISOString();

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "pa"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    team = ok(await as("p2")("POST", "/api/activities", { kind: "sport", title: "S2 Soccer", status: "published" }), 201);
    other = ok(await as("p2")("POST", "/api/activities", { kind: "sport", title: "S2 Track", status: "published" }), 201);
    await admin.query("INSERT INTO activity_roster_entries(district_id,school_id,activity_id,student_id,jersey_number,added_by) VALUES($1,$2,$3,$4,9,$5)", [ID.d1, ID.s2, team.id, ID.carol, USERS.p2[0]]);
    await admin.query("INSERT INTO activity_roster_entries(district_id,school_id,activity_id,student_id,jersey_number,added_by) VALUES($1,$2,$3,$4,4,$5)", [ID.d1, ID.s2, other.id, ID.carol, USERS.p2[0]]);
    ok(await as("p2")("POST", `/api/activities/${team.id}/events`, { title: "Home game", startsAt: future(24), endsAt: future(26), venue: "Field", publish: true }), 201);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("S2's principal assigns a teacher from S1; they get a coach profile at S2", async () => {
    assert.equal((await as("p2")("POST", `/api/activities/${team.id}/staff`, { userId: USERS.pa[0], staffRole: "coach" })).body.error, "active_school_teacher_required", "not a parent");
    assert.equal((await as("p1")("POST", `/api/activities/${team.id}/staff`, { userId: USERS.t1[0], staffRole: "coach" })).status, 404, "another school's principal can't");
    const r = ok(await as("p2")("POST", `/api/activities/${team.id}/staff`, { userId: USERS.t1[0], staffRole: "coach" }), 201);
    assert.equal(r.coachProfile, true);
    const mems = ok(await as("t1")("GET", "/api/memberships"));
    coachMembership = mems.find(m => m.role === "coach");
    assert.deepEqual([coachMembership.school_name, mems.find(m => m.current).role], ["S2", "teacher"], "their own teacher profile stays current");
  });

  it("from their own school, the workspace points to the coaching profile", async () => {
    const w = ok(await as("t1")("GET", "/api/coach/teams"));
    assert.deepEqual(w.teams, []);
    assert.deepEqual(w.elsewhere.map(e => [e.school, e.membership_id]), [["S2", coachMembership.id]]);
  });

  it("as coach at S2: the team's workspace, eligibility and slips, and nothing else at S2", async () => {
    const sw = await as("t1")("POST", "/api/session/membership", { membershipId: coachMembership.id });
    assert.equal(sw.status, 200);
    const cookie = sw.headers.getSetCookie().map(c => c.split(";")[0]).find(c => c.startsWith("eduos_session=") && !c.endsWith("="));
    coach = { cookie, csrf: sw.body.csrfToken };
    const C = client(server.base, coach);
    const me = ok(await C("GET", "/api/me").then(r => ({ status: r.status, body: { data: r.body } })));
    assert.deepEqual([me.role, me.schoolId], ["coach", ID.s2]);
    const w = ok(await C("GET", "/api/coach/teams"));
    assert.equal(w.teams.length, 1);
    const t = w.teams[0];
    assert.deepEqual([t.title, t.role, t.events.map(e => e.title)], ["S2 Soccer", "coach", ["Home game"]]);
    assert.deepEqual(t.roster.map(r => [r.name, r.jersey, r.eligibility, r.slip]), [["Carol C", 9, "not_enough_records", null]]);
    ok(await C("POST", `/api/activities/${team.id}/permission-slips`, { title: "Away trip", body: "We travel by bus to the away game.", dueOn: future(72).slice(0, 10) }), 201);
    const w2 = ok(await C("GET", "/api/coach/teams")).teams[0];
    assert.deepEqual([w2.slip.title, w2.slip.pending, w2.roster[0].slip], ["Away trip", 1, "pending"]);
    assert.equal((await C("GET", `/api/activities/${team.id}/eligibility`)).status, 200);
    assert.equal((await C("GET", `/api/activities/${team.id}/roster`)).status, 200);
    // Not their team, and not the rest of the school.
    assert.equal((await C("GET", `/api/activities/${other.id}/roster`)).status, 403);
    assert.equal((await C("GET", `/api/activities/${other.id}/eligibility`)).status, 404);
    for (const path of ["/api/learning/courses", "/api/students", "/api/class-plans?date=2026-11-23", "/api/network/colleagues", "/api/comms/threads"])
      assert.ok([403, 404].includes((await C("GET", path)).status), path);
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role','coach',true),set_config('app.school_id',$3,true)", [ID.d1, USERS.t1[0], ID.s2]);
      assert.deepEqual((await app.query("SELECT activity_id FROM activity_roster_entries ORDER BY activity_id")).rows.map(r => r.activity_id), [team.id], "RLS: only their team's roster");
      await app.query("ROLLBACK");
    } finally { await app.end(); }
  });

  it("ending the assignment ends the coach profile", async () => {
    assert.equal((await as("p1")("POST", `/api/activities/${team.id}/staff/${USERS.t1[0]}/end`)).status, 404);
    const e = ok(await as("p2")("POST", `/api/activities/${team.id}/staff/${USERS.t1[0]}/end`));
    assert.deepEqual(e, { ended: true, profileDisabled: true });
    assert.equal((await client(server.base, coach)("GET", "/api/coach/teams")).status, 401, "the coach session ends at once");
    s.t1 = await login(server.base, idp, "t1", { email_verified: true }); // switching to the coach profile retired the earlier session
    assert.equal(ok(await as("t1")("GET", "/api/memberships")).some(m => m.role === "coach"), false, "the profile is gone from their list");
    assert.equal((await as("t1")("POST", "/api/session/membership", { membershipId: coachMembership.id })).status, 404);
    ok(await as("p2")("POST", `/api/activities/${team.id}/staff`, { userId: USERS.t1[0], staffRole: "coach" }), 201);
    assert.equal(ok(await as("t1")("GET", "/api/memberships")).some(m => m.role === "coach"), true, "reassigning brings it back");
    const audits = (await admin.query("SELECT detail FROM audit_events WHERE resource_type='activity_staff' ORDER BY occurred_at")).rows.map(r => r.detail);
    assert.ok(audits.some(d => /coach_profile$/.test(d)) && audits.some(d => /coach_profile_disabled/.test(d)), JSON.stringify(audits));
  });
});
