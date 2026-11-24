// TC-06a: sending a student's history to another district as a signed file,
// against real PostgreSQL as the runtime role. Only the school's records office
// starts one; records go on its authority; family memories and the portfolio
// only with the family's agreement (the student's once they hold their own
// rights); private items, drafts and other students never; the package is
// signed and the same every time; every download is logged; nothing is sent
// automatically and nothing in the records changes.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { verifyTransfer } from "../../src/history-transfer.js";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("TC-06a history transfer packages against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, owner, s = {}, records, withFamily;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const download = async (who, id) => {
    const r = await fetch(`${server.base}/api/history-transfers/${id}/package`, { headers: { cookie: s[who].cookie } });
    const text = await r.text();
    return { status: r.status, headers: r.headers, json: JSON.parse(text) };
  };
  const entry = (title, classification, audience, status = "published", student = ID.alice, author = USERS.p1[0], source = "school") => owner.query(
    `INSERT INTO student_history_entries(district_id,school_id,student_id,entry_type,classification,title,body,occurred_at,audience,status,source_type,author_user_id)
     VALUES ($1,$2,$3,'event',$4,$5,'',now(),$6,$7,$8,$9)`, [ID.d1, ID.s1, student, classification, title, audience, status, source, author]);
  const start = (who, body) => as(who)("POST", `/api/students/${ID.alice}/history-transfers`,
    { receivingDistrict: "Lakeside Unified", basis: "enrollment_request", note: "Records request from Lakeside, Nov 20", includeFamilyItems: false, ...body });

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
    await entry("Report card", "official_record", "school");
    await entry("Volcano project", "teacher_artifact", "family", "published", ID.alice, USERS.t1[0], "teacher");
    await entry("Lake day", "family_memory", "family", "published", ID.alice, USERS.pa[0], "guardian");
    await entry("My best essay", "student_portfolio", "family", "published", ID.alice, USERS.pu[0], "student");
    await entry("Private note", "family_memory", "private", "published", ID.alice, USERS.pa[0], "guardian");
    await entry("Draft report", "official_record", "school", "draft");
    await entry("Bob's award", "official_record", "school", "published", ID.bob);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "vp1", "t1", "pa", "pb", "pu", "supt1", "supt2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await owner?.end(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("only the school's records office starts a transfer, with a basis", async () => {
    for (const who of ["t1", "pa", "pu"]) assert.equal((await start(who)).status, 403, who);
    assert.equal((await start("p2")).status, 404, "another school");
    assert.equal((await start("supt2")).status, 404, "another district");
    assert.equal((await start("p1", { note: "" })).body.error, "invalid_transfer");
    assert.equal((await start("p1", { basis: "because" })).body.error, "invalid_transfer");
    records = ok(await start("vp1"), 201);
    assert.equal(records.status, "ready"); assert.equal(records.items, 2);
  });

  it("records only: official records and teacher items; never family items, private notes, drafts or other students", async () => {
    const r = await download("p1", records.id);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition"), /^attachment; filename="history-transfer-Alice-A-[0-9a-f]{8}\.json"$/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const v = verifyTransfer(r.json);
    assert.equal(v.ok, true, "signed by this district");
    assert.deepEqual(v.body.items.map(i => [i.title, i.kind]).sort(), [["Report card", "official_record"], ["Volcano project", "teacher_artifact"]]);
    assert.deepEqual(v.body.student, { name: "Alice A", localStudentNumber: v.body.student.localStudentNumber, gradeLevel: v.body.student.gradeLevel });
    assert.equal(v.body.receiving.name, "Lakeside Unified"); assert.equal(v.body.includes.familyItems, false);
    const again = await download("supt1", records.id);
    assert.equal(again.json.signature.sha256, r.json.signature.sha256, "the same package every time");
    const t = ok(await as("p1")("GET", `/api/students/${ID.alice}/history-transfers`));
    assert.equal(t.transfers[0].downloads, 2); assert.equal(t.transfers[0].packageSha256, r.json.signature.sha256); assert.equal(t.keyFingerprint, v.fingerprint);
    const log = ok(await as("pa")("GET", `/api/students/${ID.alice}/history-access-log`));
    assert.equal(log.filter(l => l.action === "transfer_package").length, 2, "the family sees each download under Who looked");
    for (const who of ["t1", "pa"]) assert.equal((await download(who, records.id)).status, 403, who);
    for (const who of ["p2", "supt2"]) assert.equal((await download(who, records.id)).status, 404, who);
  });

  it("family items wait for the family; the guardian agrees (another family can't); private notes still never go", async () => {
    withFamily = ok(await start("p1", { includeFamilyItems: true }), 201);
    assert.equal(withFamily.status, "awaiting_family");
    assert.equal((await download("p1", withFamily.id)).json.error, "awaiting_family_decision");
    assert.equal(ok(await as("pb")("GET", "/api/family/history-transfers")).length, 0);
    assert.equal((await as("pb")("POST", `/api/family/history-transfers/${withFamily.id}`, { decision: "approve" })).status, 404);
    assert.equal((await as("pu")("POST", `/api/family/history-transfers/${withFamily.id}`, { decision: "approve" })).status, 404, "a minor student doesn't decide");
    const pending = ok(await as("pa")("GET", "/api/family/history-transfers"));
    assert.deepEqual(pending.map(p => [p.studentName, p.receivingDistrict]), [["Alice A", "Lakeside Unified"]]);
    assert.equal(ok(await as("pa")("POST", `/api/family/history-transfers/${withFamily.id}`, { decision: "approve" })).decision, "approved");
    assert.equal((await as("pa")("POST", `/api/family/history-transfers/${withFamily.id}`, { decision: "decline" })).status, 409, "decided once");
    const v = verifyTransfer((await download("p1", withFamily.id)).json);
    assert.deepEqual(v.body.items.map(i => i.title).sort(), ["Lake day", "My best essay", "Report card", "Volcano project"]);
    assert.equal(v.body.includes.familyItems, true);
  });

  it("once the student holds their own rights, they decide (not the guardian); declining sends records only", async () => {
    ok(await as("p1")("POST", `/api/students/${ID.alice}/rights-transition`, { basis: "age_18", effectiveOn: "2026-11-01" }), 201);
    const t = ok(await start("p1", { includeFamilyItems: true, basis: "family_request", note: "Alice asked for her records to go to college" }), 201);
    assert.equal((await as("pa")("POST", `/api/family/history-transfers/${t.id}`, { decision: "approve" })).status, 404);
    assert.equal(ok(await as("pu")("POST", `/api/family/history-transfers/${t.id}`, { decision: "decline" })).decision, "declined");
    const v = verifyTransfer((await download("p1", t.id)).json);
    assert.deepEqual(v.body.items.map(i => i.title).sort(), ["Report card", "Volcano project"]);
  });

  it("a cancelled transfer can't be downloaded; nothing in the records changed; the database refuses direct writes", async () => {
    assert.equal((await as("p1")("POST", `/api/history-transfers/${records.id}/cancel`, { note: "" })).body.error, "note_required");
    ok(await as("p1")("POST", `/api/history-transfers/${records.id}/cancel`, { note: "Family moved elsewhere" }));
    assert.equal((await download("p1", records.id)).json.error, "transfer_cancelled");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM student_history_entries WHERE student_id=$1 AND status='published'", [ID.alice])).rows[0].n, 5, "unchanged");
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query(`SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role','principal',true),set_config('app.school_id',$3,true)`, [ID.d1, USERS.p1[0], ID.s1]);
      await assert.rejects(app.query(`UPDATE history_transfers SET status='ready' WHERE id=$1`, [records.id]), /permission denied/);
      await app.query("ROLLBACK");
    } finally { await app.end(); }
  });
});
