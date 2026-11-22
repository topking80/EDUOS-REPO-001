// Time Capsule lifecycle through the real API and database rules (db/088,
// db/091): create, fill, name recipients, seal, consent, release (by date or
// confirmed milestone), open, cancel. Nothing is released to anyone who hasn't
// accepted, contents are frozen when added, and withdrawn entries are withheld.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("Time Capsule lifecycle", { skip }, () => {
  let db, idp, server, app, admin;
  const s = {};
  const as = name => client(server.base, s[name]);
  const ids = {};
  const sweep = async () => (await app.query("SELECT outcome FROM eduos_capsule_release_due(100)")).rows.map(r => r.outcome);
  const events = async id => (await admin.query("SELECT event_type FROM student_time_capsule_events WHERE capsule_id=$1 ORDER BY occurred_at, event_type", [id])).rows.map(r => r.event_type);
  const tomorrow = () => new Date(Date.now() + 86400000).toISOString();
  // Change an entry's status as the records system would (the revision trigger needs the district set).
  const setEntryStatus = async (id, status) => {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.district_id',$1,true)", [ID.d1]);
    await admin.query("UPDATE student_history_entries SET status=$2 WHERE id=$1", [id, status]);
    await admin.query("COMMIT");
  };

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, CAPSULE_RELEASE_INTERVAL_SECONDS: "0" });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    app = new pg.Client(db.appUrl); await app.connect();
    // Parent A's private note about Alice (only Parent A can read it in the history).
    await app.query("BEGIN");
    await app.query(`SELECT set_config('app.district_id',$1,true), set_config('app.school_id',$2,true), set_config('app.role','parent',true), set_config('app.user_id',$3,true)`,
      [ID.d1, ID.s1, USERS.pa[0]]);
    ids.note = (await app.query(`INSERT INTO student_history_entries(district_id,school_id,student_id,entry_type,classification,title,body,occurred_at,audience,status,source_type,author_user_id)
      VALUES($1,$2,$3,'reflection','family_memory','The day you were born','We were so happy.',now(),'private','published','guardian',$4) RETURNING id`,
      [ID.d1, ID.s1, ID.alice, USERS.pa[0]])).rows[0].id;
    await app.query("COMMIT");
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["pa", "pb", "pu", "p1", "p2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await app?.end(); await admin?.end(); await server?.stop(); await idp?.close(); await db?.drop?.(); });

  it("a parent creates a capsule, fills it and names Alice; outsiders can't take part", async () => {
    const c = await as("pa")("POST", "/api/history/capsules", { studentId: ID.alice, title: "For Alice at 18", message: "Open this when you're grown.",
      releaseKind: "scheduled", releaseAt: tomorrow(), timezone: "America/New_York" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    ids.dated = c.body.data.id;
    assert.equal((await as("pa")("POST", `/api/history/capsules/${ids.dated}/seal`)).body.error, "capsule_needs_an_item");
    assert.deepEqual((await as("pa")("GET", `/api/history/capsules/${ids.dated}/candidates`)).body.data.map(e => e.title), ["The day you were born"]);
    assert.equal((await as("pb")("GET", `/api/history/capsules/${ids.dated}/candidates`)).status, 404);
    assert.equal((await as("pa")("POST", `/api/history/capsules/${ids.dated}/items`, { entryId: ids.note })).status, 201);
    const options = (await as("pa")("GET", `/api/history/capsule-recipient-options?studentId=${ID.alice}`)).body.data;
    assert.ok(options.some(o => o.userId === USERS.pu[0] && o.type === "student"), JSON.stringify(options));
    assert.ok(!options.some(o => o.userId === USERS.pb[0]), "another family isn't offered");
    assert.equal((await as("pa")("POST", `/api/history/capsules/${ids.dated}/recipients`, { userId: USERS.pb[0], type: "guardian" })).status, 404, "nor accepted");
    assert.equal((await as("pa")("POST", `/api/history/capsules/${ids.dated}/recipients`, { userId: USERS.pu[0], type: "student" })).status, 201);
    assert.equal((await as("pb")("POST", "/api/history/capsules", { studentId: ID.alice, title: "x", releaseKind: "scheduled", releaseAt: tomorrow() })).status, 404,
      "another family can't make a capsule for Alice");
    assert.equal((await as("pb")("GET", `/api/history/capsules/${ids.dated}`)).status, 404);
  });

  it("sealing locks it: no edits, items or recipients afterwards", async () => {
    const sealed = await as("pa")("POST", `/api/history/capsules/${ids.dated}/seal`);
    assert.equal(sealed.body.data.status, "scheduled", JSON.stringify(sealed.body));
    assert.equal((await as("pa")("PATCH", `/api/history/capsules/${ids.dated}`, { title: "changed" })).status, 404);
    assert.equal((await as("pa")("POST", `/api/history/capsules/${ids.dated}/items`, { entryId: ids.note })).status, 409);
    assert.equal((await as("pa")("POST", `/api/history/capsules/${ids.dated}/recipients`, { userId: USERS.pa[0], type: "guardian" })).status, 404);
  });

  it("Alice sees who it's from and when it opens, not what's inside", async () => {
    const inv = (await as("pu")("GET", "/api/history/capsule-invitations")).body.data;
    assert.equal(inv.length, 1);
    assert.deepEqual([inv[0].from, inv[0].consent, inv[0].status], ["Parent A", "pending", "scheduled"]);
    assert.ok(!("title" in inv[0]) && !("items" in inv[0]));
    assert.equal((await as("pu")("GET", `/api/history/capsules/${ids.dated}`)).status, 404);
  });

  it("the date alone doesn't release it: blocked until Alice accepts, logged once", async () => {
    await admin.query("UPDATE student_time_capsules SET release_at=now()-interval '1 minute' WHERE id=$1", [ids.dated]);
    assert.deepEqual(await sweep(), ["blocked"]);
    assert.deepEqual(await sweep(), ["blocked"]);
    assert.equal((await events(ids.dated)).filter(e => e === "release_blocked").length, 1);
    assert.equal((await as("pu")("POST", `/api/history/capsule-invitations/${ids.dated}`, { decision: "approved" })).status, 200);
    assert.deepEqual(await sweep(), ["released"]);
    assert.deepEqual(await sweep(), [], "released once");
  });

  it("once released Alice opens it, including the private note, exactly as it was sealed", async () => {
    await app.query("BEGIN");
    await app.query(`SELECT set_config('app.district_id',$1,true), set_config('app.school_id',$2,true), set_config('app.role','parent',true), set_config('app.user_id',$3,true)`,
      [ID.d1, ID.s1, USERS.pa[0]]);
    await app.query("UPDATE student_history_entries SET title='Edited later' WHERE id=$1", [ids.note]);
    await app.query("COMMIT");
    const opened = await as("pu")("GET", `/api/history/capsules/${ids.dated}`);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.data.title, "For Alice at 18");
    assert.deepEqual(opened.body.data.items.map(i => [i.title, i.withheld]), [["The day you were born", false]], "the revision saved when added");
    assert.equal(opened.body.data.recipients, undefined, "recipients and events are for the owner");
    assert.equal((await as("pb")("GET", `/api/history/capsules/${ids.dated}`)).status, 404);
  });

  it("a withdrawn entry is withheld, and withdrawing consent closes it again", async () => {
    await setEntryStatus(ids.note, "pending_deletion");
    const opened = (await as("pu")("GET", `/api/history/capsules/${ids.dated}`)).body.data;
    assert.deepEqual(opened.items.map(i => [i.withheld, i.title]), [[true, null]]);
    await setEntryStatus(ids.note, "published");
    assert.equal((await as("pu")("POST", `/api/history/capsule-invitations/${ids.dated}`, { decision: "approved" })).status, 409, "no re-answering after release");
    assert.equal((await as("pu")("POST", `/api/history/capsule-invitations/${ids.dated}`, { decision: "withdrawn" })).status, 200);
    assert.equal((await as("pu")("GET", `/api/history/capsules/${ids.dated}`)).status, 404);
    assert.equal((await as("pa")("POST", `/api/history/capsules/${ids.dated}/cancel`)).status, 409, "a released capsule can't be cancelled");
  });

  it("a milestone capsule opens when Alice's school confirms the milestone, and only then", async () => {
    const c = (await as("pa")("POST", "/api/history/capsules", { studentId: ID.alice, title: "Graduation", releaseKind: "milestone", milestone: "graduation" })).body.data;
    await as("pa")("POST", `/api/history/capsules/${c.id}/items`, { entryId: ids.note });
    await as("pa")("POST", `/api/history/capsules/${c.id}/recipients`, { userId: USERS.pu[0], type: "student" });
    assert.equal((await as("pa")("POST", `/api/history/capsules/${c.id}/seal`)).body.data.status, "sealed");
    assert.deepEqual(await sweep(), [], "the sweep never releases milestone capsules");
    const pending = (await as("p1")("GET", "/api/history/capsule-milestones")).body.data;
    assert.deepEqual(pending.map(p => [p.capsuleId, p.studentName, p.milestone, p.accepted]), [[c.id, "Alice A", "graduation", 0]]);
    assert.ok(!("title" in pending[0]), "the school sees the milestone, not the contents");
    assert.deepEqual((await as("p2")("GET", "/api/history/capsule-milestones")).body.data, [], "another school sees none");
    assert.deepEqual((await as("pa")("GET", "/api/history/capsule-milestones")).body.data, [], "a family sees none");
    assert.equal((await as("p1")("POST", `/api/history/capsules/${c.id}/release`)).body.error, "capsule_has_no_consenting_recipient");
    await as("pu")("POST", `/api/history/capsule-invitations/${c.id}`, { decision: "approved" });
    assert.equal((await as("pa")("POST", `/api/history/capsules/${c.id}/release`)).status, 404, "the family can't declare the milestone");
    assert.equal((await as("p2")("POST", `/api/history/capsules/${c.id}/release`)).status, 404, "nor another school");
    const r = await as("p1")("POST", `/api/history/capsules/${c.id}/release`);
    assert.equal(r.body.data.status, "released", JSON.stringify(r.body));
    assert.equal((await as("pu")("GET", `/api/history/capsules/${c.id}`)).status, 200);
    // The refused attempt (no one had accepted) rolled back entirely, so the log shows the successful one.
    assert.deepEqual(await events(c.id), ["sealed", "release_attempted", "released"]);
  });

  it("the owner can cancel before release; nobody else can", async () => {
    const c = (await as("pa")("POST", "/api/history/capsules", { studentId: ID.alice, title: "Never mind", releaseKind: "scheduled", releaseAt: tomorrow() })).body.data;
    assert.equal((await as("pb")("POST", `/api/history/capsules/${c.id}/cancel`)).status, 404);
    assert.equal((await as("pa")("POST", `/api/history/capsules/${c.id}/cancel`)).body.data.status, "cancelled");
  });
});
