// HSP-03: independent private school foundation against real PostgreSQL, as
// the non-owner runtime role: registration and platform verification, roles
// and campus scope, guardians, the calendar, isolation from districts,
// families and other schools, lifecycle and audit.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const PS_TABLES = ["private_schools", "private_school_campuses", "private_school_memberships", "private_school_invitations", "private_school_learners",
  "private_school_guardian_links", "private_school_calendar_events", "private_school_audit_events"];
const soon = (h, len = 1) => { const a = new Date(Date.now() + h * 3600_000); return { startsAt: a.toISOString(), endsAt: new Date(a.getTime() + len * 3600_000).toISOString() }; };

describe("HSP-03 private school foundation", { skip }, () => {
  let db, idp, server, admin, env, s = {}, ids = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const switchTo = async (name, membershipId, kind = "private_school") => {
    const r = await fetch(`${server.base}/api/session/context`, { method: "POST", headers: { "content-type": "application/json", cookie: s[name].cookie, "x-csrf-token": s[name].csrf },
      body: JSON.stringify({ kind, membershipId }) });
    const j = await r.json(); if (r.status !== 200) return r.status;
    s[name] = { cookie: r.headers.getSetCookie().map(c => c.split(";")[0]).find(c => !c.endsWith("=")), csrf: j.csrfToken };
    return 200;
  };
  const schoolCtx = async name => (await as(name)("GET", "/api/session/contexts")).body.data.contexts.filter(c => c.kind === "private_school");
  const platform = args => run(["src/private-school-verify.js", ...args], { ...env, DATABASE_URL: db.ownerUrl });
  const invite = async (by, body, who) => {
    const t = ok(await as(by)("POST", "/api/private-school/invitations", body), 201).token;
    ok(await as(who)("POST", "/api/private-school/invitations/accept", { token: t }));
    const ctx = (await schoolCtx(who)).find(c => c.role === body.role);
    assert.equal(await switchTo(who, ctx.membershipId), 200);
  };

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["pa", "pb", "t1", "p1", "p2", "supt1", "supt1b"]) s[n] = await login(server.base, idp, n, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("every private-school table has forced RLS; a district session can't reach a school route", async () => {
    const { rows } = await admin.query("SELECT relname, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind='r'", [PS_TABLES]);
    assert.equal(rows.length, PS_TABLES.length);
    for (const r of rows) assert.ok(r.relforcerowsecurity, r.relname);
    assert.equal((await as("pa")("GET", "/api/private-school/me")).body.error, "private_school_context_required");
  });

  it("a school registers pending verification and holds no learner records until the platform verifies it", async () => {
    assert.equal((await as("pa")("POST", "/api/private-school/schools", { legalName: "x", displayName: "Hillside", campusName: "Main" })).status, 400);
    const r = ok(await as("pa")("POST", "/api/private-school/schools", { legalName: "Hillside Academy, Inc.", displayName: "Hillside Academy", campusName: "Main Campus",
      jurisdiction: "US-TX", websiteDomain: "hillside.example" }), 201);
    ids.school = r.schoolId; ids.main = r.campusId;
    const ctx = await schoolCtx("pa");
    assert.deepEqual([ctx[0].label, ctx[0].role, ctx[0].pending], ["Hillside Academy", "school_admin", true]);
    assert.equal(await switchTo("pa", r.membershipId), 200);
    const me = ok(await as("pa")("GET", "/api/private-school/me"));
    assert.deepEqual([me.school.status, me.role, me.school.domainVerified], ["pending_verification", "school_admin", false]);
    for (const path of ["/api/home", "/api/students", "/api/homeschool/me"]) assert.ok(["district_context_required", "family_context_required"].includes((await as("pa")("GET", path)).body.error), path);
    assert.equal((await as("pa")("POST", "/api/private-school/learners", { displayName: "Ava", campusId: ids.main, gradeLevel: "4" })).body.error, "school_not_verified");
    assert.equal((await as("pa")("POST", "/api/private-school/invitations", { email: USERS.pb[2], role: "guardian" })).body.error, "school_not_verified");
    ids.north = ok(await as("pa")("POST", "/api/private-school/campuses", { name: "North Campus", city: "Austin" }), 201).id;
    // Staff can be invited while pending.
    await invite("pa", { email: USERS.t1[2], role: "teacher", campusId: ids.main }, "t1");
    await invite("pa", { email: USERS.p1[2], role: "registrar" }, "p1");
    await invite("pa", { email: USERS.supt1[2], role: "finance" }, "supt1");
    assert.equal((await as("pa")("POST", "/api/private-school/invitations", { email: "x@y.test", role: "teacher" })).body.error, "campus_required_for_campus_roles");
    // Only the platform verifies.
    assert.equal((await platform(["--school", ids.school, "--ref", "x"])).code, 1, "a reviewer is required");
    const v = await platform(["--school", ids.school, "--ref", "State registry no. 4471, articles of incorporation reviewed", "--by", "Platform Trust Team", "--domain-verified"]);
    assert.equal(v.code, 0, v.out);
    assert.equal((await platform(["--school", ids.school, "--ref", "again", "--by", "Someone"])).code, 1, "verify once");
    const me2 = ok(await as("pa")("GET", "/api/private-school/me"));
    assert.deepEqual([me2.school.status, me2.school.domainVerified], ["active", true]);
  });

  it("roles see by scope: registrar everything, a teacher their campus, finance no learners, a guardian their own child", async () => {
    ids.ava = ok(await as("p1")("POST", "/api/private-school/learners", { displayName: "Ava", campusId: ids.main, gradeLevel: "4", localNumber: "H-001" }), 201).id;
    ids.ben = ok(await as("p1")("POST", "/api/private-school/learners", { displayName: "Ben", campusId: ids.north, gradeLevel: "7" }), 201).id;
    assert.equal((await as("p1")("POST", "/api/private-school/learners", { displayName: "Dup", campusId: ids.main, localNumber: "H-001" })).body.error, "local_number_in_use");
    assert.equal((await as("t1")("POST", "/api/private-school/learners", { displayName: "Cy", campusId: ids.main })).status, 403, "teachers don't enroll");
    assert.deepEqual(ok(await as("p1")("GET", "/api/private-school/learners")).map(l => l.displayName), ["Ava", "Ben"]);
    assert.deepEqual(ok(await as("t1")("GET", "/api/private-school/learners")).map(l => l.displayName), ["Ava"], "their campus only");
    assert.deepEqual(ok(await as("supt1")("GET", "/api/private-school/learners")), [], "finance holds no learner records");
    await invite("p1", { email: USERS.pb[2], role: "guardian", learnerIds: [ids.ava] }, "pb");
    assert.deepEqual(ok(await as("pb")("GET", "/api/private-school/learners")).map(l => l.displayName), ["Ava"]);
    assert.deepEqual(ok(await as("pb")("GET", "/api/private-school/members")).members.map(m => m.role), ["guardian"], "a guardian sees only themself");
    assert.equal((await as("pb")("PATCH", `/api/private-school/learners/${ids.ava}`, { displayName: "X" })).status, 403);
    assert.equal((await as("t1")("PATCH", `/api/private-school/learners/${ids.ben}`, { displayName: "X" })).status, 403);
    assert.equal((await as("p1")("PATCH", `/api/private-school/school`, { displayName: "Mine" })).body.error, "school_admin_only");
  });

  it("the calendar: everyone-events for all, staff events for staff; administrators write", async () => {
    ok(await as("pa")("POST", "/api/private-school/calendar", { title: "First day of term", kind: "term_start", ...soon(24) }), 201);
    ok(await as("pa")("POST", "/api/private-school/calendar", { title: "Staff training", kind: "meeting", audience: "staff", campusId: ids.main, ...soon(30) }), 201);
    assert.equal((await as("t1")("POST", "/api/private-school/calendar", { title: "x", ...soon(2) })).status, 403);
    assert.deepEqual(ok(await as("t1")("GET", "/api/private-school/calendar")).map(e => e.title), ["First day of term", "Staff training"]);
    assert.deepEqual(ok(await as("pb")("GET", "/api/private-school/calendar")).map(e => e.title), ["First day of term"]);
  });

  it("another school, a family and a district reach none of it, also as the runtime role", async () => {
    const r = ok(await as("supt1b")("POST", "/api/private-school/schools", { legalName: "Other Prep LLC", displayName: "Other Prep", campusName: "Campus" }), 201);
    await switchTo("supt1b", r.membershipId);
    assert.equal((await platform(["--school", r.schoolId, "--ref", "Registry check", "--by", "Trust Team"])).code, 0);
    assert.deepEqual(ok(await as("supt1b")("GET", "/api/private-school/learners")), []);
    assert.equal((await as("supt1b")("PATCH", `/api/private-school/learners/${ids.ava}`, { displayName: "Stolen" })).status, 404);
    assert.equal((await as("supt1b")("POST", "/api/private-school/learners", { displayName: "Z", campusId: ids.main })).body.error, "campus_not_found");
    assert.equal(await switchTo("supt1b", (await schoolCtx("pa"))[0].membershipId), 404, "someone else's membership");
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      const q = async (vars, sql) => { await app.query("BEGIN"); for (const [k, v] of Object.entries(vars)) await app.query("SELECT set_config($1,$2,true)", [k, v]); const x = await app.query(sql); await app.query("ROLLBACK"); return x.rows; };
      const { rows: [om] } = await admin.query("SELECT id FROM private_school_memberships WHERE school_id=$1", [r.schoolId]);
      const otherSchool = { "app.private_school_id": r.schoolId, "app.ps_membership_id": om.id, "app.user_id": USERS.supt1b[0] };
      assert.equal((await q(otherSchool, "SELECT * FROM private_school_learners")).length, 0);
      assert.equal((await q(otherSchool, "SELECT * FROM students")).length, 0, "no district students");
      const district = { "app.district_id": ID.d1, "app.user_id": USERS.supt1[0], "app.role": "superintendent" };
      for (const t of PS_TABLES) assert.equal((await q(district, `SELECT * FROM ${t}`)).length, 0, `a district sees no ${t}`);
      // The wrong membership for the user: nothing.
      const { rows: [am] } = await admin.query("SELECT id FROM private_school_memberships WHERE school_id=$1 AND role='school_admin'", [ids.school]);
      assert.equal((await q({ "app.private_school_id": ids.school, "app.ps_membership_id": am.id, "app.user_id": USERS.t1[0] }, "SELECT * FROM private_school_learners")).length, 0,
        "a membership counts only for its own user");
      await assert.rejects(app.query("DELETE FROM private_school_audit_events"), /permission denied/);
      await assert.rejects(app.query("UPDATE private_schools SET status='active'"), /permission denied/, "only the platform changes status");
    } finally { await app.end(); }
  });

  it("lifecycle: last admin, revocation, domain changes, export, closure", async () => {
    const meId = (await schoolCtx("pa"))[0].membershipId;
    assert.equal((await as("pa")("POST", `/api/private-school/members/${meId}/role`, { role: "registrar" })).body.error, "school_needs_an_admin");
    const members = ok(await as("pa")("GET", "/api/private-school/members")).members;
    const teacher = members.find(m => m.role === "teacher");
    assert.equal(ok(await as("pa")("POST", `/api/private-school/members/${teacher.id}/revoke`, { reason: "Left the school" })).sessionsEnded, 1);
    assert.equal((await as("t1")("GET", "/api/private-school/learners")).status, 401);
    assert.equal(ok(await as("pa")("PATCH", "/api/private-school/school", { websiteDomain: "hillside-academy.example", branding: { primaryColor: "#1a4d8f", mascotName: "Hawks" } })).domainVerified, false,
      "a new domain needs verifying again");
    assert.equal((await as("pa")("PATCH", "/api/private-school/school", { branding: { script: "<x>" } })).status, 400);
    const w = ok(await as("p1")("POST", `/api/private-school/learners/${ids.ben}/withdraw`, { reason: "Moved away" }));
    assert.equal(w.enrollmentStatus, "withdrawn");
    const exp = ok(await as("pa")("GET", "/api/private-school/export"));
    assert.deepEqual(exp.learners.map(l => [l.displayName, l.enrollmentStatus]), [["Ava", "enrolled"], ["Ben", "withdrawn"]]);
    assert.equal((await as("p1")("GET", "/api/private-school/export")).body.error, "school_admin_only");
    assert.equal((await platform(["--school", ids.school, "--close", "--ref", "asked", "--by", "Trust Team"])).code, 1, "not before the school asks");
    ok(await as("pa")("POST", "/api/private-school/closure", { reason: "Merging with another school" }));
    assert.equal((await platform(["--school", ids.school, "--close", "--ref", "Confirmed by phone with the head of school", "--by", "Trust Team"])).code, 0);
    assert.equal((await as("pa")("GET", "/api/private-school/me")).status, 401, "sessions end when the school closes");
    const { rows } = await admin.query("SELECT action, actor_role FROM private_school_audit_events WHERE school_id=$1 ORDER BY id", [ids.school]);
    const acts = rows.map(r => `${r.action}:${r.actor_role}`);
    for (const x of ["register:school_admin", "verify:platform", "enroll:registrar", "invite:school_admin", "accept:guardian", "revoke:school_admin", "export:school_admin", "request_closure:school_admin", "close:platform"])
      assert.ok(acts.includes(x), x);
  });
});
