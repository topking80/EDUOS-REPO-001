// TC-03 end to end: a teacher submits an item for a student they teach, the
// school reviews it, and the family accepts or declines it. Runs through the
// real API with the database privacy rules (db/088, db/090).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("TC-03 teacher contributions: teacher -> school -> family", { skip }, () => {
  let db, idp, server, app, admin;
  const s = {};
  const as = name => client(server.base, s[name]);
  // What `who` (signed in as `role` at `school`) can read in Alice's history.
  const visible = async (who, role, school) => {
    await app.query("BEGIN");
    try {
      await app.query(`SELECT set_config('app.district_id',$1,true), set_config('app.school_id',$2,true),
        set_config('app.role',$3,true), set_config('app.user_id',$4,true)`, [ID.d1, school ? ID[school] : "", role, USERS[who][0]]);
      return (await app.query("SELECT title FROM student_history_entries WHERE student_id=$1 ORDER BY title", [ID.alice])).rows.map(r => r.title);
    } finally { await app.query("ROLLBACK"); }
  };
  const submit = title => as("t1")("POST", `/api/students/${ID.alice}/history/teacher-items`,
    { title, body: "Built a working volcano model.", occurredAt: "2026-10-15T15:00:00Z", entryType: "project" });
  const review = (who, id, body) => as(who)("POST", `/api/history-review/${id}`, body);
  const decide = (who, id, body) => as(who)("POST", `/api/family/children/${ID.alice}/history-items/${id}`, body);
  const ids = {};

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["t1", "p1", "supt1", "pa", "pb", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    app = new pg.Client(db.appUrl); await app.connect();
  });
  after(async () => { await app?.end(); await admin?.end(); await server?.stop(); await idp?.close(); await db?.drop?.(); });

  it("a teacher can only submit for students they teach", async () => {
    const r = await submit("Not my student yet");
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, "student_not_on_your_roster");
    await admin.query("INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$3)",
      [ID.d1, ID.s1, USERS.t1[0], ID.alice]);
    const ok = await submit("Volcano project");
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.status, "submitted");
    ids.volcano = ok.body.data.id;
  });

  it("while it's with the school, the family and the student can't see it", async () => {
    assert.deepEqual(await visible("pa", "parent", "s1"), []);
    assert.deepEqual(await visible("pu", "pupil", "s1"), []);
    assert.deepEqual((await as("pa")("GET", `/api/family/children/${ID.alice}/history-items/pending`)).body.data, []);
  });

  it("the school can ask for changes (with a reason); the teacher edits and resubmits", async () => {
    const queue = await as("p1")("GET", "/api/history-review");
    assert.deepEqual(queue.body.data.map(x => x.title), ["Volcano project"]);
    assert.equal(queue.body.data[0].studentName, "Alice A");
    assert.equal((await review("p1", ids.volcano, { decision: "request_changes" })).status, 400, "a reason is required");
    const back = await review("p1", ids.volcano, { decision: "request_changes", reasonCode: "needs_edits", note: "Add the date of the fair." });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.data.status, "draft");
    const mine = (await as("t1")("GET", "/api/teacher/history-items")).body.data;
    assert.deepEqual(mine[0].decisions.map(d => [d.decision, d.reasonCode]), [["submitted", null], ["changes_requested", "needs_edits"]]);
    assert.equal((await as("t1")("PATCH", `/api/teacher/history-items/${ids.volcano}`, { title: "Volcano project (science fair, Oct 15)" })).status, 200);
    assert.equal((await as("t1")("POST", `/api/teacher/history-items/${ids.volcano}/submit`)).body.data.status, "submitted");
  });

  it("approved by the school, it waits for the family; the student doesn't see it yet", async () => {
    const ok = await review("p1", ids.volcano, { decision: "approve" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.status, "approved");
    assert.deepEqual((await as("pa")("GET", `/api/family/children/${ID.alice}/history-items/pending`)).body.data.map(x => x.title),
      ["Volcano project (science fair, Oct 15)"]);
    assert.deepEqual(await visible("pu", "pupil", "s1"), [], "the student sees it only once the family accepts");
    assert.deepEqual(await visible("pb", "parent", "s1"), [], "another family never sees it");
    assert.equal((await as("t1")("PATCH", `/api/teacher/history-items/${ids.volcano}`, { title: "edited after approval" })).status, 404,
      "the teacher can't change it once approved");
  });

  it("only the student's own family can decide; once accepted the student sees it", async () => {
    assert.equal((await decide("pb", ids.volcano, { decision: "accept" })).status, 404, "another parent can't");
    const ok = await decide("pa", ids.volcano, { decision: "accept" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.status, "published");
    assert.deepEqual(await visible("pu", "pupil", "s1"), ["Volcano project (science fair, Oct 15)"]);
    assert.deepEqual(await visible("pa", "parent", "s1"), ["Volcano project (science fair, Oct 15)"]);
    assert.equal((await decide("pa", ids.volcano, { decision: "decline" })).status, 409, "it's already decided");
  });

  it("the family can decline; the item is hidden from the family again and the teacher sees why", async () => {
    const id = (await submit("Class photo caption")).body.data.id;
    assert.equal((await review("supt1", id, { decision: "approve" })).body.data.status, "approved", "the district office can review too");
    const no = await decide("pa", id, { decision: "decline", note: "We'd rather keep this one private." });
    assert.equal(no.body.data.status, "restricted");
    assert.ok(!(await visible("pa", "parent", "s1")).includes("Class photo caption"));
    const mine = (await as("t1")("GET", "/api/teacher/history-items")).body.data.find(x => x.id === id);
    assert.equal(mine.status, "restricted");
    assert.deepEqual(mine.decisions.at(-1), { ...mine.decisions.at(-1), decision: "declined", reasonCode: "family_preference", by: "guardian" });
  });

  it("the school can reject (with a reason) and the family never sees it", async () => {
    const id = (await submit("Group photo")).body.data.id;
    const r = await review("p1", id, { decision: "reject", reasonCode: "other_students_identifiable" });
    assert.equal(r.body.data.status, "restricted");
    assert.deepEqual((await as("pa")("GET", `/api/family/children/${ID.alice}/history-items/pending`)).body.data, []);
    assert.ok(!(await visible("pa", "parent", "s1")).includes("Group photo"));
  });

  it("nobody reviews their own item, and the wrong roles are turned away", async () => {
    // A principal's own teacher artifact (088 allows school leads to write one).
    await app.query("BEGIN");
    try {
      await app.query(`SELECT set_config('app.district_id',$1,true), set_config('app.school_id',$2,true),
        set_config('app.role','principal',true), set_config('app.user_id',$3,true)`, [ID.d1, ID.s1, USERS.p1[0]]);
      const own = "c0000000-0000-4000-8000-0000000000b1";
      await app.query(`INSERT INTO student_history_entries(id,district_id,school_id,student_id,entry_type,classification,title,occurred_at,audience,status,source_type,author_user_id)
        VALUES($1,$2,$3,$4,'project','teacher_artifact','Own item',now(),'family','submitted','school',$5)`, [own, ID.d1, ID.s1, ID.alice, USERS.p1[0]]);
      await assert.rejects(app.query("SELECT eduos_history_review($1,'approve',NULL,NULL)", [own]), /self_review_forbidden/);
    } finally { await app.query("ROLLBACK"); }
    assert.equal((await as("t1")("GET", "/api/history-review")).status, 403);
    assert.equal((await as("pa")("POST", `/api/students/${ID.alice}/history/teacher-items`,
      { title: "x", body: "", occurredAt: "2026-10-15T15:00:00Z" })).status, 403);
    assert.equal((await review("p1", ids.volcano, { decision: "approve" })).status, 409, "already decided");
  });

  it("the decision log is permanent and can't be written directly", async () => {
    await app.query("BEGIN");
    try {
      await app.query(`SELECT set_config('app.district_id',$1,true), set_config('app.school_id',$2,true),
        set_config('app.role','principal',true), set_config('app.user_id',$3,true)`, [ID.d1, ID.s1, USERS.p1[0]]);
      await app.query("SAVEPOINT a");
      await assert.rejects(app.query("UPDATE student_history_entry_decisions SET note='x'"), /permission denied/);
      await app.query("ROLLBACK TO SAVEPOINT a");
      await assert.rejects(app.query(`INSERT INTO student_history_entry_decisions(district_id,school_id,student_id,entry_id,actor_user_id,actor_relation,decision)
        VALUES($1,$2,$3,$4,$5,'school_lead','approved')`, [ID.d1, ID.s1, ID.alice, ids.volcano, USERS.p1[0]]), /permission denied/);
    } finally { await app.query("ROLLBACK"); }
    const n = (await admin.query("SELECT count(*)::int n FROM student_history_entry_decisions WHERE entry_id=$1", [ids.volcano])).rows[0].n;
    assert.equal(n, 5, "submitted, changes requested, submitted, approved, accepted");
  });
});
