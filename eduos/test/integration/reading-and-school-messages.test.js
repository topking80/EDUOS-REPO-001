// HSP-07 part 2 against real PostgreSQL, as the non-owner runtime role:
// homeschool reading lists, and private school message threads limited to a
// learner's guardians and the staff who work with that learner.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const TABLES = ["family_reading", "ps_message_threads", "ps_message_participants", "ps_messages"];

describe("HSP-07 part 2: reading lists and school messages", { skip }, () => {
  let db, idp, server, admin, env, s = {}, ids = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const H = "/api/homeschool", P = "/api/private-school", M = "/api/private-school/messages";
  const switchTo = async (name, kind, membershipId) => {
    const r = await fetch(`${server.base}/api/session/context`, { method: "POST", headers: { "content-type": "application/json", cookie: s[name].cookie, "x-csrf-token": s[name].csrf },
      body: JSON.stringify({ kind, membershipId }) });
    const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j));
    s[name] = { cookie: r.headers.getSetCookie().map(c => c.split(";")[0]).find(c => !c.endsWith("=")), csrf: j.csrfToken };
  };
  const contextOf = async (name, kind) => (await as(name)("GET", "/api/session/contexts")).body.data.contexts.find(c => c.kind === kind).membershipId;
  const join = async (who, body) => {
    const t = ok(await as("p1")("POST", `${P}/invitations`, body), 201).token;
    const m = ok(await as(who)("POST", `${P}/invitations/accept`, { token: t })).membershipId;
    await switchTo(who, "private_school", m); return m;
  };

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["pa", "pb", "p1", "t1", "supt1", "supt1b"]) s[n] = await login(server.base, idp, n, { email_verified: true });
    const r = ok(await as("p1")("POST", `${P}/schools`, { legalName: "Hillside Academy, Inc.", displayName: "Hillside Academy", campusName: "Main Campus" }), 201);
    ids.school = r.schoolId; ids.main = r.campusId; ids.admin = r.membershipId; await switchTo("p1", "private_school", r.membershipId);
    assert.equal((await run(["src/private-school-verify.js", "--school", ids.school, "--ref", "Registry", "--by", "Trust"], { ...env, DATABASE_URL: db.ownerUrl })).code, 0);
    ids.north = ok(await as("p1")("POST", `${P}/campuses`, { name: "North Campus" }), 201).id;
    ids.ava = ok(await as("p1")("POST", `${P}/learners`, { displayName: "Ava Lin", campusId: ids.main, gradeLevel: "4" }), 201).id;
    ids.bo = ok(await as("p1")("POST", `${P}/learners`, { displayName: "Bo Park", campusId: ids.north, gradeLevel: "4" }), 201).id;
    ids.teacher = await join("t1", { email: USERS.t1[2], role: "teacher", campusId: ids.main });
    ids.registrar = await join("supt1", { email: USERS.supt1[2], role: "registrar" });
    ids.northAdmin = await join("supt1b", { email: USERS.supt1b[2], role: "campus_admin", campusId: ids.north });
    ids.lin = await join("pb", { email: USERS.pb[2], role: "guardian", learnerIds: [ids.ava] });
    ids.park = await join("pa", { email: USERS.pa[2], role: "guardian", learnerIds: [ids.bo] });
    ids.math = ok(await as("p1")("POST", `${P}/classes`, { campusId: ids.main, name: "Math 4", schoolYear: "2026-2027", term: "Fall", teacherMembershipId: ids.teacher }), 201).id;
    ok(await as("p1")("POST", `${P}/classes/${ids.math}/roster`, { learnerId: ids.ava }), 201);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("a learner's guardians can reach the staff who work with them, and staff can reach the learner's guardians; no one else", async () => {
    const forLin = ok(await as("pb")("GET", `${M}/contacts?learnerId=${ids.ava}`));
    assert.deepEqual(forLin.map(x => x.membershipId).sort(), [ids.admin, ids.registrar, ids.teacher].sort(), "admin, registrar and Ava's teacher; not North's campus admin");
    assert.deepEqual(ok(await as("t1")("GET", `${M}/contacts?learnerId=${ids.ava}`)).map(x => x.membershipId), [ids.lin], "the teacher reaches Ava's guardian only");
    assert.deepEqual(ok(await as("t1")("GET", `${M}/contacts?learnerId=${ids.bo}`)), [], "not a learner they teach");
    assert.deepEqual(ok(await as("pa")("GET", `${M}/contacts?learnerId=${ids.ava}`)), [], "another family's guardian reaches no one about Ava");
    assert.deepEqual(ok(await as("supt1b")("GET", `${M}/contacts?learnerId=${ids.bo}`)).map(x => x.membershipId), [ids.park]);
  });

  it("a guardian's thread includes only the people they chose; school admins can read it for oversight", async () => {
    assert.equal((await as("pb")("POST", M, { learnerId: ids.ava, subject: "x", body: "x", membershipIds: [ids.park] })).body.error, "not_an_allowed_contact");
    assert.equal((await as("pa")("POST", M, { learnerId: ids.ava, subject: "x", body: "x", membershipIds: [ids.teacher] })).body.error, "not_a_guardian_or_staff_for_this_learner");
    ids.thread = ok(await as("pb")("POST", M, { learnerId: ids.ava, subject: "Math homework", body: "Ava is stuck on fractions. Any tips?", membershipIds: [ids.teacher] }), 201).id;
    const t = ok(await as("t1")("GET", `${M}/${ids.thread}`));
    assert.deepEqual([t.learner, t.participant, t.messages.length, t.people.length], ["Ava Lin", true, 1, 2]);
    assert.equal((await as("supt1")("GET", `${M}/${ids.thread}`)).status, 404, "the registrar wasn't included");
    assert.equal((await as("pa")("GET", `${M}/${ids.thread}`)).status, 404);
    const o = ok(await as("p1")("GET", `${M}/${ids.thread}`));
    assert.equal(o.participant, false); assert.match(o.oversight, /school administrator/);
    assert.equal((await as("p1")("POST", `${M}/${ids.thread}/reply`, { body: "Hi" })).body.error, "not_in_this_thread", "oversight is read-only");
    ok(await as("t1")("POST", `${M}/${ids.thread}/reply`, { body: "Try the fraction strips we use in class." }), 201);
    assert.equal(ok(await as("pb")("GET", M)).find(x => x.id === ids.thread).unread, 1);
    ok(await as("pb")("GET", `${M}/${ids.thread}`));
    assert.equal(ok(await as("pb")("GET", M)).find(x => x.id === ids.thread).unread, 0, "opening it marks it read");
    assert.deepEqual(ok(await as("supt1")("GET", M)), [], "not in the registrar's list");
  });

  it("messages are never edited or deleted; a school admin hides one with a reason; closed threads take no replies", async () => {
    const msgs = ok(await as("p1")("GET", `${M}/${ids.thread}`)).messages;
    assert.equal((await as("t1")("POST", `${M}/${ids.thread}/messages/${msgs[1].id}/hide`, { reason: "Wrong" })).body.error, "school_admin_only");
    ok(await as("p1")("POST", `${M}/${ids.thread}/messages/${msgs[1].id}/hide`, { reason: "Shared another learner's details" }));
    const seen = ok(await as("pb")("GET", `${M}/${ids.thread}`)).messages[1];
    assert.deepEqual([seen.body, seen.hidden, seen.hideReason], [null, true, "Shared another learner's details"]);
    assert.equal(ok(await as("p1")("GET", `${M}/${ids.thread}`)).messages[1].body, "Try the fraction strips we use in class.", "the admin still sees what was hidden");
    await assert.rejects(admin.query("UPDATE ps_messages SET body='changed' WHERE id=$1", [msgs[0].id]), /never edited or deleted/);
    await assert.rejects(admin.query("DELETE FROM ps_messages WHERE id=$1", [msgs[0].id]), /never edited or deleted/);
    ok(await as("pb")("POST", `${M}/${ids.thread}/close`, {}));
    assert.equal((await as("t1")("POST", `${M}/${ids.thread}/reply`, { body: "One more thing" })).body.error, "thread_closed");
    // A teacher no longer on the learner's roster can't start new threads about them.
    const roster = await admin.query("SELECT id FROM ps_class_rosters WHERE learner_id=$1", [ids.ava]);
    await admin.query("UPDATE ps_class_rosters SET removed_on=current_date, removed_by=$2 WHERE id=$1", [roster.rows[0].id, USERS.p1[0]]);
    assert.equal((await as("t1")("POST", M, { learnerId: ids.ava, subject: "x", body: "x", membershipIds: [ids.lin] })).body.error, "not_a_guardian_or_staff_for_this_learner");
    const { rows } = await admin.query("SELECT action FROM private_school_audit_events WHERE school_id=$1 AND resource_type LIKE 'ps_message%'", [ids.school]);
    for (const a of ["open", "hide_message", "close"]) assert.ok(rows.some(r => r.action === a), a);
  });

  it("homeschool reading lists: educators add and update; viewers read; other families don't", async () => {
    const f = ok(await as("pa")("POST", `${H}/families`, { name: "Park Homeschool" }), 201); await switchTo("pa", "homeschool_family", f.membershipId); ids.fam = f.familyId;
    ids.mia = ok(await as("pa")("POST", `${H}/learners`, { displayName: "Mia Park", gradeBand: "4" }), 201).id;
    const t = ok(await as("pa")("POST", `${H}/invitations`, { email: USERS.supt1[2], role: "guardian_viewer", learnerIds: [ids.mia] }), 201).token;
    ok(await as("supt1")("POST", `${H}/invitations/accept`, { token: t })); await switchTo("supt1", "homeschool_family", await contextOf("supt1", "homeschool_family"));
    const b = ok(await as("pa")("POST", `${H}/learners/${ids.mia}/reading`, { title: "Charlotte's Web", author: "E. B. White", status: "reading" }), 201);
    ok(await as("pa")("POST", `${H}/learners/${ids.mia}/reading`, { title: "Holes", author: "Louis Sachar" }), 201);
    assert.equal((await as("pa")("POST", `${H}/learners/${ids.mia}/reading`, { title: "" })).status, 400);
    ok(await as("pa")("PATCH", `${H}/reading/${b.id}`, { minutes: 30 }));
    const done = ok(await as("pa")("PATCH", `${H}/reading/${b.id}`, { minutes: 25, status: "finished", notes: "Loved Wilbur" }));
    assert.deepEqual([done.status, done.minutes, done.notes, !!done.finishedOn], ["finished", 55, "Loved Wilbur", true]);
    const view = ok(await as("supt1")("GET", `${H}/learners/${ids.mia}/reading`));
    assert.deepEqual([view.canEdit, view.books.length, view.totals.finishedThisSchoolYear, view.totals.minutes], [false, 2, 1, 55]);
    assert.equal((await as("supt1")("POST", `${H}/learners/${ids.mia}/reading`, { title: "X" })).body.error, "not_allowed_for_this_learner");
    assert.equal((await as("supt1")("PATCH", `${H}/reading/${b.id}`, { minutes: 5 })).body.error, "not_allowed_for_this_learner");
    const other = ok(await as("p1")("POST", `${H}/families`, { name: "Other Family" }), 201); await switchTo("p1", "homeschool_family", other.membershipId);
    assert.equal((await as("p1")("GET", `${H}/learners/${ids.mia}/reading`)).status, 404);
  });

  it("districts and other contexts see none of it; the runtime role can't delete", async () => {
    const { rows } = await admin.query("SELECT relname, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind='r'", [TABLES]);
    assert.equal(rows.length, TABLES.length); for (const r of rows) assert.ok(r.relforcerowsecurity, r.relname);
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role','superintendent',true)", [ID.d1, USERS.supt1[0]]);
      for (const t of TABLES) assert.equal((await app.query(`SELECT * FROM ${t}`)).rowCount, 0, `a district sees no ${t}`);
      await app.query("ROLLBACK");
      for (const t of TABLES) await assert.rejects(app.query(`DELETE FROM ${t}`), /permission denied/, t);
    } finally { await app.end(); }
  });
});
