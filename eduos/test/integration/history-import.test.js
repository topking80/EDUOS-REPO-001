// TC-06b: receiving a student's history from another district, against real
// PostgreSQL as the runtime role. The receiving records office uploads the
// signed file; the server checks it; nothing is added until a person confirms
// the sender's fingerprint, chooses the local student and accepts items. An
// accepted item becomes part of the student's history with its origin; the
// same file again, or an item that came before, isn't added twice.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { transferKeys, signTransfer } from "../../src/history-transfer.js";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const ALICE2 = "b0000000-0000-4000-8000-0000000000a2";

describe("TC-06b receiving history transfers against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, owner, s = {}, pkg, pkg2, forged, genuineFp, imp;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const download = async (who, id) => (await fetch(`${server.base}/api/history-transfers/${id}/package`, { headers: { cookie: s[who].cookie } })).json();
  const entry = (title, classification, audience, author, source) => owner.query(
    `INSERT INTO student_history_entries(district_id,school_id,student_id,entry_type,classification,title,body,occurred_at,school_year,audience,status,source_type,author_user_id)
     VALUES ($1,$2,$3,'event',$4,$5,'Body of '||$5,'2026-03-01T00:00:00Z','2025-26',$6,'published',$7,$8)`, [ID.d1, ID.s1, ID.alice, classification, title, audience, source, author]);
  const historyOf = student => admin.query(`SELECT title, classification, audience, status, source_type, source_reference, author_user_id, school_id, school_year
      FROM student_history_entries WHERE student_id=$1 ORDER BY title`, [student]);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, HISTORY_TRANSFER_SIGNING_SECRET: "integration-test-transfer-secret-0123456789" });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    owner = new pg.Client(db.ownerUrl); await owner.connect();
    await owner.query(`SELECT set_config('app.district_id',$1,false)`, [ID.d1]);
    await entry("Report card", "official_record", "school", USERS.p1[0], "school");
    await entry("Volcano project", "teacher_artifact", "classroom", USERS.t1[0], "teacher");
    await entry("Lake day", "family_memory", "family", USERS.pa[0], "guardian");
    await entry("Private note", "family_memory", "private", USERS.pa[0], "guardian");
    // The same girl, newly enrolled in district 2.
    await admin.query(`INSERT INTO students(id,district_id,school_id,local_student_number,display_name,grade_level) VALUES ($1,$2,$3,'D2-A','alice a','3')`, [ALICE2, ID.d2, ID.sd2]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "pa", "supt1", "supt2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    // District 1 sends Alice's history (the family agreed to family items) ...
    const t = ok(await as("p1")("POST", `/api/students/${ID.alice}/history-transfers`,
      { receivingDistrict: "District Two", basis: "enrollment_request", note: "Enrollment request from District Two", includeFamilyItems: true }), 201);
    ok(await as("pa")("POST", `/api/family/history-transfers/${t.id}`, { decision: "approve" }));
    pkg = await download("p1", t.id);
    const d1 = ok(await as("p1")("GET", `/api/students/${ID.alice}/history-transfers`));
    genuineFp = d1.keyFingerprint;
    // ... and later a second, records-only file.
    const t2 = ok(await as("p1")("POST", `/api/students/${ID.alice}/history-transfers`,
      { receivingDistrict: "District Two", basis: "records_request", note: "Second request for the report card", includeFamilyItems: false }), 201);
    pkg2 = await download("p1", t2.id);
    // Someone else's key: a valid signature, but not District 1's.
    const { signature, ...body } = pkg;
    forged = signTransfer({ ...body, packageId: "forged-1" }, transferKeys("someone-elses-secret-that-is-32-chars-long!!"));
  });
  after(async () => { await server?.stop(); await owner?.end(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("only a records office uploads; the file must be signed and unchanged", async () => {
    for (const who of ["t1", "pa"]) assert.equal((await as(who)("POST", "/api/history-imports", pkg)).status, 403, who);
    assert.equal((await as("supt2")("POST", "/api/history-imports", { hello: "world" })).body.error, "not_a_transfer_package");
    const changed = structuredClone(pkg); changed.items[0].title = "Honor roll";
    assert.equal((await as("supt2")("POST", "/api/history-imports", changed)).body.error, "altered");
    const resignedBadly = structuredClone(pkg); resignedBadly.signature.value = forged.signature.value;
    assert.equal((await as("supt2")("POST", "/api/history-imports", resignedBadly)).body.error, "bad_signature");
  });

  it("receiving keeps the file as it came and adds nothing; the same file again is the same import", async () => {
    imp = ok(await as("supt2")("POST", "/api/history-imports", pkg), 201);
    assert.equal(imp.status, "received"); assert.equal(imp.items, 3); assert.equal(imp.fingerprint, genuineFp);
    assert.deepEqual([imp.from.district, imp.from.school, imp.student.name, imp.includesFamily, imp.existing], ["D1", "S1", "Alice A", true, false]);
    const again = ok(await as("supt2")("POST", "/api/history-imports", pkg));
    assert.equal(again.id, imp.id); assert.equal(again.existing, true);
    const file = await (await fetch(`${server.base}/api/history-imports/${imp.id}/file`, { headers: { cookie: s.supt2.cookie } })).json();
    assert.deepEqual(file, pkg, "kept exactly as received");
    const d = ok(await as("supt2")("GET", `/api/history-imports/${imp.id}`));
    assert.deepEqual(d.items.map(i => [i.title, i.decision]).sort(), [["Lake day", "pending"], ["Report card", "pending"], ["Volcano project", "pending"]], "private notes never left district 1");
    assert.deepEqual(d.candidates.map(c => [c.name, c.sameName, c.sameNumber]), [["alice a", true, false]], "a suggestion, not a match");
    assert.equal((await as("p1")("GET", `/api/history-imports/${imp.id}`)).status, 404, "another district can't see it");
    assert.equal((await as("supt2")("POST", `/api/history-imports/${imp.id}/decisions`, { decisions: [{ pos: 1, decision: "accept" }] })).body.error, "not_confirmed");
    assert.equal((await historyOf(ALICE2)).rows.length, 0);
  });

  it("confirming needs the sending district's fingerprint (from them, not the file) and a student this office may choose", async () => {
    const fx = ok(await as("supt2")("POST", "/api/history-imports", forged), 201);
    assert.notEqual(fx.fingerprint, genuineFp);
    const c = (fp, student, id = imp.id) => as("supt2")("POST", `/api/history-imports/${id}/confirm`, { fingerprint: fp, studentId: student });
    assert.equal((await c(genuineFp, ALICE2, fx.id)).body.error, "fingerprint_mismatch", "a forged file fails the out-of-band check");
    assert.equal((await c("0000000000000000", ALICE2)).body.error, "fingerprint_mismatch");
    assert.equal((await c(genuineFp, ID.alice)).body.error, "student_not_found", "not a student of this district");
    const done = ok(await c(genuineFp.toUpperCase().replace(/(.{4})/g, "$1 "), ALICE2));
    assert.equal(done.status, "reviewing"); assert.equal(done.localStudent.id, ALICE2);
    assert.equal((await c(genuineFp, ALICE2)).body.error, "already_confirmed");
    ok(await as("supt2")("POST", `/api/history-imports/${fx.id}/close`, { note: "Not from D1" }));
    const closed = ok(await as("supt2")("GET", `/api/history-imports/${fx.id}`));
    assert.equal(closed.status, "rejected"); assert.ok(closed.items.every(i => i.decision === "rejected"));
  });

  it("accepted items join the student's history as published, with their origin; decisions stick", async () => {
    const d = ok(await as("supt2")("GET", `/api/history-imports/${imp.id}`));
    const pos = t => d.items.find(i => i.title === t).pos;
    const r = ok(await as("supt2")("POST", `/api/history-imports/${imp.id}/decisions`, { decisions: [
      { pos: pos("Report card"), decision: "accept" }, { pos: pos("Lake day"), decision: "accept" }, { pos: pos("Volcano project"), decision: "reject", note: "Not needed" }] }));
    assert.deepEqual(r.results.map(x => x.result), ["accepted", "accepted", "rejected"]);
    assert.equal(r.import.status, "completed");
    const h = (await historyOf(ALICE2)).rows;
    assert.deepEqual(h.map(e => [e.title, e.classification, e.audience, e.status, e.source_type, e.school_id, e.school_year, e.author_user_id]), [
      ["Lake day", "family_memory", "family", "published", "guardian", ID.sd2, "2025-26", null],
      ["Report card", "official_record", "school", "published", "school", ID.sd2, "2025-26", null]]);
    assert.ok(h.every(e => e.source_reference === "Transferred from D1, S1"), h[0].source_reference);
    const rev = (await admin.query(`SELECT DISTINCT actor_user_id FROM student_history_entry_revisions WHERE student_id=$1`, [ALICE2])).rows;
    assert.deepEqual(rev.map(x => x.actor_user_id), [USERS.supt2[0]], "who accepted it");
    assert.equal(ok(await as("supt2")("POST", `/api/history-imports/${imp.id}/decisions`, { decisions: [{ pos: pos("Report card"), decision: "accept" }] })).results[0].result, "unchanged");
    assert.equal((await as("supt2")("POST", `/api/history-imports/${imp.id}/decisions`, { decisions: [{ pos: pos("Report card"), decision: "reject" }] })).body.error, "already_decided", "an added item stays added (archive it like any other)");
    const p = ok(await as("supt2")("GET", `/api/history/portfolio?studentId=${ALICE2}`));
    const rc = p.items.find(i => i.title === "Report card");
    assert.equal(rc.transferredFrom, "D1, S1"); assert.equal(rc.authorName, "Principal S1", "the original author's name travels with it");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM student_history_entries WHERE student_id=$1", [ID.alice])).rows[0].n, 4, "nothing changed at the sending side");
  });

  it("a later file doesn't add the same item twice; another school can't see or take a file received elsewhere", async () => {
    const i2 = ok(await as("supt2")("POST", "/api/history-imports", pkg2), 201);
    ok(await as("supt2")("POST", `/api/history-imports/${i2.id}/confirm`, { fingerprint: genuineFp, studentId: ALICE2 }));
    const d = ok(await as("supt2")("GET", `/api/history-imports/${i2.id}`));
    assert.equal(d.knownFingerprints[0].fingerprint, genuineFp, "this sender's fingerprint was confirmed before");
    const r = ok(await as("supt2")("POST", `/api/history-imports/${i2.id}/decisions`, { decisions: d.items.map(i => ({ pos: i.pos, decision: "accept" })) }));
    const byTitle = Object.fromEntries(d.items.map((i, n) => [i.title, r.results[n].result]));
    assert.deepEqual(byTitle, { "Report card": "duplicate", "Volcano project": "accepted" });
    assert.equal((await historyOf(ALICE2)).rows.filter(e => e.title === "Report card").length, 1);
    // A principal receives for their own school only.
    const mine = ok(await as("p2")("POST", "/api/history-imports", forged), 201);
    assert.equal((await as("p1")("GET", `/api/history-imports/${mine.id}`)).status, 404, "another school");
    assert.equal((await as("p1")("POST", "/api/history-imports", forged)).body.error, "received_elsewhere");
    assert.equal(ok(await as("supt1")("GET", `/api/history-imports/${mine.id}`)).id, mine.id, "the district office sees it");
    assert.equal((await as("p2")("POST", `/api/history-imports/${mine.id}/confirm`, { fingerprint: mine.fingerprint, studentId: ID.alice })).body.error, "student_not_found", "not a student of their school");
  });

  it("the database refuses direct writes", async () => {
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query(`SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role','superintendent',true)`, [ID.d2, USERS.supt2[0]]);
      await assert.rejects(app.query(`UPDATE history_import_items SET decision='accepted'`), /permission denied/);
      await app.query("ROLLBACK"); await app.query("BEGIN");
      await assert.rejects(app.query(`UPDATE history_imports SET status='completed' WHERE id=$1`, [imp.id]), /permission denied/);
      await app.query("ROLLBACK");
    } finally { await app.end(); }
  });
});
