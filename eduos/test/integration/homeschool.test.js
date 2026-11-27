// HSP-01: the homeschool family workspace against real PostgreSQL, as the
// non-owner runtime role: one context per session, family and district
// isolation both ways, per-learner authority, invitations, revocation, the
// last-owner guard and audit (test plan: docs/product/hsp-00-architecture-and-tenancy.md §10).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const FAMILY_TABLES = ["homeschool_families", "family_memberships", "family_invitations", "family_learners", "family_learner_relationships", "family_calendar_events", "family_audit_events", "tenants"];
const soon = (h, len = 1) => { const a = new Date(Date.now() + h * 3600_000); return { startsAt: a.toISOString(), endsAt: new Date(a.getTime() + len * 3600_000).toISOString() }; };

describe("HSP-01 homeschool family workspace", { skip }, () => {
  let db, idp, server, admin, s = {}, fam = {}, ids = {};
  const as = name => client(server.base, s[name]);
  // Switch the named session to a context; the server issues a new session.
  const switchTo = async (name, body) => {
    const r = await fetch(`${server.base}/api/session/context`, { method: "POST", headers: { "content-type": "application/json", cookie: s[name].cookie, "x-csrf-token": s[name].csrf }, body: JSON.stringify(body) });
    const j = await r.json();
    if (r.status !== 200) return { status: r.status, body: j };
    const cookie = r.headers.getSetCookie().map(c => c.split(";")[0]).find(c => !c.endsWith("="));
    const old = s[name];
    s[name] = { cookie, csrf: j.csrfToken };
    return { status: 200, body: j, old };
  };
  const contexts = async name => (await as(name)("GET", "/api/session/contexts")).body.data.contexts;

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["pa", "pb", "t1", "p1", "supt1"]) s[n] = await login(server.base, idp, n, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("every district has a tenant row; every family table has forced RLS", async () => {
    const { rows: t } = await admin.query("SELECT count(*)::int AS n FROM districts d JOIN tenants x ON x.id=d.id AND x.kind='district'");
    const { rows: d } = await admin.query("SELECT count(*)::int AS n FROM districts");
    assert.equal(t[0].n, d[0].n);
    const { rows } = await admin.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind='r'", [FAMILY_TABLES]);
    assert.equal(rows.length, FAMILY_TABLES.length);
    for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity, `${r.relname} has forced RLS`);
    const { rows: pol } = await admin.query("SELECT DISTINCT tablename FROM pg_policies WHERE tablename = ANY($1)", [FAMILY_TABLES]);
    assert.equal(pol.length, FAMILY_TABLES.length, "every family table has a policy");
  });

  it("a district session can't reach a family route, and a family can be created from it", async () => {
    assert.equal((await as("pa")("GET", "/api/homeschool/me")).body.error, "family_context_required");
    assert.equal((await as("pa")("GET", "/api/home")).status, 200, "the district role dashboard is unchanged");
    const r = await as("pa")("POST", "/api/homeschool/families", { name: "Ortiz Homeschool", timeZone: "America/Chicago", jurisdiction: "US-TX" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    fam.a = r.body.data;
    assert.equal((await as("pa")("POST", "/api/homeschool/families", { name: "x" })).status, 400);
    const ctx = await contexts("pa");
    assert.ok(ctx.some(c => c.kind === "district") && ctx.some(c => c.kind === "homeschool_family" && c.label === "Ortiz Homeschool" && c.role === "owner"));
  });

  it("switching opens a family session that can't reach any district route", async () => {
    s.paDistrict = s.pa;
    const sw = await switchTo("pa", { kind: "homeschool_family", membershipId: fam.a.membershipId });
    assert.equal(sw.status, 200); assert.equal(sw.body.familyRole, "owner");
    assert.equal((await fetch(`${server.base}/api/me`, { headers: { cookie: sw.old.cookie } })).status, 401, "the old session ended");
    const me = (await as("pa")("GET", "/api/me")).body;
    assert.equal(me.tenantKind, "homeschool_family"); assert.equal(me.districtId, null);
    for (const path of ["/api/home", "/api/students", "/api/memberships", `/api/students/${ID.alice}`])
      assert.equal((await as("pa")("GET", path)).body.error, "district_context_required", path);
    const hm = await as("pa")("GET", "/api/homeschool/me");
    assert.equal(hm.status, 200, JSON.stringify(hm.body));
    assert.equal(hm.body.data.family.name, "Ortiz Homeschool");
    assert.equal((await switchTo("pa", { kind: "homeschool_family", membershipId: "00000000-0000-4000-8000-000000000000" })).status, 404);
  });

  it("the owner adds learners and invites a co-educator and a viewer for specific learners", async () => {
    ids.mia = (await as("pa")("POST", "/api/homeschool/learners", { displayName: "Mia", gradeBand: "3" })).body.data.id;
    ids.leo = (await as("pa")("POST", "/api/homeschool/learners", { displayName: "Leo", gradeBand: "k" })).body.data.id;
    assert.equal((await as("pa")("POST", "/api/homeschool/learners", { displayName: "X", gradeBand: "13" })).status, 400);
    const ti = await as("pa")("POST", "/api/homeschool/invitations", { email: USERS.t1[2], role: "co_educator", learnerIds: [ids.mia] });
    assert.equal(ti.status, 201); ids.tToken = ti.body.data.token;
    ids.pToken = (await as("pa")("POST", "/api/homeschool/invitations", { email: USERS.pb[2], role: "guardian_viewer", learnerIds: [ids.leo] })).body.data.token;
    const members = (await as("pa")("GET", "/api/homeschool/members")).body.data;
    assert.equal(members.invitations.length, 2);
    assert.ok(!JSON.stringify(members).includes(ids.tToken), "tokens are shown once");
    // Accept: only with the invited email, once.
    assert.equal((await as("pb")("POST", "/api/homeschool/invitations/accept", { token: ids.tToken })).body.error, "invitation_for_another_email");
    const ok = await as("t1")("POST", "/api/homeschool/invitations/accept", { token: ids.tToken });
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.data.role, "co_educator");
    assert.equal((await as("t1")("POST", "/api/homeschool/invitations/accept", { token: ids.tToken })).body.error, "invitation_not_valid");
    assert.equal((await as("pb")("POST", "/api/homeschool/invitations/accept", { token: ids.pToken })).status, 200);
  });

  it("authority is per learner: the co-educator teaches Mia only; the viewer only reads Leo", async () => {
    s.t1District = s.t1; s.pbDistrict = s.pb;
    await switchTo("t1", { kind: "homeschool_family", membershipId: (await contexts("t1")).find(c => c.kind === "homeschool_family").membershipId });
    await switchTo("pb", { kind: "homeschool_family", membershipId: (await contexts("pb")).find(c => c.kind === "homeschool_family").membershipId });
    assert.deepEqual((await as("t1")("GET", "/api/homeschool/learners")).body.data.map(l => [l.displayName, l.authority]), [["Mia", "educational"]]);
    assert.deepEqual((await as("pb")("GET", "/api/homeschool/learners")).body.data.map(l => [l.displayName, l.authority]), [["Leo", "view"]]);
    assert.equal((await as("t1")("POST", "/api/homeschool/calendar", { title: "Fractions", learnerId: ids.mia, ...soon(2) })).status, 201);
    assert.equal((await as("t1")("POST", "/api/homeschool/calendar", { title: "Phonics", learnerId: ids.leo, ...soon(3) })).status, 404, "Leo isn't visible to the co-educator");
    assert.equal((await as("t1")("POST", "/api/homeschool/calendar", { title: "Family trip", kind: "field_trip", ...soon(4) })).status, 403, "family-wide events are the owner's");
    assert.equal((await as("pa")("POST", "/api/homeschool/calendar", { title: "Museum day", kind: "field_trip", ...soon(5, 4) })).status, 201);
    ids.leoEvent = (await as("pa")("POST", "/api/homeschool/calendar", { title: "Reading", learnerId: ids.leo, ...soon(6) })).body.data.id;
    assert.equal((await as("pb")("POST", "/api/homeschool/calendar", { title: "x", learnerId: ids.leo, ...soon(7) })).status, 403, "viewers don't write");
    assert.deepEqual((await as("pb")("GET", "/api/homeschool/calendar")).body.data.map(e => e.title).sort(), ["Museum day", "Reading"], "not Mia's lesson");
    assert.deepEqual((await as("t1")("GET", "/api/homeschool/calendar")).body.data.map(e => e.title).sort(), ["Fractions", "Museum day"]);
    for (const [who, path, body] of [["t1", "/api/homeschool/learners", { displayName: "Z" }], ["t1", "/api/homeschool/invitations", { email: "x@y.test", role: "co_educator" }],
      ["pb", `/api/homeschool/learners/${ids.leo}/archive`, {}], ["t1", "/api/homeschool/members/" + fam.a.membershipId + "/role", { role: "guardian_viewer" }]])
      assert.equal((await as(who)("POST", path, body)).body.error, "family_owner_only", path);
    assert.equal((await as("t1")("PATCH", `/api/homeschool/calendar/${ids.leoEvent}`, { title: "Hijack" })).status, 404);
    const dash = (await as("pa")("GET", "/api/homeschool/me")).body.data;
    assert.deepEqual(dash.learners.map(l => [l.displayName, l.upcomingThisWeek]), [["Leo", 1], ["Mia", 1]]);
    assert.equal(dash.familyEventsThisWeek, 1);
  });

  it("two families are isolated, a forged family ID changes nothing, and the database enforces it as the runtime role", async () => {
    const r = await as("p1")("POST", "/api/homeschool/families", { name: "Nguyen Learning" });
    await switchTo("p1", { kind: "homeschool_family", membershipId: r.body.data.membershipId });
    fam.b = r.body.data;
    assert.deepEqual((await as("p1")("GET", "/api/homeschool/learners")).body.data, []);
    assert.equal((await as("p1")("PATCH", `/api/homeschool/learners/${ids.mia}`, { displayName: "Stolen" })).status, 404);
    assert.equal((await as("p1")("POST", `/api/homeschool/calendar/${ids.leoEvent}/cancel`, {})).status, 404);
    assert.equal((await as("p1")("POST", "/api/homeschool/calendar", { title: "Mine", learnerId: ids.mia, ...soon(1) })).status, 404);
    const forged = await as("p1")("POST", "/api/homeschool/calendar", { title: "Forged", familyId: fam.a.familyId, ...soon(1) });
    assert.equal(forged.status, 201);
    const { rows: [f] } = await admin.query("SELECT family_id FROM family_calendar_events WHERE id=$1", [forged.body.data.id]);
    assert.equal(f.family_id, fam.b.familyId, "the event went to the session's family");
    assert.equal((await switchTo("p1", { kind: "homeschool_family", membershipId: fam.a.membershipId })).status, 404, "someone else's membership");

    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      const ctx = async (vars, q) => { await app.query("BEGIN"); for (const [k, v] of Object.entries(vars)) await app.query("SELECT set_config($1,$2,true)", [k, v]); const r = await app.query(q); await app.query("ROLLBACK"); return r.rows; };
      const asOwnerB = { "app.family_id": fam.b.familyId, "app.user_id": USERS.p1[0], "app.district_id": "" };
      assert.equal((await ctx(asOwnerB, "SELECT * FROM family_learners")).length, 0, "family B sees none of A's learners");
      assert.equal((await ctx(asOwnerB, "SELECT * FROM students")).length, 0, "a family context sees no district students");
      assert.equal((await ctx(asOwnerB, "SELECT * FROM family_memberships WHERE family_id <> current_setting('app.family_id')::uuid")).length, 0);
      const asDistrict = { "app.district_id": ID.d1, "app.user_id": USERS.supt1[0], "app.role": "superintendent", "app.family_id": "" };
      for (const t of FAMILY_TABLES.filter(t => t !== "tenants")) assert.equal((await ctx(asDistrict, `SELECT * FROM ${t}`)).length, 0, `a district context sees no ${t}`);
      await assert.rejects(ctx(asDistrict, "SELECT * FROM tenants"), /permission denied/, "tenants is owner-only");
      await app.query("ROLLBACK");
      await assert.rejects(app.query("INSERT INTO tenants(id, kind) VALUES (gen_random_uuid(), 'homeschool_family')"), /permission denied/);
      await assert.rejects(app.query("DELETE FROM family_audit_events"), /permission denied/);
    } finally { await app.end(); }
  });

  it("revoking a member ends their family session at once; their district session goes on", async () => {
    const members = (await as("pa")("GET", "/api/homeschool/members")).body.data.members;
    const t = members.find(m => m.role === "co_educator");
    assert.equal((await as("pa")("POST", `/api/homeschool/members/${t.id}/revoke`, { reason: "Tutoring ended" })).body.data.sessionsEnded, 1);
    assert.equal((await as("t1")("GET", "/api/homeschool/learners")).status, 401);
    assert.equal((await as("t1District")("GET", "/api/home")).status, 401, "switching ended that one; sign in again");
    s.t1 = await login(server.base, idp, "t1", { email_verified: true });
    assert.equal((await as("t1")("GET", "/api/home")).status, 200);
    assert.ok(!(await contexts("t1")).some(c => c.kind === "homeschool_family"), "no family left to switch to");
  });

  it("a family keeps an owner; ownership can be shared and handed over", async () => {
    assert.equal((await as("pa")("POST", `/api/homeschool/members/${fam.a.membershipId}/role`, { role: "guardian_viewer" })).body.error, "family_needs_an_owner");
    const viewer = (await as("pa")("GET", "/api/homeschool/members")).body.data.members.find(m => m.role === "guardian_viewer");
    assert.equal((await as("pa")("POST", `/api/homeschool/members/${viewer.id}/role`, { role: "owner" })).status, 200);
    assert.equal((await as("pa")("POST", `/api/homeschool/members/${fam.a.membershipId}/role`, { role: "guardian_viewer" })).status, 200, "now there's another owner");
    assert.equal((await as("pb")("GET", "/api/homeschool/learners")).body.data.length, 2, "the new owner has every learner");
  });

  it("someone who belongs only to a family signs in straight to it; every action is audited", async () => {
    const { rows: [u] } = await admin.query("INSERT INTO users(oidc_issuer,oidc_subject,display_name,email) VALUES ($1,'hs-only','Home Only','home.only@family.test') RETURNING id", [idp.issuer]);
    await admin.query("INSERT INTO tenants(id, kind) VALUES ('f0000000-0000-4000-8000-000000000001', 'homeschool_family')");
    await admin.query("INSERT INTO homeschool_families(id, display_name, created_by) VALUES ('f0000000-0000-4000-8000-000000000001', 'Solo Family', $1)", [u.id]);
    await admin.query("INSERT INTO family_memberships(family_id, user_id, role, added_by) VALUES ('f0000000-0000-4000-8000-000000000001', $1, 'owner', $1)", [u.id]);
    s.solo = await login(server.base, idp, "hs-only", { email: "home.only@family.test", email_verified: true });
    assert.equal(s.solo.status, 303);
    const me = (await as("solo")("GET", "/api/me")).body;
    assert.deepEqual([me.tenantKind, me.familyRole], ["homeschool_family", "owner"]);
    assert.equal((await as("solo")("GET", "/api/homeschool/me")).body.data.family.name, "Solo Family");
    const log = (await as("pb")("GET", "/api/homeschool/audit")).body.data.map(a => `${a.action}:${a.resourceType}`);
    for (const x of ["create:family", "create:family_learner", "invite:family_invitation", "accept:family_invitation", "create:family_event", "revoke:family_membership", "change_role:family_membership"])
      assert.ok(log.includes(x), x);
  });
});
