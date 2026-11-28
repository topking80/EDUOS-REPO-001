// SEC-01 part 6 (db/181): club and sport media consent and athletic consents.
// A parent sees only their own child's rows, and one family's consent never
// approves media other families haven't agreed to.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("consent and media row security (181)", { skip }, () => {
  let db, idp, server, admin, app, s = {}, club, asset;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const probe = async (who, role, fn) => {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role',$3,true), set_config('app.school_id',$4,true)", [ID.d1, USERS[who][0], role, ID.s1]);
      return await fn();
    } finally { await app.query("ROLLBACK"); }
  };

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["p1", "t1", "pa", "pb", "pu"]) s[n] = await login(server.base, idp, n, { email_verified: true });
    club = ok(await as("p1")("POST", "/api/activities", { kind: "club", title: "Robotics Club", status: "published" }), 201);
    asset = (await admin.query(`INSERT INTO activity_media_assets(district_id,school_id,activity_id,media_kind,storage_key,mime_type,byte_size,uploaded_by)
      VALUES($1,$2,$3,'image','k/1.jpg','image/jpeg',1000,$4) RETURNING id`, [ID.d1, ID.s1, club.id, USERS.p1[0]])).rows[0].id;
    app = new pg.Client(db.appUrl); await app.connect();
  });
  after(async () => { await app?.end(); await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("one family's consent doesn't approve media others haven't agreed to", async () => {
    ok(await as("p1")("POST", `/api/media/${asset}/participants`, { studentIds: [ID.alice, ID.bob] }), 201);
    assert.equal(ok(await as("pa")("POST", `/api/media/${asset}/consent`, { studentId: ID.alice, action: "grant" })).consentStatus, "pending", "Bob's family hasn't decided");
    assert.equal(ok(await as("pb")("POST", `/api/media/${asset}/consent`, { studentId: ID.bob, action: "grant" })).consentStatus, "approved");
    assert.equal(ok(await as("pa")("POST", `/api/media/${asset}/consent`, { studentId: ID.alice, action: "withdraw" })).consentStatus, "withdrawn");
    assert.equal((await as("pa")("POST", `/api/media/${asset}/consent`, { studentId: ID.bob, action: "grant" })).status >= 400, true, "not their child");
  });

  it("families see only their own child's participation and decisions; staff see the item's", async () => {
    for (const t of ["activity_media_participants", "activity_media_consents", "activity_media_consent_history"]) {
      const seen = async (who, role) => (await probe(who, role, () => app.query(`SELECT DISTINCT student_id FROM ${t}`))).rows.map(r => r.student_id).sort();
      assert.deepEqual(await seen("pa", "parent"), [ID.alice], `${t}: parent`);
      assert.deepEqual(await seen("pu", "pupil"), [ID.alice], `${t}: pupil`);
      assert.deepEqual(await seen("p1", "principal"), [ID.alice, ID.bob].sort(), `${t}: principal`);
    }
    await assert.rejects(probe("pa", "parent", () => app.query(`INSERT INTO activity_media_consents(district_id,school_id,media_asset_id,student_id,guardian_user_id,status,decided_at)
      VALUES($1,$2,$3,$4,$5,'approved',now())`, [ID.d1, ID.s1, asset, ID.bob, USERS.pa[0]])), /row-level security/, "for another family's child");
    await assert.rejects(probe("pa", "parent", () => app.query("INSERT INTO activity_media_participants(district_id,school_id,media_asset_id,student_id,added_by) VALUES($1,$2,$3,$4,$5)",
      [ID.d1, ID.s1, asset, ID.carol, USERS.pa[0]])), /row-level security/, "families don't add participants");
  });

  it("athletic association consents: families see and write only their own child's", async () => {
    const AG = "a6000000-0000-4000-8000-000000000001";
    await admin.query(`INSERT INTO athletic_association_agreements(id,district_id,association_ref,association_name,legal_basis,effective_from,effective_to,token_hash,approved_by)
      VALUES($1,$2,'state-aa','State AA','Eligibility reporting under the membership agreement',current_date,current_date+365,$3,$4)`, [AG, ID.d1, "e".repeat(64), USERS.supt1[0]]).catch(e => { throw new Error(`agreement fixture: ${e.message}`); });
    await admin.query("INSERT INTO athlete_association_consents(district_id,school_id,student_id,agreement_id,granted_by) VALUES($1,$2,$3,$4,$5),($1,$2,$6,$4,$7)", [ID.d1, ID.s1, ID.alice, AG, USERS.pa[0], ID.bob, USERS.pb[0]]);
    const seen = async (who, role) => (await probe(who, role, () => app.query("SELECT student_id FROM athlete_association_consents"))).rows.map(r => r.student_id).sort();
    assert.deepEqual(await seen("pa", "parent"), [ID.alice]);
    assert.deepEqual(await seen("p1", "principal"), [ID.alice, ID.bob].sort());
    assert.equal(await probe("pa", "parent", async () => (await app.query("UPDATE athlete_association_consents SET revoked_at=now(), revoked_by=$1", [USERS.pa[0]])).rowCount), 1, "only their child's");
    await assert.rejects(probe("pa", "parent", () => app.query("INSERT INTO athlete_association_consents(district_id,school_id,student_id,agreement_id,granted_by) VALUES($1,$2,$3,$4,$5)",
      [ID.d1, ID.s1, ID.bob, AG, USERS.pa[0]])), /row-level security|duplicate/);
  });
});
