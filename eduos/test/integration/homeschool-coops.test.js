// HSP-07: homeschool co-ops against real PostgreSQL, as the non-owner runtime
// role: invite-only membership, adult-only access, sessions with first-name
// rosters, moderated posts, attendance the family adds to its own log, and
// isolation.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const TABLES = ["coops", "coop_members", "coop_invitations", "coop_sessions", "coop_signups", "coop_session_attendance", "coop_posts", "coop_post_flags", "coop_audit_events"];
const later = h => new Date(Date.now() + h * 3600_000).toISOString();

describe("HSP-07 homeschool co-ops", { skip }, () => {
  let db, idp, server, admin, s = {}, ids = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const H = "/api/homeschool";
  const switchTo = async (name, membershipId) => {
    const r = await fetch(`${server.base}/api/session/context`, { method: "POST", headers: { "content-type": "application/json", cookie: s[name].cookie, "x-csrf-token": s[name].csrf },
      body: JSON.stringify({ kind: "homeschool_family", membershipId }) });
    const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j));
    s[name] = { cookie: r.headers.getSetCookie().map(c => c.split(";")[0]).find(c => !c.endsWith("=")), csrf: j.csrfToken };
  };
  const familyOf = async name => (await as(name)("GET", "/api/session/contexts")).body.data.contexts.find(c => c.kind === "homeschool_family").membershipId;
  const newFamily = async (who, name, learner) => {
    const f = ok(await as(who)("POST", `${H}/families`, { name }), 201); await switchTo(who, f.membershipId);
    return { id: f.familyId, learner: ok(await as(who)("POST", `${H}/learners`, { displayName: learner, gradeBand: "4" }), 201).id };
  };

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["pa", "pb", "p1", "t1", "supt1"]) s[n] = await login(server.base, idp, n, { email_verified: true });
    ids.A = await newFamily("pa", "Ortiz Homeschool", "Mia Ortiz");
    ids.B = await newFamily("p1", "Nguyen Learning", "Leo Nguyen");
    ids.C = await newFamily("pb", "Lin Homeschool", "Ava Lin");
    for (const [who, role] of [["t1", "co_educator"], ["supt1", "guardian_viewer"]]) {
      const t = ok(await as("pa")("POST", `${H}/invitations`, { email: USERS[who][2], role, learnerIds: [ids.A.learner] }), 201).token;
      ok(await as(who)("POST", `${H}/invitations/accept`, { token: t })); await switchTo(who, await familyOf(who));
    }
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("co-ops are invite-only, joined by a family's owner, and reached only by owners and co-educators", async () => {
    const { rows } = await admin.query("SELECT relname, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind='r'", [TABLES]);
    assert.equal(rows.length, TABLES.length); for (const r of rows) assert.ok(r.relforcerowsecurity, r.relname);
    assert.equal((await as("t1")("POST", `${H}/coops`, { name: "Creek Co-op" })).body.error, "family_owner_only");
    ids.coop = ok(await as("pa")("POST", `${H}/coops`, { name: "Creek Co-op", description: "Fridays at the library" }), 201).id;
    const inv = ok(await as("pa")("POST", `${H}/coops/${ids.coop}/invitations`, { label: "Nguyen family" }), 201);
    assert.equal((await as("t1")("POST", `${H}/coops/join`, { code: inv.code })).body.error, "family_owner_only");
    ok(await as("p1")("POST", `${H}/coops/join`, { code: inv.code }));
    assert.equal((await as("pb")("POST", `${H}/coops/join`, { code: inv.code })).body.error, "invitation_not_valid", "codes work once");
    assert.equal((await as("pb")("GET", `${H}/coops/${ids.coop}`)).status, 404, "not a member");
    assert.deepEqual(ok(await as("t1")("GET", `${H}/coops`)).map(c => c.name), ["Creek Co-op"], "a co-educator reads");
    assert.deepEqual(ok(await as("supt1")("GET", `${H}/coops`)), [], "a guardian viewer doesn't");
    assert.equal((await as("p1")("POST", `${H}/coops/${ids.coop}/invitations`, { label: "Someone" })).body.error, "organizer_only");
    const c2 = ok(await as("pa")("POST", `${H}/coops/${ids.coop}/invitations`, { label: "Lin family" }), 201);
    ok(await as("pb")("POST", `${H}/coops/join`, { code: c2.code }));
    const k = ok(await as("p1")("GET", `${H}/coops/${ids.coop}`));
    assert.deepEqual(k.members.map(m => [m.family, m.role]).sort(), [["Lin Homeschool", "member"], ["Nguyen Learning", "member"], ["Ortiz Homeschool", "organizer"]]);
    assert.equal((await as("pa")("POST", `${H}/coops/${ids.coop}/leave`, {})).body.error, "make_another_organizer_first");
  });

  it("sessions: managers schedule; families sign up their learners; rosters show first names to managers and the leader only", async () => {
    const k = ok(await as("pa")("GET", `${H}/coops/${ids.coop}`));
    const nguyen = k.members.find(m => m.family === "Nguyen Learning");
    assert.equal((await as("p1")("POST", `${H}/coops/${ids.coop}/sessions`, { title: "Science lab", startsAt: later(24), endsAt: later(26) })).body.error, "organizer_or_moderator_only");
    ids.session = ok(await as("pa")("POST", `${H}/coops/${ids.coop}/sessions`, { title: "Science lab", location: "Library room B", startsAt: later(24), endsAt: later(26),
      leaderFamilyId: nguyen.familyId, capacity: 2 }), 201).id;
    ok(await as("pa")("POST", `${H}/coop-sessions/${ids.session}/signups`, { learnerId: ids.A.learner }), 201);
    ok(await as("p1")("POST", `${H}/coop-sessions/${ids.session}/signups`, { learnerId: ids.B.learner }), 201);
    assert.equal((await as("pb")("POST", `${H}/coop-sessions/${ids.session}/signups`, { learnerId: ids.C.learner })).body.error, "session_full");
    assert.equal((await as("pb")("POST", `${H}/coop-sessions/${ids.session}/signups`, { learnerId: ids.A.learner })).body.error, "learner_not_found", "only your own learners");
    const roster = ok(await as("p1")("GET", `${H}/coop-sessions/${ids.session}/roster`));
    assert.deepEqual(roster.map(r => r.name).sort(), ["Leo", "Mia"], "first names only");
    assert.equal((await as("pb")("GET", `${H}/coop-sessions/${ids.session}/roster`)).body.error, "organizers_and_session_leaders_only");
    const forC = ok(await as("pb")("GET", `${H}/coops/${ids.coop}`)).sessions[0];
    assert.deepEqual([forC.signedUp, forC.yours.length, forC.canSeeRoster], [2, 0, false], "others see a count");
    const { rows } = await admin.query("SELECT learner_label FROM coop_signups ORDER BY learner_label");
    assert.deepEqual(rows.map(r => r.learner_label), ["Leo", "Mia"]);
  });

  it("posts: a member family's posts wait for a moderator; https links only; flags reach the moderators", async () => {
    assert.equal((await as("pb")("POST", `${H}/coops/${ids.coop}/posts`, { kind: "resource", title: "Bad link", url: "javascript:alert(1)" })).status, 400);
    assert.equal((await as("pb")("POST", `${H}/coops/${ids.coop}/posts`, { kind: "resource", title: "Plain link", url: "http://example.org" })).status, 400);
    const p = ok(await as("pb")("POST", `${H}/coops/${ids.coop}/posts`, { kind: "resource", title: "Fraction games", url: "https://example.org/fractions" }), 201);
    assert.equal(p.status, "pending");
    assert.deepEqual(ok(await as("p1")("GET", `${H}/coops/${ids.coop}`)).posts, [], "pending posts are hidden from other families");
    assert.equal((await as("p1")("POST", `${H}/coop-posts/${p.id}/decide`, { publish: true })).status, 404, "a member family can't even see it");
    ok(await as("pa")("POST", `${H}/coop-posts/${p.id}/decide`, { publish: true }));
    assert.equal(ok(await as("p1")("GET", `${H}/coops/${ids.coop}`)).posts[0].title, "Fraction games");
    ok(await as("p1")("POST", `${H}/coop-posts/${p.id}/flag`, { reason: "Link is broken" }));
    assert.deepEqual(ok(await as("pa")("GET", `${H}/coops/${ids.coop}`)).posts[0].flagReasons, ["Link is broken"]);
    assert.equal(ok(await as("p1")("GET", `${H}/coops/${ids.coop}`)).posts[0].flags, undefined, "members don't see flags");
    ok(await as("pa")("POST", `${H}/coop-posts/${p.id}/remove`, { reason: "Broken link" }));
    assert.deepEqual(ok(await as("p1")("GET", `${H}/coops/${ids.coop}`)).posts, []);
    // A moderator's own announcement publishes directly; a moderator can't approve their own family's pending post.
    const nguyen = ok(await as("pa")("GET", `${H}/coops/${ids.coop}`)).members.find(m => m.family === "Nguyen Learning");
    ok(await as("pa")("POST", `${H}/coops/${ids.coop}/members/${nguyen.id}/role`, { role: "moderator" }));
    assert.equal(ok(await as("p1")("POST", `${H}/coops/${ids.coop}/posts`, { kind: "announcement", title: "Bring goggles", body: "For Friday's lab." }), 201).status, "published");
    // No messaging to children or between families exists: posts are adult, co-op-wide and moderated.
    const { rows } = await admin.query("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'coop_%message%'");
    assert.deepEqual(rows, []);
  });

  it("the leader marks attendance; the family adds it to its own log, once", async () => {
    await admin.query("UPDATE coop_sessions SET starts_at = now() - interval '3 hours', ends_at = now() - interval '1 hour' WHERE id=$1", [ids.session]);
    const roster = ok(await as("p1")("GET", `${H}/coop-sessions/${ids.session}/roster`));
    assert.equal((await as("pb")("POST", `${H}/coop-sessions/${ids.session}/attendance`, { marks: roster.map(r => ({ signupId: r.signupId, present: true })) })).status, 403);
    ok(await as("p1")("POST", `${H}/coop-sessions/${ids.session}/attendance`, { marks: roster.map(r => ({ signupId: r.signupId, present: true })) }));
    const mine = ok(await as("pa")("GET", `${H}/coop-attendance`));
    assert.deepEqual(mine.map(a => [a.name, a.present, a.minutes, a.logged]), [["Mia", true, 120, false]]);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM family_attendance WHERE family_id=$1", [ids.A.id])).rows[0].n, 0, "the co-op never writes into a family's records");
    const logged = ok(await as("pa")("POST", `${H}/coop-attendance/${mine[0].id}/log`, {}), 201);
    assert.equal(logged.minutes, 120);
    assert.equal((await as("pa")("POST", `${H}/coop-attendance/${mine[0].id}/log`, {})).body.error, "already_logged");
    assert.equal((await as("pb")("POST", `${H}/coop-attendance/${mine[0].id}/log`, {})).status, 404, "not their attendance");
    const { rows } = await admin.query("SELECT kind, minutes, note FROM family_attendance WHERE family_id=$1", [ids.A.id]);
    assert.deepEqual(rows, [{ kind: "co_op", minutes: 120, note: "Co-op: Creek Co-op · Science lab" }]);
  });

  it("organizers remove families; leaving withdraws future signups; others and districts see nothing", async () => {
    const k = ok(await as("pa")("GET", `${H}/coops/${ids.coop}`)), lin = k.members.find(m => m.family === "Lin Homeschool");
    assert.equal((await as("p1")("POST", `${H}/coops/${ids.coop}/members/${lin.id}/remove`, { reason: "No" })).body.error, "organizer_only");
    ok(await as("pa")("POST", `${H}/coops/${ids.coop}/members/${lin.id}/remove`, { reason: "Moved away" }));
    assert.equal((await as("pb")("GET", `${H}/coops/${ids.coop}`)).status, 404, "a removed family loses access");
    const s2 = ok(await as("pa")("POST", `${H}/coops/${ids.coop}/sessions`, { title: "Art", startsAt: later(48), endsAt: later(49) }), 201).id;
    ok(await as("p1")("POST", `${H}/coop-sessions/${s2}/signups`, { learnerId: ids.B.learner }), 201);
    ok(await as("p1")("POST", `${H}/coops/${ids.coop}/leave`, {}));
    assert.equal((await admin.query("SELECT status FROM coop_signups WHERE session_id=$1", [s2])).rows[0].status, "withdrawn");
    const { rows } = await admin.query("SELECT action FROM coop_audit_events WHERE coop_id=$1", [ids.coop]);
    for (const a of ["create", "invite", "join", "schedule", "sign_up", "post", "approve_post", "flag", "remove_post", "set_role", "mark_attendance", "remove", "leave"]) assert.ok(rows.some(r => r.action === a), a);
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role','superintendent',true)", [ID.d1, USERS.supt1[0]]);
      for (const t of TABLES) assert.equal((await app.query(`SELECT * FROM ${t}`)).rowCount, 0, `a district sees no ${t}`);
      await app.query("ROLLBACK");
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.family_id',$1,true), set_config('app.user_id',$2,true)", [ids.B.id, USERS.p1[0]]);
      const att = (await admin.query("SELECT id FROM coop_session_attendance LIMIT 1")).rows[0].id;
      await assert.rejects(app.query("INSERT INTO family_attendance(family_id, learner_id, day, minutes, kind, recorded_by, coop_attendance_id) VALUES ($1,$2,current_date,60,'co_op',$3,$4)",
        [ids.B.id, ids.B.learner, USERS.p1[0], att]), /row-level security/, "a family can't claim another family's co-op attendance");
      await app.query("ROLLBACK");
      await assert.rejects(app.query("INSERT INTO coops(name, created_by_family, created_by) VALUES ('X',$1,$2)", [ids.A.id, USERS.pa[0]]), /permission denied/);
      await assert.rejects(app.query("DELETE FROM coop_posts"), /permission denied/);
    } finally { await app.end(); }
  });
});
