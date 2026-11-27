// TC-06c: online delivery of a history transfer to another district on the
// same EduOS deployment, against real PostgreSQL as the runtime role. Only
// opted-in districts receive; only the records office delivers a ready
// transfer; nothing is added until the receiving records office chooses the
// student and accepts items; cancelling withdraws an unconfirmed delivery.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("TC-06c online delivery between districts", { skip }, () => {
  let db, idp, server, admin, owner, s = {}, t1, t2;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const start = (who, body = {}) => as(who)("POST", `/api/students/${ID.alice}/history-transfers`,
    { receivingDistrict: "D2", basis: "enrollment_request", note: "D2 asked for Alice's records", includeFamilyItems: false, ...body });
  const deliver = (who, id, districtId = ID.d2) => as(who)("POST", `/api/history-transfers/${id}/deliver`, { districtId });

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, HISTORY_TRANSFER_SIGNING_SECRET: "integration-test-transfer-secret-0123456789" });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    owner = new pg.Client(db.ownerUrl); await owner.connect();
    await owner.query(`SELECT set_config('app.district_id',$1,false)`, [ID.d1]);
    for (const [title, cls, aud] of [["Report card", "official_record", "school"], ["Lake day", "family_memory", "family"]])
      await owner.query(`INSERT INTO student_history_entries(district_id,school_id,student_id,entry_type,classification,title,body,occurred_at,audience,status,source_type,author_user_id)
        VALUES ($1,$2,$3,'event',$4,$5,'',now(),$6,'published','school',$7)`, [ID.d1, ID.s1, ID.alice, cls, title, aud, USERS.p1[0]]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["p1", "p2", "t1", "pa", "supt1", "supt2"]) s[n] = await login(server.base, idp, n, { email_verified: true });
  });
  after(async () => { await server?.stop(); await owner?.end(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("only districts that opted in receive, and only the records office delivers a ready transfer", async () => {
    t1 = ok(await start("p1"), 201);
    assert.deepEqual(ok(await as("p1")("GET", "/api/history-delivery/directory")), [], "no district receives yet");
    assert.equal((await deliver("p1", t1.id)).body.error, "district_not_receiving");
    assert.equal((await as("p1")("PUT", "/api/history-delivery/settings", { accepting: true })).body.error, "superintendent_only");
    ok(await as("supt2")("PUT", "/api/history-delivery/settings", { accepting: true }));
    assert.deepEqual(ok(await as("p1")("GET", "/api/history-delivery/directory")), [{ id: ID.d2, name: "D2" }]);
    assert.deepEqual(ok(await as("supt2")("GET", "/api/history-delivery/directory")), [], "not to itself");
    assert.equal((await deliver("t1", t1.id)).status, 403);
    assert.equal((await deliver("pa", t1.id)).status, 403);
    assert.equal((await deliver("p2", t1.id)).status, 404, "another school's principal");
    const fam = ok(await start("p1", { includeFamilyItems: true }), 201);
    assert.equal((await deliver("p1", fam.id)).body.error, "awaiting_family_decision");
  });

  it("the delivery lands with the receiving district office; nothing is added until it chooses the student and accepts", async () => {
    ok(await deliver("p1", t1.id));
    assert.equal((await deliver("p1", t1.id)).body.error, "already_delivered");
    const list = ok(await as("p1")("GET", `/api/students/${ID.alice}/history-transfers`)).transfers.find(x => x.id === t1.id);
    assert.equal(list.deliveredTo, "D2"); assert.ok(list.deliveredAt);
    assert.equal(ok(await as("pa")("GET", `/api/students/${ID.alice}/history-access-log`)).filter(l => l.action === "transfer_package").length, 1, "the family sees the delivery");
    assert.deepEqual(ok(await as("supt1")("GET", "/api/history-imports")), [], "the sender doesn't see the receiver's list");
    const inbox = ok(await as("supt2")("GET", "/api/history-imports"));
    assert.equal(inbox.length, 1);
    assert.deepEqual([inbox[0].deliveredOnline, inbox[0].from.district, inbox[0].student.name, inbox[0].items], [true, "D1", "Alice A", 1]);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM student_history_entries WHERE district_id=$1", [ID.d2])).rows[0].n, 0, "nothing added on delivery");
    // EduOS attests the sender: no fingerprint to type.
    ok(await as("supt2")("POST", `/api/history-imports/${inbox[0].id}/confirm`, { studentId: ID.xavier }));
    const d = ok(await as("supt2")("POST", `/api/history-imports/${inbox[0].id}/decisions`, { decisions: [{ pos: 1, decision: "accept" }] }));
    assert.equal(d.results[0].result, "accepted");
    const { rows } = await admin.query("SELECT title, source_reference FROM student_history_entries WHERE district_id=$1", [ID.d2]);
    assert.deepEqual(rows, [{ title: "Report card", source_reference: "Transferred from D1, S1" }]);
    const audit = await admin.query("SELECT action, actor_role FROM audit_events WHERE district_id=$1 AND resource_type='history_import' ORDER BY occurred_at", [ID.d2]);
    assert.equal(audit.rows[0].action, "delivered_in"); assert.match(audit.rows[0].actor_role, /^other_district:principal/);
    // Cancelling now doesn't reach into the receiver's history.
    ok(await as("p1")("POST", `/api/history-transfers/${t1.id}/cancel`, { note: "Too late to withdraw" }));
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM student_history_entries WHERE district_id=$1", [ID.d2])).rows[0].n, 1);
  });

  it("cancelling before the receiver chooses a student withdraws the delivery", async () => {
    t2 = ok(await start("p1"), 201);
    ok(await deliver("supt1", t2.id));
    const imp = ok(await as("supt2")("GET", "/api/history-imports")).find(i => i.status === "received");
    const c = ok(await as("p1")("POST", `/api/history-transfers/${t2.id}/cancel`, { note: "Family is staying" }));
    assert.equal(c.deliveryWithdrawn, true);
    const after = ok(await as("supt2")("GET", `/api/history-imports/${imp.id}`));
    assert.deepEqual([after.status, after.withdrawn], ["rejected", true]); assert.match(after.closeNote, /Withdrawn by the sending district: Family is staying/);
    assert.equal((await as("supt2")("POST", `/api/history-imports/${imp.id}/confirm`, { studentId: ID.xavier })).body.error, "withdrawn_by_sender");
  });

  it("an uploaded file still needs the fingerprint; the runtime role can't write deliveries directly", async () => {
    const t3 = ok(await start("p1"), 201);
    const r = await fetch(`${server.base}/api/history-transfers/${t3.id}/package`, { headers: { cookie: s.p1.cookie } });
    const file = await r.json();
    const up = ok(await as("supt2")("POST", "/api/history-imports", file), 201);
    assert.equal(up.deliveredOnline, false);
    assert.equal((await as("supt2")("POST", `/api/history-imports/${up.id}/confirm`, { studentId: ID.xavier })).body.error, "fingerprint_mismatch");
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query(`SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role','superintendent',true)`, [ID.d1, USERS.supt1[0]]);
      await assert.rejects(app.query(`UPDATE history_transfers SET delivered_to=$1`, [ID.d2]), /permission denied/);
      await app.query("ROLLBACK");
      await assert.rejects(app.query("DELETE FROM history_delivery_settings"), /permission denied/);
    } finally { await app.end(); }
  });
});
