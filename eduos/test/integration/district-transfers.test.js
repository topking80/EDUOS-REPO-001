// HSP-06 part 3: school districts in the learner transfer workflow, against
// real PostgreSQL as the non-owner runtime role: the superintendent's switch,
// the records office, guardian release (and custody restrictions), receiving
// onto an existing student only, no district-to-district use, isolation.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("HSP-06 part 3 district transfers", { skip }, () => {
  let db, idp, server, admin, s = {}, ids = {}, codes = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const H = "/api/homeschool";
  const switchTo = async (name, kind, membershipId) => {
    const r = await fetch(`${server.base}/api/session/context`, { method: "POST", headers: { "content-type": "application/json", cookie: s[name].cookie, "x-csrf-token": s[name].csrf },
      body: JSON.stringify({ kind, membershipId }) });
    const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j));
    s[name] = { cookie: r.headers.getSetCookie().map(c => c.split(";")[0]).find(c => !c.endsWith("=")), csrf: j.csrfToken };
  };
  const contextOf = async (name, kind) => (await as(name)("GET", "/api/session/contexts")).body.data.contexts.find(c => c.kind === kind).membershipId;
  const prepareAlice = async () => ok(await as("p1")("POST", "/api/transfers", { learnerId: ID.alice, purpose: "return_to_homeschool", sections: ["enrollment", "final_grades", "attendance"] }), 201);

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    // Alice has a posted grade (corrected once) and attendance.
    const { rows: [k] } = await admin.query("INSERT INTO courses(district_id, school_id, teacher_user_id, title, subject, grade_level, term) VALUES ($1,$2,$3,'Math 3','Math','3','Fall') RETURNING id", [ID.d1, ID.s1, USERS.t1[0]]);
    const { rows: [g] } = await admin.query("INSERT INTO course_final_grades(district_id, school_id, course_id, student_id, percent, letter, posted_by) VALUES ($1,$2,$3,$4,81,'B-',$5) RETURNING id", [ID.d1, ID.s1, k.id, ID.alice, USERS.t1[0]]);
    await admin.query("INSERT INTO course_final_grades(district_id, school_id, course_id, student_id, percent, letter, posted_by, supersedes, reason) VALUES ($1,$2,$3,$4,88,'B+',$5,$6,'Regraded the final project')", [ID.d1, ID.s1, k.id, ID.alice, USERS.t1[0], g.id]);
    await admin.query("INSERT INTO attendance_events(district_id, student_id, event_date, status) VALUES ($1,$2,current_date,'present'), ($1,$2,current_date - 1,'absent')", [ID.d1, ID.alice]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["supt1", "supt2", "p1", "p2", "t1", "pa", "pb"]) s[n] = await login(server.base, idp, n, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("a district takes part only after its superintendent turns transfers on", async () => {
    assert.equal(ok(await as("p1")("GET", "/api/transfers/settings")).enabled, false);
    assert.equal((await as("p1")("POST", "/api/transfers", { learnerId: ID.alice, purpose: "other", sections: ["enrollment"] })).body.error, "district_transfers_off");
    assert.equal((await as("p1")("PUT", "/api/transfers/settings", { enabled: true })).body.error, "superintendent_only");
    ok(await as("supt1")("PUT", "/api/transfers/settings", { enabled: true }));
    assert.equal(ok(await as("p1")("GET", "/api/transfers/settings")).enabled, true);
  });

  it("the records office prepares; a linked guardian releases; only that guardian's family can receive it", async () => {
    assert.equal((await as("p2")("POST", "/api/transfers", { learnerId: ID.alice, purpose: "other", sections: ["enrollment"] })).body.error, "records_office_only", "another school's principal");
    assert.equal((await as("t1")("POST", "/api/transfers", { learnerId: ID.alice, purpose: "other", sections: ["enrollment"] })).body.error, "records_office_only");
    assert.equal((await as("p1")("POST", "/api/transfers", { learnerId: ID.alice, purpose: "other", sections: ["courses"] })).body.error, "invalid_sections");
    const t = await prepareAlice();
    assert.deepEqual([t.status, t.items, t.code], ["awaiting_release", 3, undefined]);
    const snap = (await admin.query("SELECT snapshot FROM learner_transfers WHERE id=$1", [t.id])).rows[0].snapshot;
    assert.deepEqual(snap.items.find(i => i.kind === "final_grade").detail.letter, "B+", "the corrected grade, not the one it replaced");
    assert.deepEqual(snap.items.find(i => i.kind === "attendance_year").detail.counts, { present: 1, absent: 1 });
    assert.equal(ok(await as("pa")("GET", "/api/transfers")).find(x => x.id === t.id).status, "awaiting_release", "the guardian sees it waiting");
    assert.equal((await as("pb")("POST", `/api/transfers/${t.id}/release`, {})).body.error, "transfer_not_found", "not Bob's guardian");
    assert.equal((await as("p1")("POST", `/api/transfers/${t.id}/release`, {})).body.error, "transfer_not_found", "staff don't release");
    codes.alice = ok(await as("pa")("POST", `/api/transfers/${t.id}/release`, {})).code;
    // Another family can't take it; Alice's guardian's own family can.
    const fb = ok(await as("pb")("POST", `${H}/families`, { name: "Bob Homeschool" }), 201); await switchTo("pb", "homeschool_family", fb.membershipId);
    assert.equal((await as("pb")("POST", `${H}/transfers/receive/preview`, { code: codes.alice })).body.error, "guardian_of_this_learner_only");
    const fa = ok(await as("pa")("POST", `${H}/families`, { name: "Alice Homeschool" }), 201); await switchTo("pa", "homeschool_family", fa.membershipId);
    const p = ok(await as("pa")("POST", `${H}/transfers/receive/preview`, { code: codes.alice }));
    assert.match(p.provenance, /^Issued by S1 in D1, a school district on EduOS\. Not a certified transcript/);
    const a = ok(await as("pa")("POST", `${H}/transfers/receive/accept`, { code: codes.alice }));
    const recs = ok(await as("pa")("GET", `${H}/learners/${a.learnerId}/transferred-records`));
    assert.deepEqual(recs.map(r => r.kind).sort(), ["attendance_year", "enrollment", "final_grade"]);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM students WHERE id=$1", [ID.alice])).rows[0].n, 1, "the district's record stays");
    assert.equal(ok(await as("p1")("GET", "/api/transfers")).find(x => x.id === t.id).to, "Alice Homeschool");
  });

  it("a guardian under a custody restriction can't release", async () => {
    await switchTo("pa", "district", await contextOf("pa", "district"));
    const t = await prepareAlice();
    await admin.query("INSERT INTO student_custody_restrictions(district_id, school_id, student_id, restricted_user_id, kind, basis, set_by) VALUES ($1,$2,$3,$4,'court_order','Court order on file',$5)",
      [ID.d1, ID.s1, ID.alice, USERS.pa[0], USERS.p1[0]]);
    assert.equal((await as("pa")("POST", `/api/transfers/${t.id}/release`, {})).body.error, "transfer_not_found");
    ok(await as("p1")("POST", `/api/transfers/${t.id}/revoke`, { reason: "Custody order received" }));
    await admin.query("UPDATE student_custody_restrictions SET lifted_at=now(), lifted_by=$1, lift_note='Order ended in test' WHERE student_id=$2", [USERS.p1[0], ID.alice]);
  });

  it("a district receives onto an existing student it chooses, never a new or guessed one", async () => {
    // Bob's guardian (now in a homeschool family) sends a family record to the district.
    const learner = ok(await as("pb")("POST", `${H}/learners`, { displayName: "Bob B", gradeBand: "3" }), 201).id;
    ok(await as("pb")("POST", `${H}/learners/${learner}/courses`, { title: "Reading 3", schoolYear: "2025-2026" }), 201);
    const t = ok(await as("pb")("POST", `${H}/transfers`, { learnerId: learner, purpose: "enrollment", sections: ["courses"] }), 201);
    assert.equal((await as("t1")("POST", "/api/transfers/receive/preview", { code: t.code })).body.error, "records_office_only");
    assert.equal((await as("supt2")("POST", "/api/transfers/receive/preview", { code: t.code })).body.error, "district_transfers_off", "D2 hasn't turned transfers on");
    ok(await as("p1")("POST", "/api/transfers/receive/preview", { code: t.code }));
    assert.equal((await as("p1")("POST", "/api/transfers/receive/accept", { code: t.code })).body.error, "student_required");
    assert.equal((await as("p1")("POST", "/api/transfers/receive/accept", { code: t.code, studentId: ID.carol })).body.error, "student_required", "not this principal's school");
    assert.equal((await as("p1")("POST", "/api/transfers/receive/accept", { code: t.code, studentId: ID.xavier })).body.error, "student_required", "another district's student");
    const a = ok(await as("p1")("POST", "/api/transfers/receive/accept", { code: t.code, studentId: ID.bob }));
    assert.equal(a.learnerId, ID.bob);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM students")).rows[0].n, 4, "no student was created");
    const recs = ok(await as("supt1")("GET", `/api/students/${ID.bob}/transferred-records`));
    assert.match(recs[0].provenance, /Entered by the Bob Homeschool homeschool family/);
    assert.deepEqual(ok(await as("p2")("GET", `/api/students/${ID.bob}/transferred-records`)), [], "another school's principal");
    assert.deepEqual(ok(await as("t1")("GET", `/api/students/${ID.bob}/transferred-records`)), [], "teachers don't see received records in this slice");
    ok(await as("p1")("POST", `/api/transferred-records/${recs[0].id}/void`, { reason: "Duplicate of our own record" }));
    const { rows } = await admin.query("SELECT action FROM audit_events WHERE district_id=$1 AND resource_type IN ('learner_transfer','learner_transfer_settings')", [ID.d1]);
    for (const x of ["enable", "prepare", "release", "revoke", "accept", "void_record"]) assert.ok(rows.some(r => r.action === x), x);
  });

  it("district-to-district stays on the signed history transfer; other districts see nothing", async () => {
    ok(await as("supt2")("PUT", "/api/transfers/settings", { enabled: true }));
    const t = await prepareAlice();
    await switchTo("pa", "district", await contextOf("pa", "district"));
    const code = ok(await as("pa")("POST", `/api/transfers/${t.id}/release`, {})).code;
    assert.equal((await as("supt2")("POST", "/api/transfers/receive/preview", { code })).body.error, "use_the_signed_history_transfer");
    assert.deepEqual(ok(await as("supt2")("GET", "/api/transfers")), []);
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role','superintendent',true)", [ID.d2, USERS.supt2[0]]);
      assert.equal((await app.query("SELECT id FROM learner_transfers")).rowCount, 0);
      assert.equal((await app.query("SELECT id FROM transferred_records")).rowCount, 0);
      await app.query("ROLLBACK");
      await assert.rejects(app.query("DELETE FROM district_transfer_settings"), /permission denied/);
    } finally { await app.end(); }
  });
});
