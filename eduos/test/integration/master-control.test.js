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
import { verifyBundle, parsePublicKey } from "../../src/federation/policy-bundle.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("FED-03 Master Control against real PostgreSQL", { skip }, () => {
  let db, idp, idpTx, idpD1, admin, mc, mcRole, mcUrl, env, s = {}, ids = {};
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
  async function signIn(sub, { via = "primary", invite, claims = {} } = {}) {
    const start = await fetch(`${mc.base}/mc/auth/login?idp=${via}${invite ? `&invite=${encodeURIComponent(invite)}` : ""}`, { redirect: "manual" });
    if (start.status !== 302) return { status: start.status };
    const loc = new URL(start.headers.get("location"));
    const code = crypto.randomBytes(8).toString("hex");
    const mock = [idp, idpTx, idpD1].find(x => x && loc.href.startsWith(x.issuer));
    mock.codes.set(code, { sub, nonce: loc.searchParams.get("nonce"), ...claims });
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
    idp = await startIdp(); idpTx = await startIdp(); idpD1 = await startIdp();
    const eduEnv = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...eduEnv, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    mcRole = `mc_it_${crypto.randomBytes(4).toString("hex")}`;
    await admin.query(`CREATE ROLE ${mcRole} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${mcPw}'`);
    const u = new URL(db.ownerUrl); u.username = mcRole; u.password = mcPw; mcUrl = u.toString();
    env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development", MC_DATABASE_URL: mcUrl, MC_PUBLIC_ORIGIN: "http://localhost",
      MC_OIDC_ISSUER: idp.issuer, MC_OIDC_CLIENT_ID: "eduos-it", MC_OIDC_CLIENT_SECRET: "it-secret", MC_OIDC_REDIRECT_URI: "http://localhost/mc/auth/callback",
      MC_IDP_SECRET_TX: "it-secret", MC_IDP_SECRET_D1: "it-secret", MC_POLICY_SIGNING_SECRET: crypto.randomBytes(24).toString("hex") };
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
    await idp?.close(); await idpTx?.close(); await idpD1?.close();
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

  // ---- FED-04: identity federation ----------------------------------------
  it("trusted providers are registered by whoever governs their scope, after discovery confirms them", async () => {
    const providers = (await (await fetch(`${mc.base}/mc/auth/providers`)).json()).data;
    assert.deepEqual(providers.map(p => p.id), ["primary"], "the configured provider, created at start-up");
    const tx = { id: "tx-idp", issuer: idpTx.issuer, displayName: "Texas state sign-in", clientId: "eduos-it", clientSecretEnv: "MC_IDP_SECRET_TX",
      scopeNodeId: ids.tx, requireMfa: true, allowedEmailDomains: ["tea.texas.gov"] };
    assert.equal((await as("tea")("POST", "/identity-providers", { ...tx, scopeNodeId: "platform" })).status, 403, "a state can't vouch for the platform");
    assert.equal((await as("sup1")("POST", "/identity-providers", tx)).status, 403, "a district can't register the state's provider");
    const dead = await as("tea")("POST", "/identity-providers", { ...tx, id: "dead", issuer: "http://127.0.0.1:9" });
    assert.equal(dead.status, 422); assert.match(dead.body.errors.join(";"), /discovery failed/);
    ok(await as("tea")("POST", "/identity-providers", tx), 201);
    const d1 = { id: "lakeside-idp", issuer: idpD1.issuer, displayName: "Lakeside staff sign-in", clientId: "eduos-it", clientSecretEnv: "MC_IDP_SECRET_D1", scopeNodeId: ids.d1 };
    assert.equal((await as("tea")("POST", "/identity-providers", d1)).status, 403, "a district's provider is the district's to register");
    ok(await as("sup1")("POST", "/identity-providers", d1), 201);
    assert.equal((await as("op")("POST", "/identity-providers/primary/status", { status: "suspended", reason: "test lockout" })).status, 409);
  });

  it("invitations provision an account on first sign-in, with the provider's MFA and domain rules, once", async () => {
    const inv = ok(await as("tea")("POST", "/invitations", { nodeId: ids.tx, roleId: "state-oversight", idpId: "tx-idp", displayName: "Ana Analyst", approvalReference: "hr-tx-9" }), 201);
    assert.match(inv.signInUrl, /\/mc\/auth\/login\?idp=tx-idp&invite=/);
    const claims = { email: "ana@tea.texas.gov", email_verified: true };
    assert.equal((await signIn("ana", { via: "tx-idp", invite: inv.code, claims })).status, 403, "no second factor");
    assert.equal((await signIn("ana", { via: "tx-idp", invite: inv.code, claims: { ...claims, amr: ["pwd", "mfa"], email: "ana@gmail.com" } })).status, 403, "wrong domain");
    assert.equal((await signIn("ana", { via: "primary", invite: inv.code })).status, 403, "the provider named in the invitation");
    s.ana = await signIn("ana", { via: "tx-idp", invite: inv.code, claims: { ...claims, amr: ["pwd", "mfa"] } });
    assert.equal(s.ana.status, 303);
    assert.deepEqual(s.ana.me.roles.map(r => [r.role_id, r.node_id]), [["state-oversight", ids.tx]]);
    assert.equal(s.ana.me.idp, "tx-idp");
    assert.equal((await signIn("mallory", { via: "tx-idp", invite: inv.code, claims: { ...claims, amr: ["mfa"] } })).status, 403, "used once");
    const again = await signIn("ana", { via: "tx-idp", claims: { ...claims, amr: ["mfa"] } });
    assert.equal(again.status, 303, "and then signs in normally");
    // A provider vouches only inside its scope.
    const outside = await as("op")("POST", "/invitations", { nodeId: "platform", roleId: "platform-operator", idpId: "tx-idp", displayName: "X", approvalReference: "x" });
    assert.equal(outside.status, 422); assert.match(outside.body.errors.join(";"), /outside what tx-idp may vouch for/);
    const district = ok(await as("sup1")("POST", "/invitations", { nodeId: ids.k1, roleId: "school-principal", idpId: "lakeside-idp", displayName: "Vice Elm", approvalReference: "hr-56" }), 201);
    s.vp = await signIn("vice-elm", { via: "lakeside-idp", invite: district.code });
    assert.equal(s.vp.status, 303); assert.equal(s.vp.me.roles[0].node_id, ids.k1);
    const tooHigh = await as("sup1")("POST", "/assignments", { nodeId: ids.d1, roleId: "district-it-admin", principalId: s.vp.me.principalId, approvalReference: "x" });
    assert.equal(tooHigh.status, 201, "the district's provider covers the district too");
    const stateRole = await as("tea")("POST", "/assignments", { nodeId: ids.tx, roleId: "state-oversight", principalId: s.vp.me.principalId, approvalReference: "x" });
    assert.equal(stateRole.status, 422, "but not the state"); assert.match(stateRole.body.errors.join(";"), /outside what this person's identity provider may vouch for/);
  });

  it("an invitation is honored only while the inviter can still give the role; it can be revoked", async () => {
    const inv = ok(await as("ana")("POST", "/invitations", { nodeId: ids.tx, roleId: "state-oversight", idpId: "tx-idp", displayName: "Ben", approvalReference: "x" }), 201);
    const inv2 = ok(await as("ana")("POST", "/invitations", { nodeId: ids.tx, roleId: "state-oversight", idpId: "tx-idp", displayName: "Cy", approvalReference: "x" }), 201);
    ok(await as("ana")("POST", `/invitations/${inv2.id}/revoke`, { reason: "role filled" }));
    const claims = { email: "x@tea.texas.gov", email_verified: true, amr: ["mfa"] };
    assert.equal((await signIn("cy", { via: "tx-idp", invite: inv2.code, claims })).status, 403);
    ok(await as("tea")("POST", `/operators/${s.ana.me.principalId}/disable`, { reason: "left the agency" }));
    assert.equal((await as("ana")("GET", "/me")).status, 401, "signed out everywhere at once");
    assert.equal((await signIn("ana", { via: "tx-idp", claims: { ...claims, email: "ana@tea.texas.gov" } })).status, 403);
    assert.equal((await signIn("ben", { via: "tx-idp", invite: inv.code, claims })).status, 403, "the inviter no longer has authority");
    const list = ok(await as("tea")("GET", `/invitations?nodeId=${ids.tx}`));
    assert.deepEqual(list.filter(i => [inv.id, inv2.id].includes(i.id)).map(i => i.state).sort(), ["pending", "revoked"]);
    ok(await as("tea")("POST", `/operators/${s.ana.me.principalId}/enable`, { reason: "returned" }));
    assert.equal((await signIn("ben", { via: "tx-idp", invite: inv.code, claims })).status, 303, "and is honored again once they can");
  });

  it("account lifecycle: self-service limits, provider suspension, and stale-account review", async () => {
    s.ana = await signIn("ana", { via: "tx-idp", claims: { email: "ana@tea.texas.gov", email_verified: true, amr: ["mfa"] } });
    assert.equal((await as("ana")("POST", `/operators/${s.ana.me.principalId}/enable`, { reason: "back again" })).body.error, "cannot_enable_yourself");
    assert.equal((await as("sup1")("POST", `/operators/${s.ana.me.principalId}/disable`, { reason: "not ours" })).status, 403, "a district doesn't manage state accounts");
    ok(await as("tea")("POST", "/identity-providers/tx-idp/status", { status: "suspended", reason: "key compromise drill" }));
    assert.equal((await as("ana")("GET", "/me")).status, 401);
    assert.equal((await signIn("ana", { via: "tx-idp" })).status, 404, "the option disappears");
    ok(await as("tea")("POST", "/identity-providers/tx-idp/status", { status: "active", reason: "drill over" }));
    const review = ok(await as("op")("GET", "/operators/review?days=30"));
    const names = review.accounts.map(a => a.name);
    assert.ok(names.includes("Principal Elm"), "assigned but never signed in");
    assert.ok(!names.includes("Dr. Lake"), "signed in recently");
    const sup1Review = ok(await as("sup1")("GET", "/operators/review?days=30"));
    assert.ok(sup1Review.accounts.every(a => !["State Analyst", "Ben"].includes(a.name)), "a district sees only its own people");
    const log = ok(await as("tea")("GET", `/audit?nodeId=${ids.tx}`));
    for (const a of ["register_identity_provider", "invite", "disable_operator", "enable_operator", "set_identity_provider_status", "revoke_invitation"]) assert.ok(log.some(e => e.action === a), a);
    assert.equal(ok(await as("op")("GET", "/audit/verify")).ok, false, "still shows the earlier tampering");
  });

  // ---- FED-05: signed policy distribution -----------------------------------
  it("a state releases signed policies through a pilot district; the district answers; promotion waits for it", async () => {
    ids.d2 = ok(await as("op")("POST", "/nodes", { parentId: ids.tx, kind: "district", name: "Hill Country ISD", jurisdictionId: "US-TX", tenantRef: "tenant-hill", approvalReference: "enrol-3" }), 201).id;
    ok(await as("tea")("POST", "/policy-settings", { policyId: "history.retention.minimum_years", nodeId: ids.tx, value: 5, reason: "state records rule" }), 201);
    assert.equal((await as("sup1")("POST", "/policy-releases", { nodeId: ids.tx, reason: "try" })).status, 403, "districts don't distribute");
    const bad = await as("tea")("POST", "/policy-releases", { nodeId: ids.tx, reason: "pilot everyone", pilotDistrictIds: [ids.d1, ids.d2] });
    assert.equal(bad.status, 422);
    const rel = ok(await as("tea")("POST", "/policy-releases", { nodeId: ids.tx, reason: "Fall policy update", pilotDistrictIds: [ids.d1] }), 201);
    assert.equal(rel.status, "piloting"); assert.deepEqual(rel.issued.map(x => [x.district, x.version]), [[ids.d1, 1]]);
    ids.rel1 = rel.id;
    const promoteEarly = await as("tea")("POST", `/policy-releases/${rel.id}/promote`, {});
    assert.equal(promoteEarly.status, 409); assert.deepEqual(promoteEarly.body.pilots, [{ district: ids.d1, state: "no_response" }]);
    const d1Bundles = ok(await as("sup1")("GET", `/districts/${ids.d1}/policy-bundles`));
    assert.equal(d1Bundles.length, 1);
    const pol = Object.fromEntries(d1Bundles[0].policies.map(p => [p.id, p]));
    assert.equal(pol["security.mfa.required_for_staff"].value, true); assert.ok(pol["security.mfa.required_for_staff"].locked_by, "the state's lock travels with it");
    assert.equal(pol["history.retention.minimum_years"].value, 5);
    assert.equal(pol["student.storage_quota_mb_per_pupil"].value, 750, "the district's own quota, as the district set it");
    assert.equal((await as("tea")("POST", `/policy-bundles/${d1Bundles[0].id}/acknowledge`, { decision: "accepted" })).status, 403, "only the district answers for itself");
    assert.equal((await as("sup1")("POST", `/policy-bundles/${d1Bundles[0].id}/acknowledge`, { decision: "objected" })).status, 400, "an objection needs a note");
    ok(await as("sup1")("POST", `/policy-bundles/${d1Bundles[0].id}/acknowledge`, { decision: "objected", note: "Retention conflicts with our board policy" }), 201);
    assert.equal((await as("tea")("POST", `/policy-releases/${rel.id}/promote`, {})).body.pilots[0].state, "objected");
    ok(await as("sup1")("POST", `/policy-bundles/${d1Bundles[0].id}/acknowledge`, { decision: "accepted", note: "Board amended its policy" }), 201);
    const promoted = ok(await as("tea")("POST", `/policy-releases/${rel.id}/promote`, {}));
    assert.equal(promoted.status, "published"); assert.deepEqual(promoted.issued.map(x => [x.district, x.version]), [[ids.d2, 1]]);
  });

  it("bundles are signed for their district, versions only go up, and a rollback re-issues the earlier content", async () => {
    const key = ok(await as("op")("GET", "/policy-signing-key"));
    assert.equal(key.configured, true);
    const list = ok(await as("sup1")("GET", `/districts/${ids.d1}/policy-bundles`));
    const file = await (await fetch(`${mc.base}/mc/api/policy-bundles/${list[0].id}/file`, { headers: { cookie: s.sup1.cookie } })).json();
    const v = verifyBundle(file, parsePublicKey(key.publicKey));
    assert.equal(v.ok, true); assert.equal(v.body.district.tenant_ref, "tenant-lakeside"); assert.equal(v.body.version, 1); assert.equal(v.body.previous_sha256, null);
    assert.equal((await fetch(`${mc.base}/mc/api/policy-bundles/${list[0].id}/file`, { headers: { cookie: s.vp.cookie } })).status, 200, "the district's own people can fetch it");
    // A second release, then roll it back.
    ok(await as("tea")("POST", "/policy-settings", { policyId: "history.retention.minimum_years", nodeId: ids.tx, value: 99, reason: "typo, meant 9" }), 201);
    const r2 = ok(await as("tea")("POST", "/policy-releases", { nodeId: ids.tx, reason: "Winter update" }), 201);
    assert.equal(r2.status, "published"); assert.deepEqual(r2.issued.map(x => x.version), [2, 2]);
    const back = ok(await as("tea")("POST", `/policy-releases/${r2.id}/rollback`, { reason: "retention typo" }));
    assert.equal(back.status, "rolled_back"); assert.deepEqual(back.issued.map(x => x.version), [3, 3]);
    const after = ok(await as("sup1")("GET", `/districts/${ids.d1}/policy-bundles`));
    assert.deepEqual(after.map(b => [b.version, b.stage]), [[3, "rollback"], [2, "general"], [1, "pilot"]]);
    const ret = b => b.policies.find(p => p.id === "history.retention.minimum_years").value;
    assert.deepEqual([ret(after[2]), ret(after[1]), ret(after[0])], [5, 99, 5], "the rollback carries version 1's content");
    const v3 = await (await fetch(`${mc.base}/mc/api/policy-bundles/${after[0].id}/file`, { headers: { cookie: s.sup1.cookie } })).json();
    assert.equal(v3.previous_sha256, after[1].sha256, "each version points at the one before");
    assert.equal((await as("tea")("POST", `/policy-releases/${r2.id}/rollback`, { reason: "again" })).status, 409);
    const rels = ok(await as("tea")("GET", `/policy-releases?nodeId=${ids.tx}`));
    assert.deepEqual(rels.map(r => [r.kind, r.status]), [["rollback", "published"], ["release", "rolled_back"], ["release", "published"]]);
    await assert.rejects(admin.query("UPDATE master_control.policy_bundles SET version=9"), /append-only/);
    const log = ok(await as("tea")("GET", `/audit?nodeId=${ids.tx}`));
    for (const a of ["release_policies", "promote_policy_release", "rollback_policy_release"]) assert.ok(log.some(e => e.action === a && e.decision === "allowed"), a);
    assert.ok(log.some(e => e.action === "release_policies" && e.decision === "denied"));
  });

  it("the console loads with a strict content security policy", async () => {
    const page = await fetch(`${mc.base}/mc/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Master Control/);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  });
});
