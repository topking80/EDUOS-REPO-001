// Student history and Time Capsule privacy is enforced by the database
// (db/088_student_history_relationship_rls.sql), so it holds for every route.
// Runs as the runtime role with real session contexts. Audit 2026-11-21: under
// 086 another family's parent and a teacher who doesn't teach the student
// could read a private family memory, and another parent could write an
// "official record" into the student's history.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, baseEnv, run, createDatabase, seed } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("student history and Time Capsule: who can see and write what", { skip }, () => {
  let db, app, admin;
  // Run fn as `who` signed in with `role` at `school` (null for the district office).
  const as = async (who, role, school, fn) => {
    await app.query("BEGIN");
    try {
      await app.query(`SELECT set_config('app.district_id',$1,true), set_config('app.school_id',$2,true),
        set_config('app.role',$3,true), set_config('app.user_id',$4,true)`, [ID.d1, school ? ID[school] : "", role, USERS[who][0]]);
      return await fn(app);
    } finally { await app.query("ROLLBACK"); }
  };
  // Same, but keep the writes.
  const commitAs = async (who, role, school, fn) => {
    await app.query("BEGIN");
    try {
      await app.query(`SELECT set_config('app.district_id',$1,true), set_config('app.school_id',$2,true),
        set_config('app.role',$3,true), set_config('app.user_id',$4,true)`, [ID.d1, school ? ID[school] : "", role, USERS[who][0]]);
      const r = await fn(app); await app.query("COMMIT"); return r;
    } catch (e) { await app.query("ROLLBACK"); throw e; }
  };
  const entry = (c, { classification, audience, status, source, author, title = "t", school = "s1" }) => c.query(
    `INSERT INTO student_history_entries(district_id,school_id,student_id,entry_type,classification,title,body,occurred_at,audience,status,source_type,author_user_id)
     VALUES($1,$2,$3,'event',$4,$5,'body text',now(),$6,$7,$8,$9) RETURNING id`,
    [ID.d1, ID[school], ID.alice, classification, title, audience, status, source, author]).then(r => r.rows[0].id);
  const titles = c => c.query("SELECT title FROM student_history_entries WHERE student_id=$1 ORDER BY title", [ID.alice]).then(r => r.rows.map(x => x.title));
  const RLS = /row-level security/;
  const ids = {};

  before(async () => {
    db = await createDatabase();
    const m = await run(["src/migrate.js"], { ...baseEnv({ EDUOS_APP_ROLE: db.names.app, OIDC_ISSUER: "https://idp.test" }), DATABASE_URL: db.ownerUrl });
    assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, "https://idp.test");
    admin = new pg.Client(db.adminUrl); await admin.connect();
    app = new pg.Client(db.appUrl); await app.connect();
    // Parent A writes a private note and a family memory about Alice.
    ids.private = await commitAs("pa", "parent", "s1", c => entry(c, { classification: "family_memory", audience: "private", status: "published", source: "guardian", author: USERS.pa[0], title: "A private note" }));
    ids.family = await commitAs("pa", "parent", "s1", c => entry(c, { classification: "family_memory", audience: "family", status: "published", source: "guardian", author: USERS.pa[0], title: "B family memory" }));
    // The principal records an official, school-wide entry.
    ids.official = await commitAs("p1", "principal", "s1", c => entry(c, { classification: "official_record", audience: "school", status: "published", source: "school", author: USERS.p1[0], title: "C official record" }));
  });
  after(async () => { await app?.end(); await admin?.end(); await db?.drop?.(); });

  it("another family's parent sees nothing of Alice's history", async () => {
    assert.deepEqual(await as("pb", "parent", "s1", titles), []);
    assert.deepEqual(await as("pb", "parent", "s1", c => c.query("SELECT 1 FROM student_history_entry_revisions WHERE student_id=$1", [ID.alice]).then(r => r.rows)), [],
      "nor the revision snapshots");
  });

  it("Alice's own parent sees the private note, the family memory and the school record", async () => {
    assert.deepEqual(await as("pa", "parent", "s1", titles), ["A private note", "B family memory", "C official record"]);
  });

  it("Alice sees family and school entries but not her parent's private note", async () => {
    assert.deepEqual(await as("pu", "pupil", "s1", titles), ["B family memory", "C official record"]);
  });

  it("a teacher sees nothing until they teach Alice, and never the family's entries", async () => {
    assert.deepEqual(await as("t1", "teacher", "s1", titles), []);
    await admin.query("INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$3)",
      [ID.d1, ID.s1, USERS.t1[0], ID.alice]);
    assert.deepEqual(await as("t1", "teacher", "s1", titles), ["C official record"]);
  });

  it("a teacher who is also Alice's parent sees family entries only when signed in as her parent", async () => {
    assert.deepEqual(await as("tp", "teacher", "s1", titles), []);
    assert.deepEqual(await as("tp", "parent", "s1", titles), ["B family memory", "C official record"]);
  });

  it("school leads and the district office see school records but not family memories; another school's principal sees nothing", async () => {
    assert.deepEqual(await as("p1", "principal", "s1", titles), ["C official record"]);
    assert.deepEqual(await as("supt1", "superintendent", null, titles), ["C official record"]);
    assert.deepEqual(await as("p2", "principal", "s2", titles), []);
  });

  it("a role the user doesn't actually hold gives no access", async () => {
    assert.deepEqual(await as("pb", "principal", "s1", titles), [], "Parent Bob claiming to be a principal");
  });

  it("another parent can't write into Alice's history, official or otherwise", async () => {
    await assert.rejects(as("pb", "parent", "s1", c => entry(c, { classification: "official_record", audience: "school", status: "published", source: "school", author: USERS.pb[0] })), RLS);
    await assert.rejects(as("pb", "parent", "s1", c => entry(c, { classification: "family_memory", audience: "family", status: "published", source: "guardian", author: USERS.pb[0] })), RLS);
  });

  it("each relationship writes only its own kind of entry", async () => {
    await assert.rejects(as("pa", "parent", "s1", c => entry(c, { classification: "official_record", audience: "school", status: "published", source: "school", author: USERS.pa[0] })), RLS, "a parent can't write an official record");
    await assert.rejects(as("pa", "parent", "s1", c => entry(c, { classification: "family_memory", audience: "school", status: "published", source: "guardian", author: USERS.pa[0] })), RLS, "a family memory can't be shared school-wide");
    await assert.rejects(as("pu", "pupil", "s1", c => entry(c, { classification: "family_memory", audience: "family", status: "published", source: "guardian", author: USERS.pu[0] })), RLS, "a pupil can't write as a guardian");
    await as("pu", "pupil", "s1", c => entry(c, { classification: "student_portfolio", audience: "family", status: "published", source: "student", author: USERS.pu[0] }));
    await as("t1", "teacher", "s1", c => entry(c, { classification: "teacher_artifact", audience: "classroom", status: "submitted", source: "teacher", author: USERS.t1[0] }));
    await assert.rejects(as("t1", "teacher", "s1", c => entry(c, { classification: "teacher_artifact", audience: "classroom", status: "published", source: "teacher", author: USERS.t1[0] })), RLS, "a teacher can't publish directly");
    await assert.rejects(as("t1", "teacher", "s1", c => entry(c, { classification: "official_record", audience: "school", status: "published", source: "school", author: USERS.t1[0] })), RLS);
    await assert.rejects(as("p1", "principal", "s1", c => entry(c, { classification: "system_milestone", audience: "school", status: "published", source: "system", author: USERS.p1[0] })), RLS, "nobody writes system milestones at runtime");
    await assert.rejects(as("pa", "parent", "s1", c => entry(c, { classification: "family_memory", audience: "family", status: "published", source: "guardian", author: USERS.pb[0] })), RLS, "no writing in someone else's name");
  });

  it("a parent can't widen their family memory to the whole school", async () => {
    await assert.rejects(as("pa", "parent", "s1", c => c.query("UPDATE student_history_entries SET audience='school' WHERE id=$1", [ids.family])), RLS);
    const n = await as("pa", "parent", "s1", c => c.query("UPDATE student_history_entries SET title='B family memory (edited)' WHERE id=$1", [ids.family]).then(r => r.rowCount));
    assert.equal(n, 1, "but can edit it");
    const other = await as("pb", "parent", "s1", c => c.query("UPDATE student_history_entries SET title='x' WHERE id=$1", [ids.family]).then(r => r.rowCount));
    assert.equal(other, 0, "another parent can't touch it");
  });

  it("TC-02 approval: a principal can publish a family memory only in the name of one of Alice's guardians, and can't read it back", async () => {
    // The approver can't see family memories, so the id comes from the app, not RETURNING.
    const id = "c0000000-0000-4000-8000-0000000000aa";
    await as("p1", "principal", "s1", async c => {
      await c.query(`INSERT INTO student_history_entries(id,district_id,school_id,student_id,entry_type,classification,title,body,occurred_at,audience,status,source_type,author_user_id)
        VALUES($1,$2,$3,$4,'reflection','family_memory','Approved memory','text',now(),'family','published','guardian',$5)`, [id, ID.d1, ID.s1, ID.alice, USERS.pa[0]]);
      assert.equal((await c.query("SELECT 1 FROM student_history_entries WHERE id=$1", [id])).rowCount, 0);
    });
    await assert.rejects(as("p1", "principal", "s1", c => entry(c, { classification: "family_memory", audience: "family", status: "published", source: "guardian", author: USERS.pa[0] })), RLS,
      "RETURNING would reveal it, so it is refused");
    const approve = (who, school, author) => as(who, "principal", school, c => c.query(`INSERT INTO student_history_entries(district_id,school_id,student_id,entry_type,classification,title,body,occurred_at,audience,status,source_type,author_user_id)
      VALUES($1,$2,$3,'reflection','family_memory','x','text',now(),'family','published','guardian',$4)`, [ID.d1, ID.s1, ID.alice, author]));
    await assert.rejects(approve("p1", "s1", USERS.pb[0]), RLS, "Parent Bob is not Alice's guardian");
    await assert.rejects(approve("p2", "s2", USERS.pa[0]), RLS, "only Alice's school");
  });

  it("a Time Capsule is private to its owner until it is released to a consenting recipient", async () => {
    const capsule = await commitAs("pa", "parent", "s1", async c => {
      const id = (await c.query(`INSERT INTO student_time_capsules(district_id,school_id,student_id,owner_user_id,title,release_kind,release_at)
        VALUES($1,$2,$3,$4,'For Alice at 18','scheduled',now()+interval '10 years') RETURNING id`, [ID.d1, ID.s1, ID.alice, USERS.pa[0]])).rows[0].id;
      await c.query(`INSERT INTO student_time_capsule_items(district_id,school_id,student_id,capsule_id,entry_id,entry_revision_no) VALUES($1,$2,$3,$4,$5,1)`,
        [ID.d1, ID.s1, ID.alice, id, ids.private]);
      await c.query(`INSERT INTO student_time_capsule_recipients(district_id,school_id,student_id,capsule_id,recipient_user_id,recipient_type) VALUES($1,$2,$3,$4,$5,'student')`,
        [ID.d1, ID.s1, ID.alice, id, USERS.pu[0]]);
      return id;
    });
    const sees = who => [who, ...{ pb: ["parent", "s1"], pu: ["pupil", "s1"], p1: ["principal", "s1"], supt1: ["superintendent", null], pa: ["parent", "s1"] }[who]];
    const count = c => c.query("SELECT count(*)::int n FROM student_time_capsules WHERE id=$1", [capsule]).then(r => r.rows[0].n);
    for (const who of ["pb", "pu", "p1", "supt1"]) assert.equal(await as(...sees(who), count), 0, `${who} can't see the sealed capsule`);
    assert.equal(await as(...sees("pa"), count), 1);
    await assert.rejects(as("pa", "parent", "s1", c => c.query(`INSERT INTO student_time_capsule_recipients(district_id,school_id,student_id,capsule_id,recipient_user_id,recipient_type)
      VALUES($1,$2,$3,$4,$5,'guardian')`, [ID.d1, ID.s1, ID.alice, capsule, USERS.pb[0]])), RLS, "only people related to Alice can be recipients");
    await assert.rejects(as("pb", "parent", "s1", c => c.query(`INSERT INTO student_time_capsule_items(district_id,school_id,student_id,capsule_id,entry_id,entry_revision_no) VALUES($1,$2,$3,$4,$5,1)`,
      [ID.d1, ID.s1, ID.alice, capsule, ids.official])), RLS, "nobody else adds to it");
    // Release (done by the trusted release worker) and the recipient's consent.
    await admin.query("UPDATE student_time_capsules SET status='released', sealed_at=now(), released_at=now(), release_kind='milestone', release_at=NULL, milestone_key='age-18' WHERE id=$1", [capsule]);
    assert.equal(await as(...sees("pu"), count), 0, "released, but Alice hasn't consented yet");
    await commitAs("pu", "pupil", "s1", c => c.query("UPDATE student_time_capsule_recipients SET consent_status='approved' WHERE capsule_id=$1 AND recipient_user_id=$2", [capsule, USERS.pu[0]]));
    assert.equal(await as(...sees("pu"), count), 1, "Alice sees it once released and accepted");
    assert.equal(await as(...sees("pb"), count), 0, "still nobody else");
  });
});
