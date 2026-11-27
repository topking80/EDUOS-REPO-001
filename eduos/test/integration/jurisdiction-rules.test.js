// FED-07: a district's EduOS follows the jurisdiction rules in the newest
// policy bundle in effect, against real PostgreSQL: retention minimums,
// legal holds, consent references and residency.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { BUNDLE_FORMAT, bundleKeys, signBundle } from "../../src/federation/policy-bundle.js";
import { DATASETS, TERMS_FORMAT, signTerms } from "../../src/federation/exchange.js";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const TODAY = new Date().toISOString().slice(0, 10);

describe("FED-07 jurisdiction rules in a district's EduOS", { skip }, () => {
  let db, idp, server, admin, env, s = {};
  const mc = bundleKeys(crypto.randomBytes(24).toString("hex"));
  const bundle = (version, effective, policies) => signBundle({ format: BUNDLE_FORMAT, bundle_id: `pb-${version}`, release_id: `rel-${version}`, kind: "release", version,
    previous_sha256: null, issued_at: TODAY, effective_from: effective, district: { node_id: "dist-1", name: "D1", tenant_ref: ID.d1, jurisdiction_id: "US-TX" },
    issuer: { node_id: "sea-tx", name: "Texas Education Agency" }, catalog_version: "0.6.0",
    policies: Object.entries(policies).map(([id, value]) => ({ id, value, source: "ps-x", locked_by: null, chain: [] })) }, mc);
  const terms = (over = {}) => signTerms({ format: TERMS_FORMAT, agreement_id: "xa-0123456789abcdef", producer: { node_id: "dist-1", tenant_ref: ID.d1, name: "D1" },
    recipient: { node_id: "sea-tx", name: "Texas Education Agency", jurisdiction_id: "US-TX" }, dataset: "enrollment_by_grade", fields: DATASETS.enrollment_by_grade.fields,
    purpose: "state_reporting", legal_basis: "State education code", min_cell_size: 10, effective_from: "2026-01-01", effective_to: "2099-12-31", issued_at: TODAY, ...over }, mc);
  const as = name => client(server.base, s[name]);
  const sql = (q, p) => admin.query(q, p);
  const oldAudit = days => sql(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,outcome,occurred_at)
    VALUES($1,$2,'superintendent','old_${days}','test','success',now()-make_interval(days => $3))`, [ID.d1, USERS.supt1[0], days]);
  const count = async action => (await sql("SELECT count(*)::int AS n FROM audit_events WHERE action=$1", [action])).rows[0].n;
  const retention = async extra => {
    const r = await run(["src/retention.js"], { ...env, DATABASE_URL: db.ownerUrl, RETENTION_AUDIT_DAYS: "365", ...extra });
    assert.equal(r.code, 0, r.out);
    return JSON.parse(r.out.trim().split("\n").at(-1)).districts[ID.d1];
  };
  const del = id => as("supt1")("POST", `/api/students/${id}/records-delete`, { confirmLocalStudentNumber: id === ID.carol ? "S2-C" : "S1-A", reason: "Parent requested deletion under FERPA policy" });

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, MC_POLICY_PUBLIC_KEY: mc.public, EXCHANGE_SIGNING_SECRET: crypto.randomBytes(24).toString("hex"), EDUOS_DATA_LOCATION: "US-VA" });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["supt1", "p1"]) s[n] = await login(server.base, idp, n, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("with no bundle in effect, every rule is at its default", async () => {
    const r = (await as("supt1")("GET", "/api/district/jurisdiction-rules")).body.data;
    assert.deepEqual([r.bundleVersion, r.auditYears, r.legalHold, r.consentRequired, r.residency.scope, r.residency.status], [null, 0, false, false, "any", "met"]);
    assert.equal((await as("p1")("GET", "/api/district/jurisdiction-rules")).status, 403);
  });

  it("retention minimums keep records longer than the server's setting; a future bundle isn't in effect yet", async () => {
    assert.equal((await as("supt1")("POST", "/api/district/policy-bundles", bundle(1, TODAY, { "records.audit.minimum_years": 2, "data.residency.scope": "in_state" }))).status, 201);
    assert.equal((await as("supt1")("POST", "/api/district/policy-bundles", bundle(2, "2099-01-01", { "records.legal_hold": true }))).status, 201);
    const r = (await as("supt1")("GET", "/api/district/jurisdiction-rules")).body.data;
    assert.deepEqual([r.bundleVersion, r.auditYears, r.legalHold], [1, 2, false], "version 2 starts in 2099");
    assert.deepEqual([r.residency.scope, r.residency.declaredLocation, r.residency.status], ["in_state", "US-VA", "not_met"], "hosting declared outside the state");
    await oldAudit(400); await oldAudit(800);
    const out = await retention();
    assert.deepEqual(out.minimums_applied, ["audit"]);
    assert.equal(await count("old_400"), 1, "kept: the rule says two years, the server says one");
    assert.equal(await count("old_800"), 0, "older than two years: purged");
  });

  it("a student's history hold blocks deleting that student's records", async () => {
    await sql("INSERT INTO history_legal_holds(district_id,school_id,student_id,reason,placed_by) VALUES ($1,$2,$3,'Records request pending',$4)", [ID.d1, ID.s2, ID.carol, USERS.supt1[0]]);
    const r = await del(ID.carol);
    assert.equal(r.status, 409); assert.equal(r.body.error, "legal_hold");
  });

  it("a legal hold stops the retention job and record deletion; consent and residency bind exchange reports", async () => {
    assert.equal((await as("supt1")("POST", "/api/district/policy-bundles", bundle(3, TODAY, {
      "records.legal_hold": true, "exchange.consent_reference.required": true, "data.residency.scope": "in_state" }))).status, 201);
    await oldAudit(1000);
    const out = await retention();
    assert.equal(out.legal_hold, true);
    assert.equal(await count("old_1000"), 1, "nothing purged under the hold");
    const d = await del(ID.alice);
    assert.equal(d.status, 409); assert.equal(d.body.error, "legal_hold");
    assert.equal((await sql("SELECT count(*)::int AS n FROM students WHERE id=$1", [ID.alice])).rows[0].n, 1);

    const build = t => as("supt1")("POST", "/api/district/exchange/reports", { terms: t });
    assert.equal((await build(terms())).body.error, "consent_reference_required");
    assert.equal((await build(terms({ consent_reference: "Board resolution 2026-14", recipient: { node_id: "sea-ok", name: "Oklahoma", jurisdiction_id: "US-OK" } }))).body.error, "recipient_outside_residency");
    const ok = await build(terms({ consent_reference: "Board resolution 2026-14" }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const r = (await as("supt1")("GET", "/api/district/jurisdiction-rules")).body.data;
    assert.deepEqual([r.bundleVersion, r.legalHold, r.consentRequired], [3, true, true]);
  });
});
