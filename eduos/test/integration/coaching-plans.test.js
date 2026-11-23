// COACH-02: practice plans and playbooks against real PostgreSQL, as the
// runtime role: a coach's own plans (from teacher and coach profiles), attach
// to a team they coach, share to the library (student-name check), browse and
// copy from a coach profile, co-write a plan and copy it back, and the limits.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("COACH-02 coaching plans against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, team, plan, shared, coach;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const body = (o = {}) => ({ summary: "Possession day", items: [
    { kind: "drill", title: "Rondo 5v2", minutes: 10, description: "Keep-away in a 10 m square", equipment: "8 cones" },
    { kind: "play", title: "Corner: near post", minutes: 5, description: "Runner to the near post" }], ...o });

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "tp", "pa"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    team = ok(await as("p1")("POST", "/api/activities", { kind: "sport", title: "S1 Soccer", status: "published" }), 201);
    ok(await as("p1")("POST", `/api/activities/${team.id}/staff`, { userId: USERS.t1[0], staffRole: "coach" }), 201);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("a coach keeps their own plans and attaches one to their team", async () => {
    assert.equal((await as("pa")("GET", "/api/coaching/plans")).status, 403);
    assert.equal((await as("t1")("POST", "/api/coaching/plans", { kind: "practice", title: "Tue", sport: "Soccer", body: body({ items: [{ kind: "drill", title: "" }] }) })).body.error, "plan_incomplete");
    plan = ok(await as("t1")("POST", "/api/coaching/plans", { kind: "practice", title: "Tuesday practice", sport: "Soccer", level: "JV", body: body(), teamId: team.id }), 201);
    assert.deepEqual([plan.minutes, plan.items, plan.level, plan.teamId], [15, 2, "JV", team.id]);
    assert.equal((await as("tp")("POST", "/api/coaching/plans", { kind: "practice", title: "x", sport: "Soccer", body: body(), teamId: team.id })).body.error, "not_your_team");
    assert.equal((await as("tp")("GET", `/api/coaching/plans/${plan.id}`)).status, 404, "nobody else's plans");
    const saved = ok(await as("t1")("PUT", `/api/coaching/plans/${plan.id}`, { baseVersion: 1, title: "Tuesday practice", sport: "Soccer", level: "JV", teamId: team.id, body: body({ summary: "Possession, then corners" }) }));
    assert.equal(saved.version, 2);
    assert.equal((await as("t1")("PUT", `/api/coaching/plans/${plan.id}`, { baseVersion: 1, title: "x", sport: "Soccer", body: body() })).status, 409);
    const teams = ok(await as("t1")("GET", "/api/coach/teams")).teams;
    assert.deepEqual(teams[0].plans.map(p => p.title), ["Tuesday practice"], "it shows on My teams");
  });

  it("sharing checks for student names; the plan joins the library, not lesson copying", async () => {
    const pausedPlan = ok(await as("t1")("POST", "/api/coaching/plans", { kind: "playbook", title: "Set pieces", sport: "Soccer", body: body({ summary: "Alice takes corners" }) }), 201);
    const r = await as("t1")("POST", `/api/coaching/plans/${pausedPlan.id}/share`, {});
    assert.equal(r.status, 409); assert.deepEqual(r.body.words, ["Alice"]);
    shared = ok(await as("t1")("POST", `/api/coaching/plans/${plan.id}/share`, { summary: "Good for JV" }), 201);
    const lib = ok(await as("p2")("GET", "/api/coaching/library"));
    assert.deepEqual(lib.map(m => [m.title, m.sport, m.level, m.school, m.body.items.length]), [["Tuesday practice", "Soccer", "JV", "S1", 2]]);
    assert.ok(ok(await as("p2")("GET", "/api/materials")).some(m => m.id === shared.id), "listed with lessons for teachers and principals");
    assert.equal((await as("p2")("POST", `/api/materials/${shared.id}/copy`, { courseId: shared.id })).body.error, "copy_coaching_plans_with_coaching_library");
  });

  it("a coach profile at another school browses and copies coaching plans only", async () => {
    const other = ok(await as("p2")("POST", "/api/activities", { kind: "sport", title: "S2 Soccer", status: "published" }), 201);
    ok(await as("p2")("POST", `/api/activities/${other.id}/staff`, { userId: USERS.tp[0], staffRole: "coach" }), 201);
    const m = ok(await as("tp")("GET", "/api/memberships")).find(x => x.role === "coach");
    const sw = await as("tp")("POST", "/api/session/membership", { membershipId: m.id });
    coach = client(server.base, { cookie: sw.headers.getSetCookie().map(c => c.split(";")[0]).find(c => c.startsWith("eduos_session=") && !c.endsWith("=")), csrf: sw.body.csrfToken });
    assert.deepEqual(ok(await coach("GET", "/api/coaching/library")).map(x => x.title), ["Tuesday practice"]);
    assert.equal((await coach("GET", "/api/materials")).status, 403, "not the lessons library");
    const mine = ok(await coach("POST", `/api/coaching/library/${shared.id}/copy`), 201);
    assert.deepEqual([mine.title, mine.adaptedFrom, mine.teamId], ["Tuesday practice", shared.id, null]);
    ok(await coach("PUT", `/api/coaching/plans/${mine.id}`, { baseVersion: 1, title: "Tuesday (S2)", sport: "Soccer", teamId: other.id, body: mine.body }));
    assert.equal(ok(await as("t1")("GET", `/api/materials/${shared.id}`)).copies, 1);
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role','coach',true),set_config('app.school_id',$3,true)", [ID.d1, USERS.tp[0], ID.s2]);
      assert.deepEqual((await app.query("SELECT kind FROM shared_materials")).rows.map(r => r.kind), ["practice"], "RLS: a coach profile sees coaching kinds only");
      assert.equal((await app.query("SELECT id FROM coaching_plans")).rowCount, 1, "RLS: only their own plans");
      await app.query("ROLLBACK");
    } finally { await app.end(); }
  });

  it("co-write a plan: start from it, merge drill edits, copy back into plans", async () => {
    const d = ok(await as("t1")("POST", "/api/drafts", { from: "plan", sourceId: plan.id }), 201);
    ok(await as("t1")("POST", `/api/drafts/${d.id}/editors`, { userIds: [USERS.p2[0]] }));
    const v1 = ok(await as("t1")("GET", `/api/drafts/${d.id}`));
    assert.deepEqual([v1.kind, v1.body.sport, v1.body.items.length], ["practice", "Soccer", 2]);
    ok(await as("t1")("PUT", `/api/drafts/${d.id}`, { baseVersion: 1, body: { ...v1.body, items: [{ ...v1.body.items[0], minutes: 12 }, v1.body.items[1]] } }));
    const m = ok(await as("p2")("PUT", `/api/drafts/${d.id}`, { baseVersion: 1, body: { ...v1.body, items: [v1.body.items[0], { ...v1.body.items[1], equipment: "6 balls" }] } }));
    assert.deepEqual([m.merged, m.body.items[0].minutes, m.body.items[1].equipment], [true, 12, "6 balls"]);
    const c = ok(await as("p2")("POST", `/api/drafts/${d.id}/copy`, {}), 201);
    assert.equal(c.kind, "practice");
    const p = ok(await as("p2")("GET", `/api/coaching/plans/${c.id}`));
    assert.deepEqual([p.title, p.body.items[0].minutes, p.body.items[1].equipment], ["Tuesday practice", 12, "6 balls"]);
    const audits = (await admin.query("SELECT DISTINCT action FROM audit_events WHERE resource_type='coaching_plan'")).rows.map(r => r.action).sort();
    assert.deepEqual(audits, ["create", "update"]);
  });
});
