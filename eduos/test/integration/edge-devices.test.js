// Edge Phase 2 device health against real PostgreSQL (runtime role): register a
// device, report with its token, scope by school and district, revoke, and keep
// only allowlisted fields. Run: EDUOS_TEST_PG_URL=... npm run test:integration
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const report = (extra = {}) => ({
  timestamp: new Date().toISOString(), hostname: "maple-edge-01", role: "edge", agent_version: "2.0.0",
  metrics: { cpu_percent: 12.34, mem_total_kb: 8000000, mem_available_kb: 4000000, root_disk_used_percent: 41 },
  compliance: { selinux: "Enforcing", eduos_version: "37.4.0" },
  os: { booted_version: "45.20261110.3.0", updates: "enabled", cohort: "canary", last_verify: "healthy", zincati: "active" },
  ...extra,
});

describe("edge device health against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {};
  const as = name => client(server.base, s[name]);
  const device = (token, body) => fetch(`${server.base}/api/edge/health`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "supt2", "p1", "p2", "t1"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("only leaders register devices; the token is shown once and stored only as a hash", async () => {
    assert.equal((await as("t1")("POST", "/api/edge/devices", { name: "x", deviceRole: "edge" })).status, 403);
    assert.equal((await as("p1")("POST", "/api/edge/devices", { name: "x", deviceRole: "toaster" })).status, 400);
    const r = await as("p1")("POST", "/api/edge/devices", { name: "Maple edge 01", deviceRole: "edge", schoolId: ID.s2 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.schoolId, ID.s1, "a principal's device belongs to their own school whatever the body says");
    assert.match(r.body.data.token, /^edh1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const stored = (await admin.query("SELECT token_hash FROM edge_devices WHERE id=$1", [r.body.data.id])).rows[0].token_hash;
    assert.match(stored, /^[a-f0-9]{64}$/);
    assert.ok(!stored.includes(r.body.data.token.split(".")[2]));
    const listed = (await as("p1")("GET", "/api/edge/devices")).body.data.devices.find(d => d.id === r.body.data.id);
    assert.ok(listed && !("token" in listed) && !("token_hash" in listed), "the list never carries the token or its hash");
  });

  it("a device reports with its token; unknown fields are dropped; leaders see it in scope only", async () => {
    const reg = (await as("p1")("POST", "/api/edge/devices", { name: "Maple edge 02", deviceRole: "edge" })).body.data;
    assert.equal((await device(null, report())).status, 401);
    assert.equal((await device(`edh1.${reg.id}.${"A".repeat(43)}`, report())).status, 401, "wrong secret");
    assert.equal((await device(reg.token, [1, 2])).status, 400);
    const ok = await device(reg.token, report({ student_names: ["Alice A"], metrics: { cpu_percent: 12.34, secret: "x" } }));
    assert.equal(ok.status, 202, JSON.stringify(ok.body));

    const mine = (await as("p1")("GET", "/api/edge/devices")).body.data.devices.find(d => d.id === reg.id);
    assert.equal(mine.report_count, 1);
    assert.equal(mine.stale, false);
    assert.deepEqual(mine.last_report.metrics, { cpu_percent: 12.3 });
    assert.equal(mine.last_report.os.cohort, "canary");
    assert.ok(!JSON.stringify(mine.last_report).includes("Alice"), "nothing outside the allowlist is kept");
    assert.ok(!(await as("p2")("GET", "/api/edge/devices")).body.data.devices.some(d => d.id === reg.id), "another school's principal can't see it");
    assert.ok((await as("supt1")("GET", "/api/edge/devices")).body.data.devices.some(d => d.id === reg.id), "the district sees every school");
    assert.ok(!(await as("supt2")("GET", "/api/edge/devices")).body.data.devices.some(d => d.id === reg.id), "another district never does");
    const history = await admin.query("SELECT count(*)::int AS n FROM edge_device_reports WHERE device_id=$1", [reg.id]);
    assert.equal(history.rows[0].n, 1);
  });

  it("the runtime role can't read or forge device tokens directly", async () => {
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.district_id', $1, true)", [ID.d2]);
      assert.equal((await app.query("SELECT count(*)::int AS n FROM edge_devices")).rows[0].n, 0, "another district's devices are invisible");
      await app.query("ROLLBACK");
      await assert.rejects(app.query("UPDATE edge_devices SET token_hash = repeat('a', 64)"), /permission denied/);
      await assert.rejects(app.query("DELETE FROM edge_device_reports"), /permission denied/);
      await assert.rejects(app.query("SELECT eduos_retention_purge_edge_reports(1)"), /permission denied/);
    } finally { await app.end(); }
  });

  it("a superintendent registers district-level or school devices; revoking stops reports", async () => {
    const foreign = await as("supt1")("POST", "/api/edge/devices", { name: "Wrong", deviceRole: "edge", schoolId: ID.sd2 });
    assert.equal(foreign.status, 400); assert.equal(foreign.body.error, "school_not_in_district");
    const hub = (await as("supt1")("POST", "/api/edge/devices", { name: "District hub", deviceRole: "district" })).body.data;
    assert.equal(hub.schoolId, null);
    const oak = (await as("supt1")("POST", "/api/edge/devices", { name: "Oak edge", deviceRole: "edge", schoolId: ID.s2 })).body.data;
    assert.equal((await device(oak.token, report())).status, 202);
    assert.equal((await as("p1")("POST", `/api/edge/devices/${oak.id}/revoke`)).status, 404, "another school's principal can't revoke it");
    assert.equal((await as("p2")("POST", `/api/edge/devices/${oak.id}/revoke`)).status, 200);
    assert.equal((await device(oak.token, report())).status, 401, "a revoked token is refused");
    const listed = (await as("supt1")("GET", "/api/edge/devices")).body.data.devices.find(d => d.id === oak.id);
    assert.ok(listed.revoked_at); assert.equal(listed.stale, false, "revoked devices aren't reported as stale");
  });
});
