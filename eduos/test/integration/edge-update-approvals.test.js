// District-approved edge updates (db/039) against real PostgreSQL: devices get
// only an approved version (canaries first), promotion is blocked until the
// canary gate passes, a rollback blocks it, and withdrawing falls back.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const V1 = "45.20261110.3.0", V2 = "45.20261117.3.0";
const os = (extra) => ({ timestamp: new Date().toISOString(), role: "edge", metrics: {}, compliance: {}, os: { updates: "enabled", last_verify: "healthy", ...extra } });

describe("district-approved edge updates against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, dev = {}, devId = {};
  const as = name => client(server.base, s[name]);
  const call = (token, method, path, body) => fetch(`${server.base}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  const report = (name, extra) => call(dev[name], "POST", "/api/edge/health", os(extra));
  const target = async (name, cohort) => (await call(dev[name], "GET", `/api/edge/update-target?cohort=${cohort}`)).body.data;
  const releases = async () => (await as("supt1")("GET", "/api/edge/updates")).body.data.releases;

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "supt2", "p1"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    for (const name of ["can1", "can2", "std1"]) {
      const d = (await as("supt1")("POST", "/api/edge/devices", { name, deviceRole: "edge" })).body.data;
      dev[name] = d.token; devId[name] = d.id;
    }
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("with approval off, devices are told approval isn't required", async () => {
    assert.deepEqual(await target("can1", "canary"), { requireApproval: false, target: null, stage: null, cohort: "standard" });
    assert.equal((await call("edh1.00000000-0000-4000-8000-000000000000." + "A".repeat(43), "GET", "/api/edge/update-target")).status, 401);
  });

  it("district leads choose the canaries; a device can't", async () => {
    assert.equal((await as("p1")("POST", `/api/edge/updates/devices/${devId.can1}/cohort`, { cohort: "canary" })).status, 403);
    assert.equal((await as("supt1")("POST", `/api/edge/updates/devices/${devId.can1}/cohort`, { cohort: "beta" })).status, 400);
    assert.equal((await as("supt2")("POST", `/api/edge/updates/devices/${devId.can1}/cohort`, { cohort: "canary" })).status, 404, "another district");
    for (const d of ["can1", "can2"]) assert.equal((await as("supt1")("POST", `/api/edge/updates/devices/${devId[d]}/cohort`, { cohort: "canary" })).status, 200);
    assert.equal((await target("can1", "standard")).cohort, "canary", "the stored cohort, whatever the device asks");
    assert.equal((await target("std1", "canary")).cohort, "standard");
    const log = await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE action='set_cohort'");
    assert.equal(log.rows[0].n, 2);
  });

  it("only district leads change the policy or approve; principals can look", async () => {
    assert.equal((await as("p1")("PUT", "/api/edge/updates/policy", { requireApproval: true, minCanaries: 2, soakHours: 24 })).status, 403);
    assert.equal((await as("p1")("POST", "/api/edge/updates/releases", { version: V1 })).status, 403);
    assert.equal((await as("p1")("GET", "/api/edge/updates")).body.data.canApprove, false);
    assert.equal((await as("supt1")("PUT", "/api/edge/updates/policy", { requireApproval: true, minCanaries: 0, soakHours: 24 })).status, 400);
    const p = await as("supt1")("PUT", "/api/edge/updates/policy", { requireApproval: true, minCanaries: 2, soakHours: 24 });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal((await as("supt1")("POST", "/api/edge/updates/releases", { version: "latest" })).status, 400);
  });

  it("an approved version goes to canaries only; standard devices wait", async () => {
    assert.deepEqual(await target("can1", "canary"), { requireApproval: true, target: null, stage: null, cohort: "canary" }, "nothing approved yet: install nothing");
    const r = await as("supt1")("POST", "/api/edge/updates/releases", { version: V1 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await as("supt1")("POST", "/api/edge/updates/releases", { version: V1 })).status, 409);
    assert.deepEqual(await target("can1", "standard"), { requireApproval: true, target: V1, stage: "canary", cohort: "canary" });
    assert.deepEqual(await target("std1", "canary"), { requireApproval: true, target: null, stage: null, cohort: "standard" },
      "a standard device asking for the canary cohort still gets nothing");
    assert.equal((await as("supt2")("GET", "/api/edge/updates")).body.data.releases.length, 0, "another district sees nothing");
  });

  it("promotion waits for enough healthy canaries and the soak time, then reaches everyone", async () => {
    const id = (await releases())[0].id;
    let p = await as("supt1")("POST", `/api/edge/updates/releases/${id}/promote`);
    assert.equal(p.status, 409); assert.equal(p.body.error, "canary_gate_not_passed");
    assert.deepEqual(p.body.gate.blockers, ["0 of 2 canaries healthy on it"]);

    assert.equal((await report("can1", { cohort: "canary", booted_version: V1 })).status, 202);
    assert.equal((await report("can2", { cohort: "canary", booted_version: V1, updates: "held" })).status, 202);
    // A standard device claiming to be a canary in its report doesn't count either.
    assert.equal((await report("std1", { cohort: "canary", booted_version: V1 })).status, 202);
    p = await as("supt1")("POST", `/api/edge/updates/releases/${id}/promote`);
    assert.deepEqual(p.body.gate.blockers, ["1 of 2 canaries healthy on it"], "a held canary doesn't count");

    assert.equal((await report("can2", { cohort: "canary", booted_version: V1 })).status, 202);
    p = await as("supt1")("POST", `/api/edge/updates/releases/${id}/promote`);
    assert.deepEqual(p.body.gate.blockers, ["0 of 2 canaries have run it for 24 h"]);

    // 25 hours later (reports backdated), still reporting healthy now.
    await admin.query("UPDATE edge_device_reports SET received_at = received_at - interval '25 hours'");
    await admin.query("UPDATE edge_update_releases SET approved_at = approved_at - interval '26 hours'");
    for (const d of ["can1", "can2"]) await report(d, { cohort: "canary", booted_version: V1 });
    const gate = (await releases())[0].gate;
    assert.equal(gate.ready, true, JSON.stringify(gate));
    p = await as("supt1")("POST", `/api/edge/updates/releases/${id}/promote`);
    assert.equal(p.status, 200, JSON.stringify(p.body)); assert.equal(p.body.data.stage, "promoted");
    assert.deepEqual(await target("std1", "standard"), { requireApproval: true, target: V1, stage: "promoted", cohort: "standard" });
    const log = await admin.query("SELECT action, detail FROM audit_events WHERE resource_type IN ('edge_update_release','edge_update_policy') ORDER BY occurred_at");
    assert.deepEqual(log.rows.map(r => r.action), ["update", "approve_canary", "promote"]);
  });

  it("a rollback from a canary version blocks it; withdrawing sends canaries back to the promoted version", async () => {
    const r = (await as("supt1")("POST", "/api/edge/updates/releases", { version: V2 })).body.data;
    assert.equal((await target("can1", "canary")).target, V2, "canaries move to the newest approved version");
    assert.equal((await target("std1", "standard")).target, V1);
    await report("can1", { cohort: "canary", booted_version: V1, updates: "held", last_verify: "rolled_back", rollback_from_version: V2 });
    const p = await as("supt1")("POST", `/api/edge/updates/releases/${r.id}/promote`);
    assert.equal(p.status, 409);
    assert.ok(p.body.gate.blockers.some(b => b === "rolled back on can1"), JSON.stringify(p.body.gate));
    assert.equal((await as("supt1")("POST", `/api/edge/updates/releases/${r.id}/withdraw`, {})).status, 400, "a reason is required");
    assert.equal((await as("supt1")("POST", `/api/edge/updates/releases/${r.id}/withdraw`, { reason: "canary rolled back" })).status, 200);
    assert.deepEqual(await target("can1", "canary"), { requireApproval: true, target: V1, stage: "promoted", cohort: "canary" });
  });
});
