// FED-08: a district's EduOS trusts the old and new Master Control keys
// during a rotation and refuses revoked ones, against real PostgreSQL.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { BUNDLE_FORMAT, bundleKeys, signBundle } from "../../src/federation/policy-bundle.js";
import { DATASETS, TERMS_FORMAT, signTerms } from "../../src/federation/exchange.js";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const TODAY = new Date().toISOString().slice(0, 10);
const key = () => bundleKeys(crypto.randomBytes(24).toString("hex"));

describe("FED-08 Master Control key rotation and revocation in EduOS", { skip }, () => {
  let db, idp, server, admin, s = {};
  const oldKey = key(), newKey = key(), leaked = key(), stranger = key();
  const metricsToken = crypto.randomBytes(24).toString("hex");
  const bundle = (version, k, policies = {}) => signBundle({ format: BUNDLE_FORMAT, bundle_id: `pb-${version}`, release_id: `rel-${version}`, kind: "release", version,
    previous_sha256: null, issued_at: TODAY, effective_from: TODAY, district: { node_id: "dist-1", name: "D1", tenant_ref: ID.d1, jurisdiction_id: "US-TX" },
    issuer: { node_id: "sea-tx", name: "Texas Education Agency" }, catalog_version: "0.6.0",
    policies: Object.entries(policies).map(([id, value]) => ({ id, value, source: "ps-x", locked_by: null, chain: [] })) }, k);
  const terms = k => signTerms({ format: TERMS_FORMAT, agreement_id: "xa-0123456789abcdef", producer: { node_id: "dist-1", tenant_ref: ID.d1, name: "D1" },
    recipient: { node_id: "sea-tx", name: "TEA", jurisdiction_id: "US-TX" }, dataset: "enrollment_by_grade", fields: DATASETS.enrollment_by_grade.fields, purpose: "state_reporting",
    legal_basis: "code", min_cell_size: 10, effective_from: "2026-01-01", effective_to: "2099-12-31", issued_at: TODAY }, k);
  const as = name => client(server.base, s[name]);
  const post = b => as("supt1")("POST", "/api/district/policy-bundles", b);

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, EXCHANGE_SIGNING_SECRET: crypto.randomBytes(24).toString("hex"),
      MC_POLICY_PUBLIC_KEY: `${oldKey.public},${newKey.public},${leaked.public}`, MC_POLICY_REVOKED_KEYS: leaked.fingerprint, METRICS_TOKEN: metricsToken, EDUOS_DATA_LOCATION: "US-TX" });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    s.supt1 = await login(server.base, idp, "supt1", { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("bundles signed with the old or the new key are accepted; revoked and unknown keys aren't", async () => {
    const info = (await as("supt1")("GET", "/api/district/policy-bundles")).body.data;
    assert.deepEqual(info.fingerprints, [oldKey.fingerprint, newKey.fingerprint], "the revoked key isn't trusted even though it's listed");
    assert.deepEqual(info.revokedFingerprints, [leaked.fingerprint]);
    assert.equal((await post(bundle(1, oldKey))).status, 201);
    assert.equal((await post(bundle(2, newKey, { "records.audit.minimum_years": 3 }))).status, 201);
    assert.equal((await post(bundle(3, leaked))).body.error, "key_revoked");
    assert.equal((await post(bundle(3, stranger))).body.error, "wrong_key");
    const { rows } = await admin.query("SELECT version, key_fingerprint FROM district_policy_bundles ORDER BY version");
    assert.deepEqual(rows.map(r => [r.version, r.key_fingerprint]), [[1, oldKey.fingerprint], [2, newKey.fingerprint]], "each bundle records the key that signed it");
  });

  it("a bundle already received under a key revoked later stops being followed", async () => {
    // As if version 3 had arrived before its key was revoked.
    const b3 = bundle(3, leaked, { "records.legal_hold": true });
    await admin.query(`INSERT INTO district_policy_bundles(district_id, bundle_id, release_id, version, sha256, key_fingerprint, bundle, received_by)
      VALUES ($1,'pb-3','rel-3',3,$2,$3,$4,$5)`, [ID.d1, b3.signature.sha256, leaked.fingerprint, b3, USERS.supt1[0]]);
    const r = (await as("supt1")("GET", "/api/district/jurisdiction-rules")).body.data;
    assert.deepEqual([r.bundleVersion, r.legalHold, r.auditYears], [2, false, 3], "version 2 (new key) is followed, not version 3");
    const latest = (await as("supt1")("GET", "/api/district/policy-bundles")).body.data.latest;
    assert.deepEqual([latest.version, latest.keyRevoked], [3, true]);
  });

  it("exchange terms follow the same ring", async () => {
    const build = t => as("supt1")("POST", "/api/district/exchange/reports", { terms: t });
    assert.equal((await build(terms(oldKey))).status, 200);
    assert.equal((await build(terms(newKey))).status, 200);
    assert.equal((await build(terms(leaked))).body.error, "key_revoked");
  });

  it("FED-09: /metrics counts districts by federation state without naming any", async () => {
    const res = await fetch(`${server.base}/metrics`, { headers: { authorization: `Bearer ${metricsToken}` } });
    assert.equal(res.status, 200);
    const text = await res.text();
    const v = name => Number(new RegExp(`^${name.replace(/[{}"=]/g, m => "\\" + m)} (\\S+)$`, "m").exec(text)?.[1]);
    assert.equal(v("eduos_federation_status_up"), 1);
    assert.equal(v("eduos_federation_trusted_keys"), 2); assert.equal(v("eduos_federation_revoked_keys"), 1);
    assert.equal(v('eduos_federation_districts{bundle="in_effect"}'), 1); assert.equal(v('eduos_federation_districts{bundle="none"}'), 1, "D2 has none");
    assert.equal(v("eduos_federation_newest_bundle_revoked_key_districts"), 1);
    assert.equal(v("eduos_federation_legal_hold_districts"), 0, "the hold came in under the revoked key");
    assert.equal(v('eduos_federation_residency_districts{status="met"}'), 2);
    for (const id of [ID.d1, ID.d2, "D1", "Texas"]) assert.ok(!text.includes(id), `${id} isn't in the metrics`);
  });
});
