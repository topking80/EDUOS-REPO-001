// TC-11: the family storage dashboard against real PostgreSQL as the runtime
// role. Totals come from the same accounting as the upload limit; only the
// student and their current guardians see it; no paths, no other students,
// and nothing about donations changing the limit.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("TC-11 family storage dashboard against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, owner, s = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const storage = (who, student = ID.alice) => as(who)("GET", `/api/history/storage?studentId=${student}`);
  const addPhoto = async (entry, bytes, tier = "standard") => {
    const asset = crypto.randomUUID();
    await admin.query(`INSERT INTO private_media_objects(asset_id,district_id,school_id,storage_key,media_kind,mime_type,byte_size,purpose,scan_status,processing_status,storage_tier)
      VALUES($1,$2,$3,$4,'image','image/jpeg',$5,'history','clean','processed',$6)`, [asset, ID.d1, ID.s1, `history/${ID.d1}/${ID.alice}/${asset}.jpeg`, bytes, tier]);
    await admin.query(`INSERT INTO student_history_entry_attachments(district_id,school_id,student_id,entry_id,asset_id,alt_text,position) VALUES($1,$2,$3,$4,$5,'A photo',
      (SELECT coalesce(max(position)+1,0) FROM student_history_entry_attachments WHERE entry_id=$4))`, [ID.d1, ID.s1, ID.alice, entry, asset]);
  };

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, CAPSULE_RELEASE_INTERVAL_SECONDS: "0" });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    owner = new pg.Client(db.ownerUrl); await owner.connect();
    await owner.query(`SELECT set_config('app.district_id',$1,false)`, [ID.d1]);
    const entry = (await owner.query(`INSERT INTO student_history_entries(district_id,school_id,student_id,entry_type,classification,title,occurred_at,audience,status,source_type,author_user_id)
      VALUES($1,$2,$3,'event','official_record','Science fair',now(),'family','published','school',$4) RETURNING id`, [ID.d1, ID.s1, ID.alice, USERS.p1[0]])).rows[0].id;
    await addPhoto(entry, 3 * 1048576);
    await addPhoto(entry, 2 * 1048576, "archive");
    // Bob's photo never shows up in Alice's totals.
    const bobEntry = (await owner.query(`INSERT INTO student_history_entries(district_id,school_id,student_id,entry_type,classification,title,occurred_at,audience,status,source_type,author_user_id)
      VALUES($1,$2,$3,'event','official_record','Bob award',now(),'family','published','school',$4) RETURNING id`, [ID.d1, ID.s1, ID.bob, USERS.p1[0]])).rows[0].id;
    const bobAsset = crypto.randomUUID();
    await admin.query(`INSERT INTO private_media_objects(asset_id,district_id,school_id,storage_key,media_kind,mime_type,byte_size,purpose,scan_status,processing_status)
      VALUES($1,$2,$3,'history/x/bob.jpeg','image','image/jpeg',9999999,'history','clean','processed')`, [bobAsset, ID.d1, ID.s1]);
    await admin.query(`INSERT INTO student_history_entry_attachments(district_id,school_id,student_id,entry_id,asset_id,alt_text,position) VALUES($1,$2,$3,$4,$5,'Bob',0)`, [ID.d1, ID.s1, ID.bob, bobEntry, bobAsset]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["t1", "p1", "supt1", "supt2", "pa", "pb", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    ok(await as("supt1")("PUT", "/api/history/media-policy", { imagesEnabled: false, maxImageBytes: 5 * 1048576, maxPerEntry: 3, maxBytesPerStudent: 10 * 1048576 }));
  });
  after(async () => { await server?.stop(); await admin?.end(); await owner?.end(); await idp?.close(); await db?.drop(); });

  it("a guardian sees the district's limit, the child's real usage and their own memories", async () => {
    ok(await as("pa")("POST", `/api/family/children/${ID.alice}/history-contributions`, { title: "First bike", body: "No training wheels!", occurredAt: "2026-05-01T15:00:00Z" }), 201);
    const d = ok(await storage("pa"));
    assert.equal(d.student.name, "Alice A");
    assert.equal(d.usage.usedBytes, 5 * 1048576, "Alice's two photos, not Bob's");
    assert.equal(d.usage.photos, 2);
    assert.equal(d.usage.inLongTermStorage, 1);
    assert.equal(d.usage.percent, 50);
    assert.equal(d.usage.roomForAnotherPhoto, true);
    assert.equal(d.limits.maxBytesPerStudent, 10 * 1048576);
    assert.equal(d.limits.setBy, "district");
    assert.equal(d.items.inHistory, 1);
    assert.deepEqual(d.myContributions, { waiting: 1, accepted: 0, declined: 0, withdrawn: 0 });
    assert.equal(d.donations.changeStorage, false);
    assert.ok(!JSON.stringify(d).includes(`history/${ID.d1}`), "no storage paths");
    assert.ok(!JSON.stringify(d).includes("Bob"), "no other students");
    assert.ok(!/upgrade|buy|purchase/i.test(JSON.stringify(d)), "no paid upgrades offered");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE resource_type='history_storage'")).rows[0].n, 1);
  });

  it("the student sees it too; school staff and other families don't", async () => {
    const d = ok(await as("pu")("GET", "/api/history/storage"));
    assert.equal(d.usage.usedBytes, 5 * 1048576);
    assert.equal(d.myContributions, undefined);
    for (const [who, code] of [["t1", 404], ["p1", 403], ["supt1", 403], ["pb", 404], ["supt2", 404]]) assert.equal((await storage(who)).status, code, who);
    assert.equal((await as("pa")("GET", "/api/history/storage?studentId=nope")).status, 400);
  });

  it("the limit reached is shown, and usage follows deletions", async () => {
    await admin.query("UPDATE private_media_objects SET byte_size=byte_size+4*1048576 WHERE byte_size=3*1048576 AND school_id=$1", [ID.s1]);
    assert.equal(ok(await storage("pa")).usage.roomForAnotherPhoto, false);
    await admin.query("UPDATE private_media_objects SET processing_status='failed' WHERE byte_size=7*1048576");
    const d = ok(await storage("pa"));
    assert.equal(d.usage.usedBytes, 2 * 1048576);
    assert.equal(d.usage.photos, 1);
  });

  it("a custody restriction or the student taking over their rights ends a guardian's view", async () => {
    const r = ok(await as("p1")("POST", `/api/students/${ID.alice}/custody-restrictions`, { userId: USERS.pa[0], kind: "court_order", basis: "Order 2026-114" }), 201);
    assert.equal((await storage("pa")).status, 404);
    ok(await as("p1")("POST", `/api/custody-restrictions/${r.id}/lift`, { note: "Order vacated" }));
    ok(await storage("pa"));
    ok(await as("p1")("POST", `/api/students/${ID.alice}/rights-transition`, { basis: "age_18", effectiveOn: "2026-11-01" }), 201);
    assert.notEqual((await storage("pa")).status, 200, "the guardian no longer sees the student's totals");
    ok(await as("pu")("GET", "/api/history/storage"));
  });
});
