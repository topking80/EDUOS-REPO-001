// FED-05: a district's EduOS receives the signed policy bundles Master
// Control issued for it, against real PostgreSQL. Checked and kept as
// received; nothing is applied.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { BUNDLE_FORMAT, bundleKeys, signBundle } from "../../src/federation/policy-bundle.js";
import { PG_URL, ID, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("FED-05 policy bundles received by a district", { skip }, () => {
  let db, idp, server, admin, s = {};
  const keys = bundleKeys(crypto.randomBytes(24).toString("hex"));
  const bundle = (version, extra = {}) => signBundle({ format: BUNDLE_FORMAT, bundle_id: `pb-${version}`, release_id: `rel-${version}`, kind: "release", version,
    previous_sha256: null, issued_at: "2026-11-26", effective_from: "2026-12-01", district: { node_id: "dist-1", name: "D1", tenant_ref: ID.d1, jurisdiction_id: "US-TX" },
    issuer: { node_id: "sea-tx", name: "Texas Education Agency" }, catalog_version: "0.4.0",
    policies: [{ id: "security.mfa.required_for_staff", value: true, source: "ps-1", locked_by: "ps-1", chain: [] }], ...extra }, keys);
  const as = name => client(server.base, s[name]);

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, MC_POLICY_PUBLIC_KEY: keys.public });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["supt1", "p1", "supt2"]) s[n] = await login(server.base, idp, n, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("the superintendent keeps a bundle signed for this district; the same file again is the same record", async () => {
    const list = await as("supt1")("GET", "/api/district/policy-bundles");
    assert.equal(list.body.data.configured, true); assert.equal(list.body.data.fingerprint, keys.fingerprint); assert.equal(list.body.data.latest, null);
    const r = await as("supt1")("POST", "/api/district/policy-bundles", bundle(1));
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.data.version, 1); assert.equal(r.body.data.existing, false);
    const again = await as("supt1")("POST", "/api/district/policy-bundles", bundle(1));
    assert.equal(again.status, 200); assert.equal(again.body.data.existing, true);
    const latest = (await as("supt1")("GET", "/api/district/policy-bundles")).body.data.latest;
    assert.deepEqual([latest.version, latest.issuer, latest.policies[0].value], [1, "Texas Education Agency", true]);
  });

  it("refuses altered, foreign-key, other-district and older bundles; only the superintendent uploads", async () => {
    const post = (who, b) => as(who)("POST", "/api/district/policy-bundles", b);
    const changed = bundle(2); changed.policies[0].value = false;
    assert.equal((await post("supt1", changed)).body.error, "altered");
    assert.equal((await post("supt1", signBundle({ ...bundle(2), signature: undefined }, bundleKeys(crypto.randomBytes(24).toString("hex"))))).body.error, "wrong_key");
    assert.equal((await post("supt1", bundle(2, { district: { node_id: "dist-2", name: "D2", tenant_ref: ID.d2 } }))).body.error, "not_for_this_district");
    assert.equal((await post("supt2", bundle(2))).body.error, "not_for_this_district", "D2 can't keep D1's bundle");
    assert.equal((await post("p1", bundle(2))).status, 403);
    const v3 = bundle(3, { previous_sha256: "0".repeat(64) });
    const ok3 = await post("supt1", v3);
    assert.equal(ok3.status, 201); assert.equal(ok3.body.data.gap, true, "version 2 was never uploaded here");
    assert.equal((await post("supt1", bundle(2))).body.error, "older_than_received");
    assert.equal((await as("p1")("GET", "/api/district/policy-bundles")).status, 403);
  });

  it("kept as received and append-only; nothing else changes", async () => {
    const { rows } = await admin.query("SELECT version, bundle->'signature'->>'alg' AS alg FROM district_policy_bundles WHERE district_id=$1 ORDER BY version", [ID.d1]);
    assert.deepEqual(rows.map(r => [r.version, r.alg]), [[1, "Ed25519"], [3, "Ed25519"]]);
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query(`SELECT set_config('app.district_id',$1,true), set_config('app.role','superintendent',true)`, [ID.d1]);
      await assert.rejects(app.query("UPDATE district_policy_bundles SET version=9"), /permission denied|append-only/);
      await app.query("ROLLBACK");
    } finally { await app.end(); }
    const audits = await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE action='receive' AND resource_type='policy_bundle'");
    assert.equal(audits.rows[0].n, 2);
  });
});
