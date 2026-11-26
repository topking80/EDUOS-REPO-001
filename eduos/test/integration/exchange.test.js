// FED-06: a district builds a minimized, signed aggregate report for the
// exchange gateway, against real PostgreSQL. School-level counts only.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { DATASETS, checkEnvelope } from "../../src/federation/exchange.js";
import { PG_URL, ID, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("FED-06 aggregate reports for the exchange gateway", { skip }, () => {
  let db, idp, server, admin, s = {};
  const as = name => client(server.base, s[name]);
  const AG = "xa-0123456789abcdef";

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, EXCHANGE_SIGNING_SECRET: crypto.randomBytes(24).toString("hex") });
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
    assert.equal(info.configured, true); assert.match(info.fingerprint, /^[0-9a-f]{32}$/);
    const r = await as("supt1")("POST", "/api/district/exchange/reports", { agreementId: AG, dataset: "enrollment_by_grade", purpose: "state_reporting",
      periodFrom: "2026-10-01", periodTo: "2026-10-01", minCellSize: 10 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const env = r.body;
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
    const sports = await as("supt1")("POST", "/api/district/exchange/reports", { agreementId: AG, dataset: "sports_participation", purpose: "state_reporting", periodFrom: "2026-10-01", periodTo: "2026-10-01" });
    assert.equal(sports.status, 200); assert.deepEqual(sports.body.fields, DATASETS.sports_participation.fields);
  });

  it("refuses small minimums, unknown fields and anyone but the superintendent; audits each report", async () => {
    const post = (who, b) => as(who)("POST", "/api/district/exchange/reports", { agreementId: AG, dataset: "enrollment_by_grade", purpose: "state_reporting", periodFrom: "2026-10-01", periodTo: "2026-10-01", ...b });
    assert.equal((await post("supt1", { minCellSize: 3 })).body.error, "min_cell_too_small");
    assert.equal((await post("supt1", { fields: ["school_id", "grade_level", "student_count", "display_name"] })).body.error, "fields_not_in_dataset");
    assert.equal((await post("supt1", { dataset: "student_list" })).status, 400);
    assert.equal((await post("p1", {})).status, 403);
    assert.equal((await as("p1")("GET", "/api/district/exchange")).status, 403);
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE action='export_aggregate' AND resource_type='exchange_report' AND district_id=$1", [ID.d1]);
    assert.equal(rows[0].n, 2);
  });
});
