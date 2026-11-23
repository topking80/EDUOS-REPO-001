// TEACH-01: the district teacher network against real PostgreSQL, as the
// non-owner runtime role: a directory of teachers and principals across the
// district's schools, conversations across schools, open groups that
// colleagues find, join and leave, adding colleagues, and the limits (no
// families or pupils, no other district, no removing someone else).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("TEACH-01 district teacher network against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, appDb, s = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const asRole = async (role, user, school, sql, params = []) => {
    await appDb.query("BEGIN");
    try {
      await appDb.query("SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role',$3,true),set_config('app.school_id',$4,true)", [ID.d1, user, role, school ?? ""]);
      return (await appDb.query(sql, params)).rows;
    } finally { await appDb.query("ROLLBACK"); }
  };
  let thread, group;

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    appDb = new pg.Client(db.appUrl); await appDb.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "supt2", "p1", "p2", "t1", "tp", "pa", "pu", "vp1"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await appDb?.end(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("the directory lists teachers and principals at every school, and nobody else", async () => {
    const d = ok(await as("t1")("GET", "/api/network/colleagues"));
    const names = d.colleagues.map(c => c.name).sort();
    assert.deepEqual(names, ["Principal S1", "Principal S2", "Teacher Parent"]);
    assert.deepEqual(d.colleagues.find(c => c.name === "Principal S2").schools.map(x => x.name), ["S2"]);
    assert.ok(d.schools.some(x => x.name === "S2"));
    assert.deepEqual(ok(await as("t1")("GET", "/api/network/colleagues?q=s2")).colleagues.map(c => c.name), ["Principal S2"], "search by school");
    assert.deepEqual(ok(await as("t1")("GET", `/api/network/colleagues?schoolId=${ID.s1}`)).colleagues.map(c => c.name).sort(), ["Principal S1", "Teacher Parent"]);
    for (const who of ["pa", "pu", "vp1"]) assert.equal((await as(who)("GET", "/api/network/colleagues")).status, 403, who);
    assert.deepEqual(ok(await as("supt2")("GET", "/api/network/colleagues")).colleagues, [], "another district sees none of them");
  });

  it("a teacher messages a principal at another school; families can't be added", async () => {
    assert.equal((await as("t1")("POST", "/api/network/threads", { subject: "Fractions unit", body: "Hi", participantIds: [USERS.pa[0]] })).body.error, "participant_not_in_network");
    thread = ok(await as("t1")("POST", "/api/network/threads", { subject: "Fractions unit", body: "Could I borrow your fractions plan?", participantIds: [USERS.p2[0]] }), 201);
    const listed = ok(await as("p2")("GET", "/api/comms/threads")).find(t => t.id === thread.id);
    assert.equal(listed.kind, "network"); assert.equal(listed.with_names, "Teacher S1"); assert.equal(listed.student_id, null);
    ok(await as("p2")("POST", `/api/comms/threads/${thread.id}/messages`, { body: "Of course, sending it now." }), 201);
    const view = ok(await as("t1")("GET", `/api/comms/threads/${thread.id}`));
    assert.deepEqual(view.messages.map(m => m.body), ["Could I borrow your fractions plan?", "Of course, sending it now."]);
    assert.equal((await as("tp")("GET", `/api/comms/threads/${thread.id}`)).status, 404, "not a participant");
    const n = await admin.query("SELECT count(*)::int AS n FROM notification_outbox WHERE recipient_user_id=$1 AND ref_id=$2", [USERS.p2[0], thread.id]);
    assert.equal(n.rows[0].n, 1, "the principal at the other school was notified");
    for (const who of ["pa", "vp1"]) assert.equal((await as(who)("POST", "/api/network/threads", { subject: "x", body: "y", participantIds: [USERS.t1[0]] })).status, 403, who);
  });

  it("any member adds colleagues to a conversation", async () => {
    assert.equal(ok(await as("p2")("POST", `/api/network/threads/${thread.id}/participants`, { userIds: [USERS.tp[0]] })).added, 1);
    assert.equal(ok(await as("tp")("GET", `/api/comms/threads/${thread.id}`)).participants.length, 3);
    assert.equal((await as("p2")("POST", `/api/network/threads/${thread.id}/participants`, { userIds: [USERS.pu[0]] })).body.error, "participant_not_in_network");
  });

  it("open groups: listed across schools and to the superintendent, joined, left and rejoined", async () => {
    group = ok(await as("t1")("POST", "/api/network/groups", { name: "Grade 4 math", description: "Fractions, decimals and sharing what works", body: "Welcome!" }), 201);
    const seen = ok(await as("p2")("GET", "/api/network/groups"));
    assert.deepEqual(seen.map(g => [g.name, g.members, g.joined, g.started_at_school]), [["Grade 4 math", 1, false, "S1"]]);
    assert.equal(ok(await as("supt1")("GET", "/api/network/groups")).length, 1, "the superintendent sees it");
    assert.equal(ok(await as("supt2")("GET", "/api/network/groups")).length, 0, "another district doesn't");
    assert.equal((await as("pa")("GET", "/api/network/groups")).status, 403);
    assert.equal((await as("p2")("GET", `/api/comms/threads/${group.id}`)).status, 404, "messages only after joining");
    ok(await as("p2")("POST", `/api/network/groups/${group.id}/join`));
    ok(await as("p2")("POST", `/api/comms/threads/${group.id}/messages`, { body: "Glad to be here." }), 201);
    assert.equal(ok(await as("t1")("GET", "/api/network/groups"))[0].members, 2);
    ok(await as("p2")("POST", `/api/network/threads/${group.id}/leave`));
    assert.equal((await as("p2")("POST", `/api/comms/threads/${group.id}/messages`, { body: "still here?" })).status, 404, "left: no more posting");
    assert.equal(ok(await as("p2")("GET", "/api/comms/threads")).some(t => t.id === group.id), false, "and it leaves their list");
    assert.equal(ok(await as("t1")("GET", "/api/network/groups"))[0].members, 1);
    ok(await as("p2")("POST", `/api/network/groups/${group.id}/join`));
    assert.equal(ok(await as("p2")("GET", `/api/comms/threads/${group.id}`)).messages.length, 2, "rejoining shows the history");
    assert.equal((await as("pa")("POST", `/api/network/groups/${group.id}/join`)).status, 403);
  });

  it("RLS: nobody can remove someone else, and families can't see or join groups", async () => {
    const removed = await asRole("teacher", USERS.t1[0], ID.s1, "UPDATE comms_participants SET left_at=now() WHERE thread_id=$1 AND user_id=$2 RETURNING 1", [group.id, USERS.p2[0]]).catch(e => e);
    assert.ok(removed instanceof Error && /row-level security/.test(removed.message), String(removed));
    assert.equal((await asRole("parent", USERS.pa[0], ID.s1, "SELECT id FROM comms_threads WHERE id=$1", [group.id])).length, 0);
    const joined = await asRole("parent", USERS.pa[0], ID.s1, "INSERT INTO comms_participants(thread_id,district_id,user_id,role,added_by) VALUES($1,$2,$3,'parent',$3)", [group.id, ID.d1, USERS.pa[0]]).catch(e => e);
    assert.ok(joined instanceof Error, "a parent can't add themself");
    const self = await asRole("principal", USERS.p1[0], ID.s1, "INSERT INTO comms_participants(thread_id,district_id,user_id,role,added_by) VALUES($1,$2,$3,'principal',$3)", [thread.id, ID.d1, USERS.p1[0]]).catch(e => e);
    assert.ok(self instanceof Error && /row-level security/.test(self.message), "nobody joins a private conversation on their own");
  });

  it("every network write is audited", async () => {
    const a = await admin.query("SELECT action,resource_type FROM audit_events WHERE resource_type IN ('comms_thread','network_group') ORDER BY occurred_at");
    for (const [action, type] of [["create", "comms_thread"], ["add_participants", "comms_thread"], ["create", "network_group"], ["join", "network_group"], ["leave", "comms_thread"]])
      assert.ok(a.rows.some(r => r.action === action && r.resource_type === type), `${action} ${type}`);
  });
});
