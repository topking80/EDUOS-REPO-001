// FED-03: Master Control against real PostgreSQL, a mock OIDC provider and
// the real server process. Federation administration only: nodes, roles,
// delegations, policies and a hash-chained audit of every decision. Its
// database login can't reach any EduOS table, and it refuses to start if it
// could.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import pg from "pg";
import { PG_URL, ROOT, startIdp, baseEnv, run, createDatabase, freePort } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("FED-03 Master Control against real PostgreSQL", { skip }, () => {
  let db, idp, admin, mc, mcRole, mcUrl, env, s = {}, ids = {};
  const mcPw = `mc-${crypto.randomBytes(4).toString("hex")}-pw`;

  async function startMc(extra = {}) {
    const child = spawn(process.execPath, ["src/master-control/server.js"], { cwd: ROOT, env: { ...env, MC_PORT: String(await freePort()), ...extra } });
    let out = "";
    const port = await new Promise((resolve, reject) => {
      const on = d => { out += d; const m = /master control listening on (\d+)/.exec(out); if (m) resolve(Number(m[1])); };
      child.stdout.on("data", on); child.stderr.on("data", on);
      child.on("exit", code => reject(new Error(`exited ${code}: ${out}`)));
    });
    return { base: `http://127.0.0.1:${port}`, log: () => out, stop: () => new Promise(r => { child.removeAllListeners("exit"); child.on("exit", r); child.kill(); }) };
  }
  const pick = (res, prefix) => res.headers.getSetCookie().map(c => c.split(";")[0]).find(c => c.startsWith(prefix) && !c.endsWith("="));
  async function signIn(sub) {
    const start = await fetch(`${mc.base}/mc/auth/login`, { redirect: "manual" });
    const loc = new URL(start.headers.get("location"));
    const code = crypto.randomBytes(8).toString("hex");
    idp.codes.set(code, { sub, nonce: loc.searchParams.get("nonce") });
    const cb = await fetch(`${mc.base}/mc/auth/callback?code=${code}&state=${encodeURIComponent(loc.searchParams.get("state"))}`,
      { redirect: "manual", headers: { cookie: pick(start, "eduos_mc_state=") } });
    const cookie = pick(cb, "eduos_mc=");
    if (cb.status !== 303 || !cookie) return { status: cb.status };
    const me = (await (await fetch(`${mc.base}/mc/api/me`, { headers: { cookie } })).json()).data;
    return { status: 303, cookie, csrf: me.csrfToken, me };
  }
  const as = who => async (method, path, body, { csrf = true } = {}) => {
    const r = await fetch(`${mc.base}/mc/api${path}`, { method, headers: { cookie: s[who].cookie, ...(body ? { "content-type": "application/json" } : {}), ...(method !== "GET" && csrf ? { "x-csrf-token": s[who].csrf } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const check = async (who, capability, nodeId) => ok(await as(who)("GET", `/check?capability=${capability}&nodeId=${nodeId}`));

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const eduEnv = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...eduEnv, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    mcRole = `mc_it_${crypto.randomBytes(4).toString("hex")}`;
    await admin.query(`CREATE ROLE ${mcRole} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${mcPw}'`);
    const u = new URL(db.ownerUrl); u.username = mcRole; u.password = mcPw; mcUrl = u.toString();
    env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development", MC_DATABASE_URL: mcUrl, MC_PUBLIC_ORIGIN: "http://localhost",
      MC_OIDC_ISSUER: idp.issuer, MC_OIDC_CLIENT_ID: "eduos-it", MC_OIDC_CLIENT_SECRET: "it-secret", MC_OIDC_REDIRECT_URI: "http://localhost/mc/auth/callback" };
    const m = await run(["src/master-control/migrate.js"], { ...env, MC_MIGRATE_DATABASE_URL: db.ownerUrl, MC_APP_ROLE: mcRole });
    assert.equal(m.code, 0, m.out);
    const b = await run(["src/master-control/bootstrap.js", "--subject", "op", "--name", "Platform Operator", "--approval", "board-2026-01"], env);
    assert.equal(b.code, 0, b.out);
    assert.notEqual((await run(["src/master-control/bootstrap.js", "--subject", "x", "--name", "X", "--approval", "y"], env)).code, 0, "bootstrap runs once");
    mc = await startMc();
  });
  after(async () => {
    await mc?.stop();
    await admin?.query(`DROP OWNED BY ${mcRole}`).catch(() => {});
    await admin?.end();
    await db?.drop();
    const c = new pg.Client(PG_URL); await c.connect();
    await c.query(`DROP ROLE IF EXISTS ${mcRole}`).catch(() => {}); await c.end();
    await idp?.close();
  });

  it("its database login can't read EduOS tables, and it refuses to start if it could", async () => {
    const c = new pg.Client(mcUrl); await c.connect();
    try {
      await assert.rejects(c.query("SELECT * FROM public.students"), /permission denied/);
      await assert.rejects(c.query("SELECT * FROM public.users"), /permission denied/);
      await assert.rejects(c.query("UPDATE master_control.audit_log SET actor='x'"), /permission denied|append-only/);
    } finally { await c.end(); }
    await admin.query(`GRANT SELECT ON public.students TO ${mcRole}`);
    try { await assert.rejects(startMc(), /can reach tables outside its schema \(students\)/); }
    finally { await admin.query(`REVOKE SELECT ON public.students FROM ${mcRole}`); }
  });

  it("only registered operators sign in; changes need the CSRF token", async () => {
    assert.equal((await signIn("stranger")).status, 403);
    s.op = await signIn("op");
    assert.equal(s.op.status, 303);
    assert.deepEqual(s.op.me.roles.map(r => [r.role_id, r.node_id, r.inForce]), [["platform-operator", "platform", true]]);
    assert.equal((await as("op")("POST", "/nodes", { parentId: "platform", kind: "state_education_authority", name: "x", approvalReference: "y" }, { csrf: false })).status, 403);
  });

  it("the platform enrols state authorities, districts and schools; the model check refuses bad shapes", async () => {
    ids.tx = ok(await as("op")("POST", "/nodes", { parentId: "platform", kind: "state_education_authority", name: "Texas Education Agency", jurisdictionId: "US-TX", approvalReference: "mou-tx-1" }), 201).id;
    ids.d1 = ok(await as("op")("POST", "/nodes", { parentId: ids.tx, kind: "district", name: "Lakeside ISD", jurisdictionId: "US-TX", tenantRef: "tenant-lakeside", approvalReference: "enrol-1" }), 201).id;
    ids.k1 = ok(await as("op")("POST", "/nodes", { parentId: ids.d1, kind: "school", name: "Elm Elementary", jurisdictionId: "US-TX", approvalReference: "enrol-2" }), 201).id;
    const bad = await as("op")("POST", "/nodes", { parentId: ids.tx, kind: "district", name: "No tenant", jurisdictionId: "US-TX", approvalReference: "x" });
    assert.equal(bad.status, 422); assert.match(bad.body.errors.join(";"), /tenant_ref is required/);
    const wrong = await as("op")("POST", "/nodes", { parentId: ids.tx, kind: "district", name: "Wrong state", jurisdictionId: "US-OK", tenantRef: "t", approvalReference: "x" });
    assert.match(wrong.body.errors.join(";"), /must share its parent's jurisdiction/);
  });

  it("platform/state roles use federation.roles.assign; district roles only the district assigns, apart from its first superintendent", async () => {
    ok(await as("op")("POST", "/assignments", { nodeId: ids.tx, roleId: "state-oversight", subject: "tea", displayName: "State Analyst", approvalReference: "tea-letter-7" }), 201);
    const first = ok(await as("op")("POST", "/assignments", { nodeId: ids.d1, roleId: "district-superintendent", subject: "sup1", displayName: "Dr. Lake", approvalReference: "board-res-12" }), 201);
    assert.equal(first.role_id, "district-superintendent");
    const second = await as("op")("POST", "/assignments", { nodeId: ids.d1, roleId: "district-it-admin", subject: "it1", displayName: "IT", approvalReference: "x" });
    assert.equal(second.status, 403); assert.equal(second.body.reason, "no_grant", "after that, the district decides");
    s.tea = await signIn("tea"); s.sup1 = await signIn("sup1");
    ok(await as("sup1")("POST", "/assignments", { nodeId: ids.k1, roleId: "school-principal", subject: "pr1", displayName: "Principal Elm", approvalReference: "hr-55" }), 201);
    assert.equal((await as("tea")("POST", "/assignments", { nodeId: ids.d1, roleId: "district-it-admin", subject: "it2", displayName: "IT", approvalReference: "x" })).status, 403, "the state can't staff a district");
    assert.equal((await as("sup1")("POST", "/assignments", { nodeId: ids.d1, roleId: "district-it-admin", principalId: s.sup1.me.principalId, approvalReference: "x" })).body.error, "cannot_assign_yourself");
    const roleMismatch = await as("sup1")("POST", "/assignments", { nodeId: ids.k1, roleId: "district-it-admin", subject: "it3", displayName: "IT", approvalReference: "x" });
    assert.equal(roleMismatch.status, 422);
  });

  it("no one in Master Control reaches student records", async () => {
    for (const who of ["op", "tea"]) for (const n of [ids.d1, ids.k1]) assert.equal((await check(who, "student.records.read", n)).allowed, false, `${who}`);
    assert.equal((await check("sup1", "student.records.read", ids.k1)).allowed, true, "the district's own authority, enforced in EduOS");
    const leak = await as("sup1")("POST", "/delegations", { fromAssignmentId: s.sup1.me.roles[0]?.id || (await as("sup1")("GET", "/me")).body.data.roles[0].id,
      delegatePrincipalId: s.tea.me.principalId, delegateHomeNodeId: ids.tx, nodeId: ids.d1, capabilities: ["student.records.read"], purpose: "audit", effectiveTo: "2099-01-01", approvalReference: "x" });
    assert.equal(leak.status, 422); assert.match(leak.body.errors.join(";"), /student data; it can only be delegated within the same district/);
  });

  it("a district can hand its state a specific job for a while, and take it back", async () => {
    const sup1 = (await as("sup1")("GET", "/me")).body.data;
    const dl = ok(await as("sup1")("POST", "/delegations", { fromAssignmentId: sup1.roles[0].id, delegatePrincipalId: s.tea.me.principalId, delegateHomeNodeId: ids.tx,
      nodeId: ids.d1, capabilities: ["school.operations.manage"], purpose: "storm recovery coordination", effectiveTo: "2099-01-01", approvalReference: "board-res-13" }), 201);
    assert.equal((await check("tea", "school.operations.manage", ids.k1)).allowed, true);
    assert.equal((await check("tea", "tenant.users.manage", ids.k1)).allowed, false, "only what was handed over");
    const hijack = await as("tea")("POST", "/delegations", { fromAssignmentId: sup1.roles[0].id, delegatePrincipalId: s.op.me.principalId, delegateHomeNodeId: ids.tx,
      nodeId: ids.d1, capabilities: ["tenant.users.manage"], purpose: "help out", effectiveTo: "2099-01-01", approvalReference: "x" });
    assert.equal(hijack.status, 403); assert.equal(hijack.body.reason, "not_your_authority");
    ok(await as("sup1")("POST", `/delegations/${dl.id}/revoke`, { reason: "storm over" }));
    assert.equal((await check("tea", "school.operations.manage", ids.k1)).allowed, false);
  });

  it("policies: the state locks staff MFA; the district can't undo it; quotas stay with the district", async () => {
    ok(await as("tea")("POST", "/policy-settings", { policyId: "security.mfa.required_for_staff", nodeId: ids.tx, value: true, lockDescendants: true, reason: "state rule 19" }), 201);
    ok(await as("sup1")("POST", "/policy-settings", { policyId: "security.mfa.required_for_staff", nodeId: ids.d1, value: false, reason: "trying" }), 201);
    const mfa = ok(await as("sup1")("GET", `/policies/security.mfa.required_for_staff/resolve?nodeId=${ids.k1}`));
    assert.equal(mfa.value, true); assert.match(mfa.conflicts[0].reason, /^locked_by:/);
    ok(await as("sup1")("POST", "/policy-settings", { policyId: "student.storage_quota_mb_per_pupil", nodeId: ids.d1, value: 500, reason: "board budget" }), 201);
    const quota = await as("tea")("POST", "/policy-settings", { policyId: "student.storage_quota_mb_per_pupil", nodeId: ids.tx, value: 50, reason: "state cap" });
    assert.equal(quota.status, 422); assert.match(quota.body.errors.join(";"), /can't be set at a state_education_authority/);
    assert.equal((await as("tea")("POST", "/policy-settings", { policyId: "history.retention.minimum_years", nodeId: ids.d1, value: 9, reason: "state minimum" })).status, 403, "a state sets its own node, not the district's");
    // A new version replaces the old one from its start date.
    ok(await as("sup1")("POST", "/policy-settings", { policyId: "student.storage_quota_mb_per_pupil", nodeId: ids.d1, value: 750, reason: "new budget" }), 201);
    assert.equal(ok(await as("sup1")("GET", `/policies/student.storage_quota_mb_per_pupil/resolve?nodeId=${ids.k1}`)).value, 750);
  });

  it("every decision is in a hash-chained audit log that shows tampering", async () => {
    const txLog = ok(await as("tea")("GET", `/audit?nodeId=${ids.tx}`));
    assert.ok(txLog.some(e => e.action === "set_policy" && e.decision === "allowed"));
    assert.ok(txLog.some(e => e.action === "set_policy" && e.decision === "rejected"), "rejected changes are logged too");
    const d1Log = ok(await as("sup1")("GET", `/audit?nodeId=${ids.d1}`));
    assert.ok(d1Log.some(e => e.action === "assign_role" && e.decision === "denied" && e.reason === "no_grant"));
    assert.ok(d1Log.some(e => e.action === "assign_role" && e.basis?.bootstrap === "first_district_superintendent"));
    assert.equal((await as("sup1")("GET", `/audit?nodeId=${ids.tx}`)).status, 403, "a district doesn't read the state's log");
    const v = ok(await as("op")("GET", "/audit/verify"));
    assert.equal(v.ok, true); assert.ok(v.entries > 15, String(v.entries));
    assert.equal((await as("tea")("GET", "/audit/verify")).status, 403);
    await admin.query("ALTER TABLE master_control.audit_log DISABLE TRIGGER audit_log_append_only");
    await admin.query("UPDATE master_control.audit_log SET reason='edited' WHERE seq = 3");
    await admin.query("ALTER TABLE master_control.audit_log ENABLE TRIGGER audit_log_append_only");
    const broken = ok(await as("op")("GET", "/audit/verify"));
    assert.equal(broken.ok, false); assert.equal(broken.brokenAt, 3);
  });

  it("the console loads with a strict content security policy", async () => {
    const page = await fetch(`${mc.base}/mc/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Master Control/);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  });
});
