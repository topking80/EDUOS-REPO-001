// TC-05: Student History privacy controls against real PostgreSQL, as the
// runtime role: custody restrictions cut a guardian off everywhere; the
// student's rights transition moves guardians to what the student shares;
// grants expire and revoke at once and can't write; emergency access is
// official records only, time-limited and reviewed; every read is logged;
// cross-student and cross-district reads stay denied.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const CO = "a0000000-0000-4000-8000-0000000000f3", PA2 = "a0000000-0000-4000-8000-0000000000f4";

describe("TC-05 history privacy controls against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, owner, s = {}, restriction, grant, emergency;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const titles = async (who, student = ID.alice) => {
    const r = await as(who)("GET", `/api/history/portfolio?studentId=${student}`);
    return r.status === 200 ? r.body.data.items.map(i => i.title).sort() : r.status;
  };
  const entry = (title, classification, audience, source, author, status = "published", student = ID.alice) => owner.query(
    `INSERT INTO student_history_entries(district_id,school_id,student_id,entry_type,classification,title,occurred_at,audience,status,source_type,author_user_id)
     VALUES ($1,$2,$3,'event',$4,$5,now(),$6,$7,$8,$9)`, [ID.d1, ID.s1, student, classification, title, audience, status, source, author]);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES ($2,$1,'co1','Counselor S1','co1@d1.test')", [idp.issuer, CO]);
    await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES ($2,$1,$3,'counselor',true)", [ID.d1, CO, ID.s1]);
    // Alice's second guardian.
    await admin.query("INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES ($2,$1,'pa2','Parent Two','pa2@d1.test')", [idp.issuer, PA2]);
    await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES ($2,$1,$3,'parent',true)", [ID.d1, PA2, ID.s1]);
    await admin.query("INSERT INTO student_user_links(district_id,user_id,student_id,relationship) VALUES ($1,$2,$3,'guardian')", [ID.d1, PA2, ID.alice]);
    owner = new pg.Client(db.ownerUrl); await owner.connect();
    await owner.query(`SELECT set_config('app.district_id',$1,false)`, [ID.d1]);
    await admin.query(`INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [ID.d1, ID.s1, USERS.t1[0], ID.alice, USERS.p1[0]]);
    await entry("Report card", "official_record", "school", "school", USERS.p1[0]);
    await entry("Science fair", "student_portfolio", "family", "student", USERS.pu[0]);
    await entry("Grandma's visit", "family_memory", "family", "guardian", USERS.pa[0]);
    await entry("Private note", "official_record", "private", "school", USERS.p1[0]);
    await entry("Bob's award", "official_record", "school", "school", USERS.p1[0], "published", ID.bob);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "tp", "pa", "pb", "pu", "supt1", "supt2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    s.co1 = await login(server.base, idp, "co1", { email: "co1@d1.test", email_verified: true });
    s.pa2 = await login(server.base, idp, "pa2", { email: "pa2@d1.test", email_verified: true });
  });
  after(async () => { await server?.stop(); await owner?.end(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("before any control: who sees what (and nobody crosses students or districts)", async () => {
    assert.deepEqual(await titles("pa"), ["Grandma's visit", "Report card", "Science fair"]);
    assert.deepEqual(await titles("pa2"), ["Grandma's visit", "Report card", "Science fair"], "the other guardian");
    assert.deepEqual(await titles("t1"), ["Report card"]);
    assert.equal(await titles("pb"), 404, "another family's child");
    assert.equal(await titles("co1"), 404, "a counselor has no relationship");
    assert.equal(await titles("supt2"), 404, "another district");
    assert.equal(await titles("pa", ID.bob), 404);
  });

  it("a custody restriction cuts a guardian off, with a basis, and is lifted with a note", async () => {
    assert.equal((await as("t1")("POST", `/api/students/${ID.alice}/custody-restrictions`, { userId: PA2, kind: "court_order", basis: "Order 2026-114" })).status, 403);
    assert.equal((await as("p2")("POST", `/api/students/${ID.alice}/custody-restrictions`, { userId: PA2, kind: "court_order", basis: "Order 2026-114" })).status, 404, "another school's office");
    assert.equal((await as("p1")("POST", `/api/students/${ID.alice}/custody-restrictions`, { userId: USERS.pb[0], kind: "court_order", basis: "Order 2026-114" })).body.error, "not_a_guardian_of_this_student");
    restriction = ok(await as("p1")("POST", `/api/students/${ID.alice}/custody-restrictions`, { userId: PA2, kind: "court_order", basis: "Order 2026-114", documentRef: "Records drawer 3" }), 201);
    assert.equal(await titles("pa2"), 404, "no access at all");
    assert.deepEqual(await titles("pa"), ["Grandma's visit", "Report card", "Science fair"], "the other guardian is unaffected");
    const isGuardian = (await admin.query(`SELECT eduos_history_user_is($1,$2,$3,$4,'guardian') AS g`, [ID.d1, ID.s1, ID.alice, PA2])).rows[0].g;
    assert.equal(isGuardian, false, "can't be named a capsule recipient either");
    assert.equal((await as("p1")("POST", `/api/custody-restrictions/${restriction.id}/lift`, {})).body.error, "note_required");
    ok(await as("p1")("POST", `/api/custody-restrictions/${restriction.id}/lift`, { note: "Order vacated 2026-12-01" }));
    assert.deepEqual(await titles("pa2"), ["Grandma's visit", "Report card", "Science fair"]);
    const v = ok(await as("supt1")("GET", `/api/students/${ID.alice}/history-privacy`));
    assert.deepEqual(v.restrictions.map(r => [r.person, r.kind, r.liftNote]), [["Parent Two", "court_order", "Order vacated 2026-12-01"]]);
  });

  it("when the student takes over their rights, guardians see only what they wrote and what the student shares", async () => {
    assert.equal((await as("pu")("POST", "/api/history/sharing", { granteeUserId: USERS.pa[0], classifications: ["official_record"], days: 30 })).body.error, "rights_not_yet_yours");
    const today = (await admin.query(`SELECT current_date::text AS d`)).rows[0].d;
    ok(await as("p1")("POST", `/api/students/${ID.alice}/rights-transition`, { basis: "age_18", effectiveOn: today }), 201);
    assert.deepEqual(await titles("pa"), ["Grandma's visit"], "only what this guardian wrote");
    assert.deepEqual(await titles("pa2"), [], "nothing they wrote, nothing shared with them");
    assert.deepEqual(await titles("pu"), ["Grandma's visit", "Report card", "Science fair"], "the student unchanged");
    assert.equal((await as("pu")("POST", "/api/history/sharing", { granteeUserId: USERS.pb[0], classifications: ["official_record"], days: 30 })).status, 403, "only to their own guardians");
    grant = ok(await as("pu")("POST", "/api/history/sharing", { granteeUserId: USERS.pa[0], classifications: ["official_record"], days: 30 }), 201);
    assert.deepEqual(await titles("pa"), ["Grandma's visit", "Report card"], "shared: official records");
    assert.deepEqual(ok(await as("pa")("GET", "/api/history/sharing")).grantsToMe.map(g => g.classifications), [["official_record"]]);
    // A grant reads; it never writes.
    const w = await as("pa")("POST", `/api/family/children/${ID.alice}/history-contributions`, { title: "x", body: "y", entryType: "event", occurredAt: new Date().toISOString() });
    assert.ok([403, 404, 400].includes(w.status), `write refused (${w.status})`);
    ok(await as("pu")("POST", `/api/history/sharing/${grant.id}/revoke`, {}));
    assert.deepEqual(await titles("pa"), ["Grandma's visit"], "revoking takes effect at once");
    const g2 = ok(await as("pu")("POST", "/api/history/sharing", { granteeUserId: USERS.pa[0], classifications: ["student_portfolio"], days: 1 }), 201);
    await admin.query(`UPDATE history_sharing_grants SET created_at=now()-interval '2 days', expires_at=now()-interval '1 second' WHERE id=$1`, [g2.id]);
    assert.deepEqual(await titles("pa"), ["Grandma's visit"], "an expired grant gives nothing");
    ok(await as("p1")("POST", `/api/students/${ID.alice}/rights-transition/reverse`, { note: "Recorded for the wrong student" }));
    assert.deepEqual(await titles("pa"), ["Grandma's visit", "Report card", "Science fair"]);
  });

  it("emergency access: official records only, four hours, reviewed by the superintendent", async () => {
    assert.equal((await as("co1")("POST", `/api/students/${ID.alice}/emergency-access`, { reason: "short" })).body.error, "reason_required");
    emergency = ok(await as("co1")("POST", `/api/students/${ID.alice}/emergency-access`, { reason: "Student in crisis; need prior safety plan on record" }), 201);
    assert.ok(Date.parse(emergency.expiresAt) - Date.now() <= 4 * 3600e3 + 5000);
    assert.deepEqual(await titles("co1"), ["Report card"], "official records only, not private ones or family items");
    assert.equal(await titles("co1", ID.bob), 404, "only that student");
    const review = ok(await as("supt1")("GET", "/api/history/emergency-access?review=pending"));
    assert.deepEqual(review.map(r => [r.person, r.student]), [["Counselor S1", "Alice A"]]);
    ok(await as("supt1")("POST", `/api/emergency-access/${emergency.id}/review`, { note: "Appropriate" }));
    assert.equal(await titles("co1"), 404, "a reviewed window is closed");
    await assert.rejects(admin.query(`INSERT INTO history_emergency_access(district_id,school_id,student_id,user_id,role,reason,expires_at) VALUES($1,$2,$3,$4,'counselor','x'||repeat('y',30),now()+interval '5 hours')`,
      [ID.d1, ID.s1, ID.alice, CO]), /check constraint/, "never longer than four hours");
  });

  it("every read is logged; the student, guardians and the office can see who looked", async () => {
    const log = ok(await as("pu")("GET", `/api/students/${ID.alice}/history-access-log`));
    assert.ok(log.some(l => l.who === "Counselor S1" && l.access === "emergency"), "the emergency read is visible to the student");
    assert.ok(log.some(l => l.who === "Teacher S1" && l.access === "teacher"));
    assert.ok(ok(await as("pa")("GET", `/api/students/${ID.alice}/history-access-log`)).length >= 1);
    assert.deepEqual(ok(await as("pb")("GET", `/api/students/${ID.alice}/history-access-log`)), [], "another family sees nothing");
    assert.deepEqual(ok(await as("supt2")("GET", `/api/students/${ID.alice}/history-access-log`)), []);
  });
});
