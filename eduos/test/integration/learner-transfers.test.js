// HSP-06: controlled learner transfers between homeschool families and private
// schools against real PostgreSQL, as the non-owner runtime role: field
// selection, guardian release, explicit acceptance, provenance, correction,
// revocation and isolation.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const today = () => new Date().toISOString().slice(0, 10);

describe("HSP-06 learner transfers", { skip }, () => {
  let db, idp, server, admin, env, s = {}, ids = {}, codes = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const H = "/api/homeschool", P = "/api/private-school";
  const switchTo = async (name, kind, membershipId) => {
    const r = await fetch(`${server.base}/api/session/context`, { method: "POST", headers: { "content-type": "application/json", cookie: s[name].cookie, "x-csrf-token": s[name].csrf },
      body: JSON.stringify({ kind, membershipId }) });
    const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j));
    s[name] = { cookie: r.headers.getSetCookie().map(c => c.split(";")[0]).find(c => !c.endsWith("=")), csrf: j.csrfToken };
  };
  const contextOf = async (name, kind) => (await as(name)("GET", "/api/session/contexts")).body.data.contexts.find(c => c.kind === kind).membershipId;
  const verify = async sid => assert.equal((await run(["src/private-school-verify.js", "--school", sid, "--ref", "Registry", "--by", "Trust"], { ...env, DATABASE_URL: db.ownerUrl })).code, 0);

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["pa", "pb", "p1", "supt1", "supt1b", "t1"]) s[n] = await login(server.base, idp, n, { email_verified: true });
    // Family A (pa) teaches Mia.
    const fa = ok(await as("pa")("POST", `${H}/families`, { name: "Ortiz Homeschool" }), 201); await switchTo("pa", "homeschool_family", fa.membershipId); ids.famA = fa.familyId;
    ids.mia = ok(await as("pa")("POST", `${H}/learners`, { displayName: "Mia Ortiz", gradeBand: "4" }), 201).id;
    ok(await as("pa")("POST", `${H}/learners/${ids.mia}/courses`, { title: "Math 4", subject: "Math", schoolYear: "2025-2026" }), 201);
    ok(await as("pa")("POST", `${H}/learners/${ids.mia}/attendance`, { day: today(), minutes: 240 }), 201);
    ok(await as("pa")("POST", `${H}/learners/${ids.mia}/work`, { title: "Fractions test", kind: "test", doneOn: today(), score: 18, maxScore: 20, notes: "Private note" }), 201);
    // A co-educator with educational authority can't send her records.
    const ti = ok(await as("pa")("POST", `${H}/invitations`, { email: USERS.t1[2], role: "co_educator", learnerIds: [ids.mia] }), 201).token;
    ok(await as("t1")("POST", `${H}/invitations/accept`, { token: ti })); await switchTo("t1", "homeschool_family", await contextOf("t1", "homeschool_family"));
    // School S (p1 admin, supt1 registrar) with Ava, whose guardian is pb.
    const ss = ok(await as("p1")("POST", `${P}/schools`, { legalName: "Hillside Academy, Inc.", displayName: "Hillside Academy", campusName: "Main Campus" }), 201);
    ids.schoolS = ss.schoolId; ids.main = ss.campusId; await switchTo("p1", "private_school", ss.membershipId); await verify(ids.schoolS);
    ids.ava = ok(await as("p1")("POST", `${P}/learners`, { displayName: "Ava Lin", campusId: ids.main, gradeLevel: "5" }), 201).id;
    for (const [who, body] of [["supt1", { email: USERS.supt1[2], role: "registrar" }], ["pb", { email: USERS.pb[2], role: "guardian", learnerIds: [ids.ava] }]]) {
      const t = ok(await as("p1")("POST", `${P}/invitations`, body), 201).token;
      await switchTo(who, "private_school", ok(await as(who)("POST", `${P}/invitations/accept`, { token: t })).membershipId);
    }
    // School T (supt1b), not yet verified.
    const st = ok(await as("supt1b")("POST", `${P}/schools`, { legalName: "Other Prep LLC", displayName: "Other Prep", campusName: "Campus" }), 201);
    ids.schoolT = st.schoolId; ids.tCampus = st.campusId; await switchTo("supt1b", "private_school", st.membershipId);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("a family sends chosen records with a one-time code; only full authority can send", async () => {
    assert.equal((await as("t1")("POST", `${H}/transfers`, { learnerId: ids.mia, purpose: "enrollment", sections: ["courses"] })).body.error, "full_authority_required");
    assert.equal((await as("pa")("POST", `${H}/transfers`, { learnerId: ids.mia, purpose: "enrollment", sections: ["report_cards"] })).body.error, "invalid_sections");
    const t = ok(await as("pa")("POST", `${H}/transfers`, { learnerId: ids.mia, purpose: "enrollment", sections: ["courses", "attendance", "work"], note: "Starting in January" }), 201);
    assert.equal(t.status, "ready"); assert.equal(t.items, 3); assert.match(t.code, /^[A-Za-z0-9_-]{40,}$/);
    codes.a = t.code; ids.tA = t.id;
    const { rows } = await admin.query("SELECT snapshot::text AS s, token_hash FROM learner_transfers WHERE id=$1", [t.id]);
    assert.ok(!rows[0].s.includes("Private note"), "notes aren't sent"); assert.ok(!rows[0].s.includes(t.code) && rows[0].token_hash.length === 64, "only the code's hash is kept");
  });

  it("the receiving school previews, then a verified school's registrar accepts it as a new learner with provenance", async () => {
    assert.equal((await as("pa")("POST", `${H}/transfers/receive/preview`, { code: codes.a })).body.error, "same_family_or_school");
    assert.equal((await as("supt1b")("POST", `${P}/transfers/receive/preview`, { code: codes.a })).body.error, "school_not_verified");
    assert.equal((await as("pb")("POST", `${P}/transfers/receive/preview`, { code: codes.a })).body.error, "registrar_or_admin_only");
    assert.equal((await as("supt1")("POST", `${P}/transfers/receive/preview`, { code: "x".repeat(43) })).body.error, "transfer_code_not_valid");
    const p = ok(await as("supt1")("POST", `${P}/transfers/receive/preview`, { code: codes.a }));
    assert.deepEqual([p.from, p.learner.displayName, p.purpose, p.items.length], ["Ortiz Homeschool", "Mia Ortiz", "enrollment", 3]);
    assert.match(p.provenance, /Entered by the Ortiz Homeschool homeschool family\. Not verified by EduOS/);
    assert.equal((await as("supt1")("POST", `${P}/transfers/receive/accept`, { code: codes.a })).body.error, "campus_required");
    const a = ok(await as("supt1")("POST", `${P}/transfers/receive/accept`, { code: codes.a, campusId: ids.main }));
    assert.equal(a.records, 3);
    assert.equal((await as("supt1")("POST", `${P}/transfers/receive/accept`, { code: codes.a, campusId: ids.main })).body.error, "transfer_code_not_valid", "codes work once");
    const learners = ok(await as("p1")("GET", `${P}/learners`));
    assert.ok(learners.some(l => l.id === a.learnerId && l.displayName === "Mia Ortiz" && l.gradeLevel === "4"));
    const recs = ok(await as("p1")("GET", `${P}/learners/${a.learnerId}/transferred-records`));
    assert.deepEqual(recs.map(r => r.kind).sort(), ["attendance_year", "course", "work"]);
    assert.ok(recs.every(r => /Not verified by EduOS/.test(r.provenance)));
    // Corrections are voids with a reason; the record itself can't change.
    const work = recs.find(r => r.kind === "work");
    assert.equal((await as("supt1")("POST", `${P}/transferred-records/${work.id}/void`, { reason: "x" })).status, 400);
    ok(await as("supt1")("POST", `${P}/transferred-records/${work.id}/void`, { reason: "Duplicate of our placement test" }));
    await assert.rejects(admin.query("UPDATE transferred_records SET title='Changed' WHERE id=$1", [work.id]), /only be voided/);
    // The family's own records stay where they are; it sees where the transfer went.
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM family_courses WHERE learner_id=$1", [ids.mia])).rows[0].n, 1);
    const mine = ok(await as("pa")("GET", `${H}/transfers`)).find(x => x.id === ids.tA);
    assert.deepEqual([mine.status, mine.to, mine.direction], ["accepted", "Hillside Academy", "sent"]);
    assert.equal(mine.receiverLearnerId, undefined, "the sender doesn't learn the receiver's record id");
    assert.equal(ok(await as("p1")("GET", `${P}/transfers`)).find(x => x.id === ids.tA).direction, "received");
  });

  it("a school's transfer waits for a guardian with full authority to release it, and goes only to that guardian's family", async () => {
    ok(await as("p1")("POST", `${P}/attendance`, { day: today(), marks: [{ learnerId: ids.ava, status: "present" }] }));
    await admin.query(`INSERT INTO ps_report_cards(school_id, learner_id, school_year, term, status, comment, created_by, published_by, published_at)
      VALUES ($1,$2,'2025-2026','Spring','published','Strong year',$3,$3,now()), ($1,$2,'2026-2027','Fall','draft',NULL,$3,NULL,NULL)`, [ids.schoolS, ids.ava, USERS.p1[0]]);
    assert.equal((await as("pb")("POST", `${P}/transfers`, { learnerId: ids.ava, purpose: "return_to_homeschool", sections: ["enrollment"] })).body.error, "registrar_or_admin_only");
    const t = ok(await as("supt1")("POST", `${P}/transfers`, { learnerId: ids.ava, purpose: "return_to_homeschool", sections: ["enrollment", "report_cards", "attendance"] }), 201);
    assert.equal(t.status, "awaiting_release"); assert.equal(t.code, undefined, "no code until a guardian releases it"); assert.equal(t.items, 3, "the draft report card isn't included");
    assert.equal((await as("supt1")("POST", `${P}/transfers/${t.id}/release`, {})).body.error, "transfer_not_found", "staff can't release it");
    assert.equal(ok(await as("pb")("GET", `${P}/transfers`)).find(x => x.id === t.id).status, "awaiting_release", "the guardian sees it waiting");
    const r = ok(await as("pb")("POST", `${P}/transfers/${t.id}/release`, {}));
    codes.b = r.code; ids.tB = t.id;
    // Another family can't take it, even with the code.
    assert.equal((await as("pa")("POST", `${H}/transfers/receive/preview`, { code: codes.b })).body.error, "guardian_of_this_learner_only");
    // pb's own homeschool family can.
    const fb = ok(await as("pb")("POST", `${H}/families`, { name: "Lin Homeschool" }), 201); await switchTo("pb", "homeschool_family", fb.membershipId);
    const p = ok(await as("pb")("POST", `${H}/transfers/receive/preview`, { code: codes.b }));
    assert.match(p.provenance, /^Issued by Hillside Academy \(Hillside Academy, Inc\.\), a private school verified by the platform on \d{4}-\d{2}-\d{2}\. Not an accreditation or a government record\.$/);
    assert.deepEqual(p.items.map(i => i.kind), ["enrollment", "report_card", "attendance_year"]);
    const a = ok(await as("pb")("POST", `${H}/transfers/receive/accept`, { code: codes.b }));
    const recs = ok(await as("pb")("GET", `${H}/learners/${a.learnerId}/transferred-records`));
    assert.equal(recs.find(x => x.kind === "report_card").detail.comment, "Strong year");
    assert.equal(recs.find(x => x.kind === "attendance_year").detail.present, 1);
    assert.equal((await admin.query("SELECT enrollment_status FROM private_school_learners WHERE id=$1", [ids.ava])).rows[0].enrollment_status, "enrolled", "no automatic withdrawal");
    await switchTo("pb", "private_school", await contextOf("pb", "private_school"));
  });

  it("the sender can revoke before it's decided; a receiver can decline with a reason", async () => {
    const t = ok(await as("pa")("POST", `${H}/transfers`, { learnerId: ids.mia, purpose: "records_request", sections: ["courses"] }), 201);
    ok(await as("pa")("POST", `${H}/transfers/${t.id}/revoke`, { reason: "Sent to the wrong school" }));
    assert.equal((await as("supt1")("POST", `${P}/transfers/receive/preview`, { code: t.code })).body.error, "transfer_code_not_valid");
    assert.equal((await as("pa")("POST", `${H}/transfers/${t.id}/revoke`, { reason: "again" })).body.error, "already_decided");
    const d = ok(await as("pa")("POST", `${H}/transfers`, { learnerId: ids.mia, purpose: "other", sections: ["work"] }), 201);
    ok(await as("supt1")("POST", `${P}/transfers/receive/decline`, { code: d.code, reason: "Not enrolling this year" }));
    const mine = ok(await as("pa")("GET", `${H}/transfers`));
    assert.equal(mine.find(x => x.id === t.id).status, "revoked");
    assert.deepEqual([mine.find(x => x.id === d.id).status, mine.find(x => x.id === d.id).declineReason], ["declined", "Not enrolling this year"]);
    assert.equal((await as("pa")("POST", `${H}/transfers/${ids.tA}/revoke`, { reason: "Too late" })).body.error, "already_decided", "an accepted transfer stays accepted");
    const { rows } = await admin.query(`SELECT action FROM family_audit_events WHERE family_id=$1 AND resource_type='learner_transfer'
      UNION ALL SELECT action FROM private_school_audit_events WHERE school_id=$2 AND resource_type='learner_transfer'`, [ids.famA, ids.schoolS]);
    for (const a of ["prepare", "revoke", "accept", "decline", "release", "void_record"]) assert.ok(rows.some(r => r.action === a), a);
  });

  it("others see none of it; the runtime role only reads, the snapshot is frozen and the code's hash is hidden", async () => {
    await verify(ids.schoolT);
    assert.deepEqual(ok(await as("supt1b")("GET", `${P}/transfers`)), []);
    assert.equal(ok(await as("t1")("GET", `${H}/transfers`)).length, 0, "a co-educator without full authority sees no transfers");
    await assert.rejects(admin.query("UPDATE learner_transfers SET snapshot='{}' WHERE id=$1", [ids.tA]), /frozen/);
    await assert.rejects(admin.query("DELETE FROM learner_transfers WHERE id=$1", [ids.tA]), /kept/);
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role','superintendent',true)", [ID.d1, USERS.supt1[0]]);
      assert.equal((await app.query("SELECT id FROM learner_transfers")).rowCount, 0, "a district sees no transfers");
      assert.equal((await app.query("SELECT id FROM transferred_records")).rowCount, 0);
      assert.equal((await app.query("SELECT eduos_transfer_preview($1) AS out", ["0".repeat(64)])).rows[0].out.error, "transfer_code_not_valid");
      await app.query("ROLLBACK");
      await assert.rejects(app.query("SELECT token_hash FROM learner_transfers"), /permission denied/);
      await assert.rejects(app.query("UPDATE learner_transfers SET status='accepted'"), /permission denied/);
      await assert.rejects(app.query("INSERT INTO transferred_records(transfer_id, kind, title, detail, provenance) VALUES (gen_random_uuid(),'work','x','{}','x')"), /permission denied/);
    } finally { await app.end(); }
  });
});
