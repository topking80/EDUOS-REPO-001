// FED-06: a district builds a minimized, signed aggregate report for the
// exchange gateway, against real PostgreSQL. School-level counts only, built
// from Master Control's signed agreement terms, as a snapshot of today.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { DATASETS, TERMS_FORMAT, checkEnvelope, signTerms } from "../../src/federation/exchange.js";
import { bundleKeys } from "../../src/federation/policy-bundle.js";
import { PG_URL, ID, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("FED-06 aggregate reports for the exchange gateway", { skip }, () => {
  let db, idp, server, admin, s = {};
  const as = name => client(server.base, s[name]);
  const AG = "xa-0123456789abcdef";
  const mc = bundleKeys(crypto.randomBytes(24).toString("hex"));
  const today = new Date().toISOString().slice(0, 10);
  const terms = (over = {}, keys = mc) => signTerms({ format: TERMS_FORMAT, agreement_id: AG, producer: { node_id: "dist-1", tenant_ref: ID.d1, name: "District 1" },
    recipient: { node_id: "sea", name: "State Education Agency" }, dataset: "enrollment_by_grade", fields: DATASETS.enrollment_by_grade.fields, purpose: "state_reporting",
    legal_basis: "State education code", min_cell_size: 10, effective_from: "2026-01-01", effective_to: "2099-12-31", issued_at: today, ...over }, keys);
  const build = (who, t) => as(who)("POST", "/api/district/exchange/reports", { terms: t });

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, EXCHANGE_SIGNING_SECRET: crypto.randomBytes(24).toString("hex"), MC_POLICY_PUBLIC_KEY: mc.public });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    // Twelve fourth graders at S1, so one count is large enough to show.
    for (let i = 0; i < 12; i++) await admin.query("INSERT INTO students(district_id, school_id, local_student_number, display_name, grade_level) VALUES ($1,$2,$3,$4,'4')", [ID.d1, ID.s1, `G4-${i}`, `Fourth Grader ${i}`]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["supt1", "p1"]) s[n] = await login(server.base, idp, n, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("builds a signed report with only school-level counts, small cells hidden", async () => {
    const info = (await as("supt1")("GET", "/api/district/exchange")).body.data;
    assert.equal(info.configured, true); assert.equal(info.termsKeyConfigured, true); assert.match(info.fingerprint, /^[0-9a-f]{32}$/);
    const r = await build("supt1", terms());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const env = r.body;
    assert.equal(env.snapshot, true); assert.equal(env.as_of, today); assert.deepEqual(env.period, { from: today, to: today }, "today's counts, labelled as today");
    const text = JSON.stringify(env);
    for (const name of ["Alice", "Bob", "Carol", "Xavier", "Fourth Grader", "S1-A"]) assert.ok(!text.includes(name), `${name} never leaves`);
    assert.deepEqual(env.rows.map(x => [x.school_name, x.grade_level]).sort(), [["S1", "3"], ["S1", "4"], ["S2", "5"]]);
    assert.ok(env.rows.every(x => x.student_count === null && x.suppressed === true), "every count here is small, or would reveal one");
    const s1g4 = env.rows.find(x => x.school_name === "S1" && x.grade_level === "4");
    const s1g3 = env.rows.find(x => x.school_name === "S1" && x.grade_level === "3");
    assert.equal(s1g3.suppressed, true, "two third graders: hidden");
    assert.equal(s1g4.suppressed, true, "twelve fourth graders: hidden too, or they'd reveal the third-grade count from a known school total");
    assert.ok(!env.rows.some(x => x.school_id === ID.sd2 || x.school_name === "D2-S"), "only this district's schools");
    const v = checkEnvelope(env, { id: AG, producer_tenant_ref: ID.d1, dataset: "enrollment_by_grade", fields: DATASETS.enrollment_by_grade.fields, purpose: "state_reporting",
      min_cell_size: 10, effective_from: "2026-01-01", effective_to: "2099-12-31", producer_public_key: info.publicKey });
    assert.equal(v.ok, true, v.reason);
    const sports = await build("supt1", terms({ dataset: "sports_participation", fields: DATASETS.sports_participation.fields }));
    assert.equal(sports.status, 200); assert.deepEqual(sports.body.fields, DATASETS.sports_participation.fields);
  });

  it("uses exactly the agreement's fields, purpose and minimum, never all of them", async () => {
    const fields = ["school_id", "grade_level", "student_count"];
    const r = await build("supt1", terms({ fields, min_cell_size: 12, purpose: "research_aggregate" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.fields, fields);
    assert.ok(r.body.rows.every(x => Object.keys(x).every(k => fields.includes(k) || k === "suppressed")), "no school names, only the agreed fields");
    assert.equal(r.body.suppression.min_cell_size, 12); assert.equal(r.body.purpose, "research_aggregate");
    // A report built from these terms passes Master Control's check against the same agreement.
    const info = (await as("supt1")("GET", "/api/district/exchange")).body.data;
    const v = checkEnvelope(r.body, { id: AG, producer_tenant_ref: ID.d1, dataset: "enrollment_by_grade", fields, purpose: "research_aggregate", min_cell_size: 12,
      effective_from: "2026-01-01", effective_to: "2099-12-31", producer_public_key: info.publicKey });
    assert.equal(v.ok, true, v.reason);
  });

  it("refuses terms that are unsigned, altered, someone else's, or outside their dates", async () => {
    assert.equal((await as("supt1")("POST", "/api/district/exchange/reports", { agreementId: AG, dataset: "enrollment_by_grade", purpose: "state_reporting" })).body.error, "not_exchange_terms", "loose parameters aren't enough");
    const changed = terms(); changed.fields = [...DATASETS.enrollment_by_grade.fields]; changed.min_cell_size = 5;
    assert.equal((await build("supt1", changed)).body.error, "altered");
    assert.equal((await build("supt1", terms({}, bundleKeys(crypto.randomBytes(24).toString("hex"))))).body.error, "wrong_key");
    assert.equal((await build("supt1", terms({ producer: { node_id: "dist-2", tenant_ref: ID.d2, name: "District 2" } }))).body.error, "not_for_this_district");
    const future = await build("supt1", terms({ effective_from: "2099-01-01" }));
    assert.equal(future.status, 409); assert.equal(future.body.error, "agreement_not_started");
    assert.equal((await build("supt1", terms({ effective_from: "2020-01-01", effective_to: "2020-12-31" }))).body.error, "agreement_ended");
  });

  it("refuses small minimums, unknown fields and anyone but the superintendent; audits each report", async () => {
    assert.equal((await build("supt1", terms({ min_cell_size: 3 }))).body.error, "malformed");
    assert.equal((await build("supt1", terms({ fields: ["school_id", "grade_level", "student_count", "display_name"] }))).body.error, "malformed");
    assert.equal((await build("supt1", terms({ dataset: "student_list" }))).status, 400);
    assert.equal((await build("p1", terms())).status, 403);
    assert.equal((await as("p1")("GET", "/api/district/exchange")).status, 403);
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE action='export_aggregate' AND resource_type='exchange_report' AND district_id=$1", [ID.d1]);
    assert.equal(rows[0].n, 3, "one per report built");
  });
});
