// EduOS 32.2.0 district resource mesh and limits against real PostgreSQL, as the
// non-owner runtime role. The key property: buying/sharing an app lets other
// schools LAUNCH it, but never widens anyone's access to another school's
// student records, seats or launch rows.
// Run: EDUOS_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres npm run test:integration
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { bindingCookieName, loadPlatformKey, signJwt } from "../../src/lti.js";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("EduOS 32.2.0 district resource mesh against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, appDb, sink, tool, previousPrivateKey, s = {}, apps = {};
  const hooks = [];
  const as = name => client(server.base, s[name]);
  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    sink = http.createServer((req, res) => { let b = ""; req.on("data", d => b += d); req.on("end", () => { try { hooks.push(JSON.parse(b)); } catch {} res.end("ok"); }); });
    await new Promise(r => sink.listen(0, "127.0.0.1", r));
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    ({ privateKey: previousPrivateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }));
    const subjectSecret = "integration-test-stable-lti-subject-key-32-bytes";
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app,
      WEBHOOK_SIGNING_KEY: "w".repeat(40), WEBHOOK_ALLOW_INSECURE_LOOPBACK: "true",
      LTI_PLATFORM_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
      LTI_PLATFORM_PRIVATE_KEY_PREVIOUS: previousPrivateKey.export({ type: "pkcs8", format: "pem" }),
      LTI_PLATFORM_SUBJECT_KEY: subjectSecret });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    appDb = new pg.Client(db.appUrl); await appDb.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "p1", "p2", "t1", "pu", "pa"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { if (process.env.EDUOS_IT_DEBUG) console.log(server?.log().split("\n").filter(l => /fail|error/i.test(l)).join("\n")); await server?.stop(); await appDb?.end(); await admin?.end(); await idp?.close(); sink?.closeAllConnections(); sink?.close(); tool?.closeAllConnections(); tool?.close(); await db?.drop(); });

  it("an IT admin is district-wide for systems but has no student-record access", async () => {
    const created = await as("supt1")("POST", "/api/users", { displayName: "Iris IT", email: "iris@d1.test", oidcSubject: "iris-it", role: "it_admin" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await as("supt1")("POST", "/api/users", { displayName: "Bad", email: "b@d1.test", oidcSubject: "bad-it", role: "it_admin", schoolId: ID.s1 })).body.error, "district_role_has_no_school");
    s.it = await login(server.base, idp, "iris-it", { email_verified: true });
    assert.equal((await as("it")("GET", "/api/me")).body.role, "it_admin");
    assert.equal((await as("it")("GET", "/api/schools")).body.data.length, 2, "sees every school");
    for (const path of ["/api/students", "/api/attendance", "/api/cases", "/api/assignments", `/api/students/${ID.alice}`])
      assert.equal((await as("it")("GET", path)).status, 403, path);
    assert.equal((await as("it")("POST", "/api/users", { displayName: "Sup", email: "sup@d1.test", oidcSubject: "sup-x", role: "superintendent" })).status, 403);
    assert.equal((await as("it")("POST", "/api/users", { displayName: "New T", email: "nt@d1.test", oidcSubject: "nt-x", role: "teacher", schoolId: ID.s2 })).status, 201);
    assert.equal((await as("it")("PATCH", `/api/users/${USERS.supt1[0]}`, { displayName: "Hacked" })).status, 403);
    const me = (await as("it")("GET", "/api/me")).body;
    assert.equal((await as("it")("POST", `/api/users/${me.userId ?? me.id}/memberships`, { role: "teacher", schoolId: ID.s1 })).status, 403, "cannot give itself a role");
    const users = await as("it")("GET", "/api/users?limit=2");
    assert.equal(users.status, 200); assert.equal(users.body.data.length, 2); assert.ok(users.body.page.nextOffset === 2 && users.body.page.total > 2);
  });

  it("webhooks have no fixed cap; app catalog events are delivered", async () => {
    const url = `http://127.0.0.1:${sink.address().port}/hook`;
    for (let i = 0; i < 12; i++) {
      const r = await as("it")("POST", "/api/webhooks", { url: `${url}${i}`, eventTypes: i ? ["app.registered", "app.assigned"] : ["*"] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    assert.equal((await as("supt1")("PATCH", "/api/district/settings", { maxActiveWebhooks: 12 })).status, 200);
    assert.equal((await as("it")("POST", "/api/webhooks", { url: `${url}x`, eventTypes: ["*"] })).body.error, "webhook_limit_reached");
    assert.equal((await as("supt1")("PATCH", "/api/district/settings", { maxActiveWebhooks: null })).status, 200);
    assert.equal((await as("p1")("PATCH", "/api/district/settings", { maxSchools: 1 })).status, 403);
  });

  it("district caps are opt-in and enforced (null = unlimited)", async () => {
    const st = await as("supt1")("GET", "/api/district/settings");
    assert.equal(st.status, 200); assert.equal(st.body.data.limits.maxSchools, null);
    assert.equal((await as("supt1")("PATCH", "/api/district/settings", { maxSchools: st.body.data.usage.schools })).status, 200);
    assert.equal((await as("supt1")("POST", "/api/schools", { name: "Capped School" })).body.error, "district_limit_reached");
    await as("supt1")("PATCH", "/api/district/settings", { maxSchools: null });
    assert.equal((await as("supt1")("POST", "/api/schools", { name: "Capped School" })).status, 201);
    assert.equal((await as("supt1")("PATCH", "/api/district/settings", { maxSchools: 0 })).status, 400);
  });

  it("a district-bought app is available system-wide, with seat limits and privacy gates", async () => {
    const reg = await as("it")("POST", "/api/apps", { name: "ReadWorks", vendor: "ReadWorks Inc", launchUrl: "https://readworks.example/launch",
      integrationType: "link", dataSharingScope: "roster_basic", dpaStatus: "sdpc_signed", coppaCompliant: true, ferpaSchoolOfficial: true, category: "Reading" });
    assert.equal(reg.status, 201, JSON.stringify(reg.body)); apps.rw = reg.body.data.id;
    assert.equal((await as("it")("POST", `/api/apps/${apps.rw}/licenses`, { seatLimit: 2, startsOn: "2026-01-01", endsOn: "2099-06-30" })).status, 201);
    assert.equal((await as("it")("POST", `/api/apps/${apps.rw}/assignments`, { scope: "district" })).status, 201);
    const mine = await as("pu")("GET", "/api/my/apps");
    assert.ok(mine.body.data.some(a => a.id === apps.rw), "pupil at S1 sees the district app");
    assert.ok(mine.body.data.every(a => !("launchUrl" in a)));
    const l1 = await as("pu")("POST", `/api/apps/${apps.rw}/launch`);
    assert.equal(l1.status, 200, JSON.stringify(l1.body)); assert.equal(l1.body.data.url, "https://readworks.example/launch");
    assert.equal((await as("pu")("POST", `/api/apps/${apps.rw}/launch`)).status, 200, "relaunch reuses the seat");
    assert.equal((await as("p2")("POST", `/api/apps/${apps.rw}/launch`)).status, 200, "a second school uses the same license");
    assert.equal((await as("t1")("POST", `/api/apps/${apps.rw}/launch`)).body.error, "no_seats_available");
    const usage = await as("it")("GET", `/api/apps/${apps.rw}/usage`);
    assert.equal(usage.status, 200, JSON.stringify(usage.body));
    assert.equal(usage.body.data.seatsUsed, 2); assert.equal(usage.body.data.seatsLicensed, 2); assert.equal(usage.body.data.bySchool.length, 2);
    const audit = await admin.query("SELECT detail FROM audit_events WHERE action='launch' AND resource_id=$1", [apps.rw]);
    assert.equal(audit.rowCount, 3); assert.ok(audit.rows.every(r => JSON.parse(r.detail).dataSharingScope === "roster_basic"));

    // Non-COPPA app: staff yes, a grade-3 pupil no. Data-sharing app without a DPA: no pupils or families.
    const adult = await as("it")("POST", "/api/apps", { name: "Grown-up Tool", vendor: "V", launchUrl: "https://adult.example", integrationType: "oidc_sso", dataSharingScope: "none", coppaCompliant: false });
    const nodpa = await as("it")("POST", "/api/apps", { name: "No DPA Tool", vendor: "V", launchUrl: "https://nodpa.example", integrationType: "link", dataSharingScope: "grades", dpaStatus: "pending", coppaCompliant: true });
    for (const id of [adult.body.data.id, nodpa.body.data.id]) {
      await as("it")("POST", `/api/apps/${id}/licenses`, {});
      await as("it")("POST", `/api/apps/${id}/assignments`, { scope: "district" });
      assert.equal((await as("pu")("POST", `/api/apps/${id}/launch`)).body.error, "app_not_available");
      assert.equal((await as("t1")("POST", `/api/apps/${id}/launch`)).status, 200);
    }
    assert.equal((await as("pa")("POST", `/api/apps/${nodpa.body.data.id}/launch`)).body.error, "app_not_available");
    // Grade-targeted assignment.
    const g = await as("it")("POST", "/api/apps", { name: "HS Chem", vendor: "V", launchUrl: "https://chem.example", integrationType: "link", coppaCompliant: true });
    await as("it")("POST", `/api/apps/${g.body.data.id}/licenses`, {});
    await as("it")("POST", `/api/apps/${g.body.data.id}/assignments`, { scope: "district", gradeLevels: ["9", "10"] });
    assert.ok(!(await as("pu")("GET", "/api/my/apps")).body.data.some(a => a.id === g.body.data.id), "grade 3 pupil does not see a grade 9-10 app");
  });

  it("a school shares its own app; sharing never widens student or usage access across schools", async () => {
    const reg = await as("p1")("POST", "/api/apps", { name: "Maple Math", vendor: "Maple", launchUrl: "https://maple.example/go", integrationType: "link", coppaCompliant: true, ownerSchoolId: ID.s2 });
    assert.equal(reg.status, 201); apps.mm = reg.body.data.id;
    assert.equal(reg.body.data.ownerSchoolId, ID.s1, "a principal can only register for their own school");
    assert.equal((await as("p1")("POST", `/api/apps/${apps.mm}/licenses`, {})).status, 201);
    assert.equal((await as("p1")("POST", `/api/apps/${apps.mm}/assignments`, { scope: "district" })).status, 403, "only the district assigns district-wide");
    assert.equal((await as("p1")("POST", `/api/apps/${apps.mm}/assignments`, { scope: "school", schoolId: ID.s1 })).status, 201);
    assert.equal((await as("p2")("POST", `/api/apps/${apps.mm}/launch`)).body.error, "app_not_available", "not shared yet");
    const share = await as("p1")("POST", `/api/apps/${apps.mm}/assignments`, { scope: "school", schoolId: ID.s2, roles: ["principal", "teacher"] });
    assert.equal(share.status, 201); assert.equal(share.body.data.sharedBySchoolId, ID.s1);
    assert.equal((await as("p2")("POST", `/api/apps/${apps.mm}/launch`)).status, 200, "the shared app launches at S2");
    assert.equal((await as("p2")("POST", `/api/apps/${apps.mm}/assignments`, { scope: "school", schoolId: ID.s2 })).status, 403, "the receiving school cannot re-share");
    assert.equal((await as("t1")("POST", `/api/apps/${apps.mm}/launch`)).status, 200);

    // Student data is exactly as before.
    const p2students = (await as("p2")("GET", "/api/students")).body.data.map(x => x.id);
    assert.deepEqual(p2students, [ID.carol]);
    assert.ok([403, 404].includes((await as("p2")("GET", `/api/students/${ID.alice}`)).status));
    // Usage rows: RLS hides the other school's launches/seats from the runtime role.
    const asRole = async (role, user, school, sql, params, district = ID.d1) => {
      await appDb.query("BEGIN");
      try {
        await appDb.query("SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role',$3,true),set_config('app.school_id',$4,true)", [district, user, role, school ?? ""]);
        return (await appDb.query(sql, params)).rows;
      } finally { await appDb.query("ROLLBACK"); }
    };
    const p1rows = await asRole("principal", USERS.p1[0], ID.s1, "SELECT DISTINCT school_id FROM app_launches", []);
    assert.deepEqual(p1rows.map(r => r.school_id), [ID.s1], "principal S1 sees only S1 launch rows");
    const t1rows = await asRole("teacher", USERS.t1[0], ID.s1, "SELECT DISTINCT user_id FROM app_launches UNION SELECT user_id FROM app_seats", []);
    assert.deepEqual(t1rows.map(r => r.user_id), [USERS.t1[0]], "a teacher sees only their own launches and seats");
    await assert.rejects(asRole("teacher", USERS.t1[0], ID.s1, "INSERT INTO app_seats(district_id,license_id,user_id) SELECT district_id,id,$1 FROM app_licenses LIMIT 1", [USERS.p2[0]]));
    await assert.rejects(asRole("teacher", USERS.t1[0], ID.s1, "INSERT INTO app_launches(district_id,app_id,license_id,user_id,role,integration_type,shared_scope) SELECT district_id,app_id,id,$1,'teacher','link','none' FROM app_licenses LIMIT 1", [USERS.p2[0]]), "cannot record a launch as someone else");
    const d2rows = await asRole("superintendent", USERS.supt2[0], null, "SELECT count(*)::int AS n FROM apps", [], ID.d2);
    assert.equal(d2rows[0].n, 0, "another district sees none of D1's catalog");
    // Owner principal gets counts per school, not rows; the other principal only their school.
    const ownerUsage = await as("p1")("GET", `/api/apps/${apps.mm}/usage`);
    assert.equal(ownerUsage.body.data.scope, "district"); assert.equal(ownerUsage.body.data.bySchool.length, 2);
    const otherUsage = await as("p2")("GET", `/api/apps/${apps.mm}/usage`);
    assert.equal(otherUsage.body.data.scope, "my_school"); assert.deepEqual(otherUsage.body.data.bySchool.map(x => x.schoolId), [ID.s2]);
    assert.equal((await as("t1")("GET", `/api/apps/${apps.mm}/usage`)).status, 403);
    // D2 cannot see or launch D1's app.
    const d2 = await login(server.base, idp, "supt2", { email_verified: true });
    assert.equal((await client(server.base, d2)("POST", `/api/apps/${apps.mm}/launch`)).status, 403);
    // Revoking the share stops S2 launches.
    assert.equal((await as("p1")("DELETE", `/api/apps/${apps.mm}/assignments/${share.body.data.id}`)).status, 200);
    assert.equal((await as("p2")("POST", `/api/apps/${apps.mm}/launch`)).body.error, "app_not_available");
  });

  it("schools request apps and the district decides; requests stay within the school", async () => {
    const found = await as("it")("GET", "/api/apps?q=HS%20Chem");
    assert.equal(found.status, 200, JSON.stringify(found.body));
    const hs = found.body.data[0];
    const r = await as("t1")("POST", "/api/app-requests", { appId: hs.id, reason: "Our science club needs it" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await as("t1")("POST", "/api/app-requests", { appId: hs.id, reason: "again" })).body.error, "request_already_pending");
    const n = await as("p1")("POST", "/api/app-requests", { name: "Brand New App", vendor: "NewCo", url: "https://new.example", reason: "Phonics" });
    assert.equal(n.status, 201);
    assert.equal((await as("p1")("GET", "/api/app-requests")).body.data.length, 2);
    assert.equal((await as("p2")("GET", "/api/app-requests")).body.data.length, 0, "another school's requests are invisible");
    assert.equal((await as("p1")("PATCH", `/api/app-requests/${r.body.data.id}`, { decision: "approved" })).status, 403);
    const ok = await as("it")("PATCH", `/api/app-requests/${r.body.data.id}`, { decision: "approved", note: "Approved for S1" });
    assert.equal(ok.status, 200); assert.ok(ok.body.data.assignmentId);
    const deny = await as("supt1")("PATCH", `/api/app-requests/${n.body.data.id}`, { decision: "denied", note: "No DPA yet" });
    assert.equal(deny.status, 200);
    const t1apps = (await as("t1")("GET", "/api/my/apps")).body.data.map(a => a.id);
    assert.ok(t1apps.includes(hs.id));
    const flow = await admin.query("SELECT event_type FROM flow_events WHERE event_type LIKE 'app.%'");
    for (const t of ["app.registered", "app.licensed", "app.assigned", "app.unassigned", "app.requested", "app.request.decided"])
      assert.ok(flow.rows.some(x => x.event_type === t), t);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(hooks.some(h => h.type === "app.registered") && hooks.every(h => !JSON.stringify(h).includes("ReadWorks")), "webhooks carry ids, not names");
  });

  it("LTI 1.3 launch: signed id_token, registered redirect only, claims limited to scope, single use", async () => {
    // Launch-binding cookies (one per launch) collected from launch responses,
    // sent back on /lti/authorize as the launching browser would.
    const jar = new Map();
    const launchAs = async (who, appId) => {
      const r = await as(who)("POST", `/api/apps/${appId}/launch`);
      for (const c of r.headers.getSetCookie()) { const m = /^(eduos_lti_[0-9a-f]+)=([^;]*)/.exec(c); if (m) jar.set(m[1], m[2]); }
      return r;
    };
    const lfetch = (url, init = {}) => String(url).includes("/lti/authorize")
      ? fetch(url, { ...init, headers: { ...(init.headers || {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } })
      : fetch(url, init);
    const got = [];
    tool = http.createServer(async (req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname === "/login") {
        const p = new URLSearchParams({ scope: "openid", response_type: "id_token", response_mode: "form_post", prompt: "none",
          client_id: u.searchParams.get("client_id"), redirect_uri: `http://127.0.0.1:${tool.address().port}/launch`,
          login_hint: u.searchParams.get("login_hint"), lti_message_hint: u.searchParams.get("lti_message_hint"), state: "st-1", nonce: "n-1" });
        res.writeHead(302, { location: `${server.base}/lti/authorize?${p}` }); return res.end();
      }
      got.push(u.pathname); res.end("tool");
    });
    await new Promise(r => tool.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${tool.address().port}`;
    const reg = await as("it")("POST", "/api/apps", { name: "LTI Lab", vendor: "Tool Co", launchUrl: `${base}/launch`, integrationType: "lti13", dataSharingScope: "none", coppaCompliant: true,
      integrationConfig: { clientId: "tool-client", deploymentId: "dep-1", loginUrl: `${base}/login`, redirectUris: [`${base}/launch`], targetLinkUri: `${base}/launch` } });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(reg.body.data.registrationStatus, "pending", "new LTI registrations require district approval");
    // Establish launch entitlement first so the pending-approval response is
    // tested independently of the app-availability authorization gate.
    await as("it")("POST", `/api/apps/${reg.body.data.id}/licenses`, {});
    await as("it")("POST", `/api/apps/${reg.body.data.id}/assignments`, { scope: "district" });
    const blocked = await launchAs("pu", reg.body.data.id);
    assert.equal(blocked.status, 409); assert.equal(blocked.body.error, "lti_approval_required");
    assert.equal((await as("p1")("POST", `/api/apps/${reg.body.data.id}/lti/approve`)).status, 403, "school principals cannot approve district LTI registrations");
    const selfApproval = await as("it")("POST", `/api/apps/${reg.body.data.id}/lti/approve`);
    assert.deepEqual([selfApproval.status, selfApproval.body.error], [409, "lti_second_approver_required"], "the registrant cannot approve their own tool");
    const approval = await as("supt1")("POST", `/api/apps/${reg.body.data.id}/lti/approve`);
    assert.equal(approval.status, 200, JSON.stringify(approval.body));
    assert.equal(approval.body.data.registrationStatus, "approved");
    const approvalPrivileges = await appDb.query(
      "SELECT has_column_privilege(current_user,'apps','lti_registration_status','UPDATE') AS can_write_status, " +
      "has_column_privilege(current_user,'apps','lti_approved_config_hash','UPDATE') AS can_write_hash, " +
      "has_function_privilege(current_user,'eduos_lti_approve_registration(uuid,text,uuid)','EXECUTE') AS can_approve");
    assert.equal(approvalPrivileges.rows[0].can_write_status, false, "runtime cannot write approval state directly");
    assert.equal(approvalPrivileges.rows[0].can_write_hash, false, "runtime cannot forge the approved fingerprint");
    assert.equal(approvalPrivileges.rows[0].can_approve, true, "runtime may invoke the guarded approval function");
    await assert.rejects(() => appDb.query("UPDATE apps SET lti_registration_status='approved'"), { code: "42501" });
    await appDb.query("BEGIN");
    await appDb.query(
      "SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role','pupil',true),set_config('app.school_id',$3,true)",
      [ID.d1, USERS.pu[0], ID.s1]);
    await assert.rejects(
      () => appDb.query("SELECT * FROM eduos_lti_approve_registration($1,$2,$3)", [reg.body.data.id, "A".repeat(43), USERS.pu[0]]),
      { code: "42501" });
    await appDb.query("ROLLBACK");
    await appDb.query("BEGIN");
    await appDb.query(
      "SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role','',true),set_config('app.school_id',$3,true)",
      [ID.d1, USERS.pu[0], ID.s1]);
    await assert.rejects(
      () => appDb.query("SELECT * FROM eduos_lti_revoke_registration($1,$2)", [reg.body.data.id, USERS.pu[0]]),
      { code: "42501" });
    await appDb.query("ROLLBACK");
    assert.equal((await as("it")("POST", "/api/apps", { name: "Bad LTI", vendor: "x", launchUrl: `${base}/x`, integrationType: "lti13", integrationConfig: { clientId: "c" } })).body.error, "invalid_lti_config");
    assert.equal((await as("it")("POST", "/api/apps", { name: "Secret LTI", vendor: "x", launchUrl: `${base}/x`, integrationType: "link", integrationConfig: { clientSecret: "x" } })).body.error, "integration_config_must_not_hold_secrets");
    assert.equal((await as("it")("POST", "/api/apps", { name: "Nested Secret LTI", vendor: "x", launchUrl: `${base}/x`, integrationType: "link", integrationConfig: { settings: { credentials: { clientSecret: "x" } } } })).body.error, "integration_config_must_not_hold_secrets");
    const changedConfig = { ...reg.body.data.integrationConfig, redirectUris: [...reg.body.data.integrationConfig.redirectUris, `${base}/alternate`] };
    const changed = await as("it")("PATCH", `/api/apps/${reg.body.data.id}`, { integrationConfig: changedConfig });
    assert.equal(changed.status, 200); assert.equal(changed.body.data.registrationStatus, "pending", "registration changes invalidate approval");
    assert.equal((await launchAs("pu", reg.body.data.id)).status, 409);
    assert.equal((await as("supt1")("POST", `/api/apps/${reg.body.data.id}/lti/approve`)).status, 200, "district must reapprove changed registration");
    const launch = await launchAs("pu", reg.body.data.id);
    assert.equal(launch.status, 200, JSON.stringify(launch.body));
    const login1 = await lfetch(launch.body.data.url, { redirect: "manual" });
    let authorize = login1.headers.get("location");
    const revoked = await as("it")("POST", `/api/apps/${reg.body.data.id}/lti/revoke`);
    assert.equal(revoked.status, 200); assert.equal(revoked.body.data.registrationStatus, "revoked");
    assert.equal((await lfetch(authorize)).status, 409, "revocation blocks an in-flight callback");
    assert.equal((await as("supt1")("POST", `/api/apps/${reg.body.data.id}/lti/approve`)).status, 200);
    assert.equal((await lfetch(authorize)).status, 409, "reapproval does not revive hints issued under an earlier approval");
    const freshLaunch = await launchAs("pu", reg.body.data.id);
    assert.equal(freshLaunch.status, 200);
    const freshLogin = await lfetch(freshLaunch.body.data.url, { redirect: "manual" });
    authorize = freshLogin.headers.get("location");
    // Executable OIDC negative cases: reject malformed protocol parameters
    // before consuming the valid one-time launch hint.
    for (const [name, value] of [
      ["scope", "openid profile"], ["response_type", "code"], ["response_mode", "query"],
      ["prompt", "login"], ["client_id", "another-client"], ["nonce", ""], ["state", ""],
      ["redirect_uri", "https://evil.example/callback"], ["unsupported_extension", "unexpected"]
    ]) {
      const invalid = new URL(authorize);
      invalid.searchParams.set(name, value);
      const denied = await lfetch(invalid);
      assert.equal(denied.status, 400, `OIDC rejects ${name}=${value}`);
      assert.match(await denied.text(), /LTI launch refused/);
    }
    for (const name of ["scope", "response_type", "response_mode", "nonce", "state", "redirect_uri", "client_id"]) {
      const missing = new URL(authorize);
      missing.searchParams.delete(name);
      assert.equal((await lfetch(missing)).status, 400, `OIDC requires ${name}`);
    }
    // Browser binding: the hint alone (no cookie, or another launch's cookie) is refused,
    // and refusing doesn't use up the launch.
    const noCookie = await fetch(authorize);
    assert.equal(noCookie.status, 403); assert.match(await noCookie.text(), /launch_browser_mismatch/);
    const otherLaunch = await launchAs("pu", reg.body.data.id);
    const otherName = [...jar.keys()].at(-1);
    const wrongCookie = await fetch(authorize, { headers: { cookie: `${bindingCookieName(new URL(authorize).searchParams.get("login_hint"))}=${jar.get(otherName)}` } });
    assert.equal(wrongCookie.status, 403, "another launch's binding value does not match");
    assert.ok(otherLaunch.headers.getSetCookie().some(c => /HttpOnly/.test(c) && /Path=\/lti\/authorize/.test(c) && /Max-Age=300/.test(c)));
    const page = await lfetch(authorize);
    assert.equal(page.status, 200);
    assert.ok(page.headers.getSetCookie().some(c => /^eduos_lti_[0-9a-f]+=;/.test(c) && /Max-Age=0/.test(c)), "binding cookie cleared once used");
    assert.match(page.headers.get("content-security-policy"), /script-src 'sha256-[A-Za-z0-9+/=]+'/);
    assert.doesNotMatch(page.headers.get("content-security-policy"), /script-src 'unsafe-inline'/);
    const html = await page.text();
    const token = /name="id_token" value="([^"]+)"/.exec(html)[1];
    assert.match(page.headers.get("content-security-policy"), new RegExp(`form-action ${base.replace(/[.:/]/g, "\\$&")}`));
    const { payload, protectedHeader } = await jwtVerify(token, createRemoteJWKSet(new URL(`${server.base}/.well-known/jwks.json`)), { issuer: "http://localhost", audience: "tool-client" });
    assert.equal(protectedHeader.alg, "RS256"); assert.equal(payload.nonce, "n-1");
    const jwksResponse = await lfetch(`${server.base}/.well-known/jwks.json`);
    const publishedJwks = await jwksResponse.json();
    assert.equal(publishedJwks.keys.length, 2, "JWKS publishes active and previous verification keys");
    assert.equal(protectedHeader.kid, publishedJwks.keys[0].kid, "new tokens use the active key");
    const previousKey = loadPlatformKey(previousPrivateKey.export({ type: "pkcs8", format: "pem" }));
    const previousToken = signJwt(previousKey, { iss: "http://localhost", aud: "tool-client", iat: 1000, exp: 2000, sub: "rotation-check" });
    const previousVerified = await jwtVerify(previousToken, createRemoteJWKSet(new URL(`${server.base}/.well-known/jwks.json`)), { issuer: "http://localhost", audience: "tool-client", currentDate: new Date(1500 * 1000) });
    assert.equal(previousVerified.payload.sub, "rotation-check", "relying parties can still verify a token signed by the previous key");
    assert.equal(payload["https://purl.imsglobal.org/spec/lti/claim/deployment_id"], "dep-1");
    assert.deepEqual(payload["https://purl.imsglobal.org/spec/lti/claim/roles"], ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"]);
    assert.ok(!payload.name && !payload.email && !payload["https://purl.imsglobal.org/spec/lti/claim/context"], "scope 'none' sends no name, email or school");
    assert.notEqual(payload.sub, USERS.pu[0], "subject is pairwise, not the EduOS user id");
    assert.equal((await lfetch(authorize)).status, 409, "a launch hint is single-use");
    const evil = new URL(authorize); evil.searchParams.set("redirect_uri", "https://evil.example/steal");
    assert.equal((await lfetch(evil)).status, 400);
    const forged = new URL(authorize); forged.searchParams.set("lti_message_hint", forged.searchParams.get("lti_message_hint").replace(/^(.{10})(.)/, (_, a, c) => a + (c === "A" ? "B" : "A")));
    assert.equal((await lfetch(forged)).status, 400);

    // Reject OIDC parameter pollution across query and form transports.
    const pollutionLaunch = await launchAs("pu", reg.body.data.id);
    assert.equal(pollutionLaunch.status, 200);
    const pollutionInit = await lfetch(pollutionLaunch.body.data.url, { redirect: "manual" });
    const pollutionAuthorize = new URL(pollutionInit.headers.get("location"));
    const pollutionForm = new URLSearchParams(pollutionAuthorize.searchParams);
    const polluted = await lfetch(`${server.base}/lti/authorize?scope=openid`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: pollutionForm
    });
    assert.equal(polluted.status, 400);
    assert.match(await polluted.text(), /duplicate_request_parameters/);

    // Prototype-sensitive and arbitrary form keys must be rejected before
    // request fields are materialized into an object.
    for (const key of ["__proto__", "constructor", "prototype", "unsupported_extension"]) {
      const hostileForm = new URLSearchParams(authorize.searchParams);
      hostileForm.set(key, "unexpected");
      const hostile = await lfetch(`${server.base}/lti/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: hostileForm.toString()
      });
      assert.equal(hostile.status, 400, `OIDC form rejects key ${key}`);
      assert.match(await hostile.text(), /invalid_request/);
    }

    // OIDC response_mode=form_post must reject JSON even when the payload
    // contains otherwise valid OIDC parameters.
    const jsonPost = await lfetch(`${server.base}/lti/authorize`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(pollutionForm))
    });
    assert.equal(jsonPost.status, 415);
    assert.match(await jsonPost.text(), /unsupported_content_type/);

    // Repeated URL-encoded protocol fields parse as arrays and must fail the
    // scalar OIDC parameter validation rather than selecting one value.
    const duplicateForm = new URLSearchParams(pollutionForm);
    duplicateForm.append("scope", "openid");
    const duplicated = await lfetch(`${server.base}/lti/authorize`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: duplicateForm
    });
    assert.equal(duplicated.status, 400);
    assert.match(await duplicated.text(), /invalid_request/);

    // The route-specific URL-encoded parser has a 16KB ceiling. Oversized
    // callback bodies must fail closed before OIDC validation or token issue.
    const oversizedForm = new URLSearchParams(pollutionForm);
    oversizedForm.set("state", "x".repeat(17 * 1024));
    const oversized = await lfetch(`${server.base}/lti/authorize`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: oversizedForm
    });
    const oversizedBody = await oversized.text();
    assert.equal(oversized.status, 413, `oversized LTI form response: ${oversizedBody}`);
    assert.match(oversizedBody, /payload_too_large/);

    // Revocation-window regression tests: each scenario gets a fresh launch
    // hint, then changes authoritative PostgreSQL state before the callback.
    // Restore fixture state in finally so one assertion cannot poison later cases.
    const expectRevokedCallback = async ({ revoke, restore, expected }) => {
      const freshLaunch = await launchAs("pu", reg.body.data.id);
      assert.equal(freshLaunch.status, 200, JSON.stringify(freshLaunch.body));
      const initiation = await lfetch(freshLaunch.body.data.url, { redirect: "manual" });
      assert.equal(initiation.status, 302);
      const callback = initiation.headers.get("location");
      assert.ok(callback, "tool login initiation must produce an authorization request");
      try {
        await revoke({ launchUrl: freshLaunch.body.data.url });
        const denied = await lfetch(callback);
        assert.equal(denied.status, 403, expected);
        const body = await denied.text();
        assert.match(body, /LTI launch refused/);
        assert.match(body, new RegExp(expected));
        assert.doesNotMatch(body, /id_token/, "revoked authority must not produce an ID token");
      } finally {
        await restore({ launchUrl: freshLaunch.body.data.url });
      }
    };

    await expectRevokedCallback({
      expected: "membership_inactive",
      revoke: () => admin.query("UPDATE memberships SET status='disabled' WHERE user_id=$1 AND district_id=$2 AND role='pupil' AND school_id=$3", [USERS.pu[0], ID.d1, ID.s1]),
      restore: () => admin.query("UPDATE memberships SET status='active' WHERE user_id=$1 AND district_id=$2 AND role='pupil' AND school_id=$3", [USERS.pu[0], ID.d1, ID.s1])
    });

    let revokedAssignmentId;
    await expectRevokedCallback({
      expected: "app_not_available",
      revoke: async () => {
        const r = await admin.query("UPDATE app_assignments SET revoked_at=now() WHERE district_id=$1 AND app_id=$2 AND revoked_at IS NULL RETURNING id", [ID.d1, reg.body.data.id]);
        assert.ok(r.rowCount > 0, "fixture must have an active app assignment");
        revokedAssignmentId = r.rows[0].id;
      },
      restore: () => admin.query("UPDATE app_assignments SET revoked_at=NULL, revoked_by=NULL WHERE id=$1", [revokedAssignmentId])
    });

    await expectRevokedCallback({
      expected: "app_not_available|license_inactive",
      revoke: async ({ launchUrl }) => {
        const launchId = new URL(launchUrl).searchParams.get("login_hint");
        const original = await admin.query("SELECT license_id FROM app_launches WHERE id=$1", [launchId]);
        assert.equal(original.rowCount, 1, "original launch row must exist");
        await admin.query("UPDATE app_licenses SET status='cancelled' WHERE id=$1", [original.rows[0].license_id]);
      },
      restore: async ({ launchUrl }) => {
        const launchId = new URL(launchUrl).searchParams.get("login_hint");
        const original = await admin.query("SELECT license_id FROM app_launches WHERE id=$1", [launchId]);
        if (original.rowCount) await admin.query("UPDATE app_licenses SET status='active' WHERE id=$1", [original.rows[0].license_id]);
      }
    });

    await expectRevokedCallback({
      expected: "launch_not_found",
      revoke: () => admin.query("UPDATE users SET status='disabled' WHERE id=$1", [USERS.pu[0]]),
      restore: () => admin.query("UPDATE users SET status='active' WHERE id=$1", [USERS.pu[0]])
    });

    await expectRevokedCallback({
      expected: "launch_not_found",
      revoke: () => admin.query("UPDATE schools SET status='disabled' WHERE id=$1", [ID.s1]),
      restore: () => admin.query("UPDATE schools SET status='active' WHERE id=$1", [ID.s1])
    });
  });

  it("LTI-02 Deep Linking: a teacher places tool content on an assignment; students open it through a governed launch", async () => {
    const jar = new Map();
    const keep = r => { for (const c of r.headers.getSetCookie()) { const m = /^(eduos_lti(?:dl)?_[0-9a-f]+)=([^;]*)/.exec(c); if (m) jar.set(m[1], m[2]); } return r; };
    const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const { privateKey: toolPriv, publicKey: toolPub } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { privateKey: otherPriv } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const toolSign = (claims, key = toolPriv) => {
      const h = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "tool-1" })).toString("base64url"), p = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `${h}.${p}.${crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
    };
    const dlTool = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname === "/jwks") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ keys: [{ ...toolPub.export({ format: "jwk" }), kid: "tool-1", alg: "RS256", use: "sig" }] })); }
      if (u.pathname === "/login") {
        const p = new URLSearchParams({ scope: "openid", response_type: "id_token", response_mode: "form_post", prompt: "none", client_id: u.searchParams.get("client_id"),
          redirect_uri: `http://127.0.0.1:${dlTool.address().port}/launch`, login_hint: u.searchParams.get("login_hint"),
          lti_message_hint: u.searchParams.get("lti_message_hint"), state: "st", nonce: crypto.randomUUID() });
        res.writeHead(302, { location: `${server.base}/lti/authorize?${p}` }); return res.end();
      }
      res.end("tool");
    });
    await new Promise(r => dlTool.listen(0, "127.0.0.1", r));
    try {
      const tb = `http://127.0.0.1:${dlTool.address().port}`;
      const reg = await as("it")("POST", "/api/apps", { name: "Practice Tool", vendor: "Tool Co", launchUrl: `${tb}/launch`, integrationType: "lti13", dataSharingScope: "none", coppaCompliant: true,
        integrationConfig: { clientId: "dl-client", deploymentId: "dl-dep", loginUrl: `${tb}/login`, redirectUris: [`${tb}/launch`], targetLinkUri: `${tb}/launch`,
          deepLinkingUrl: `${tb}/dl`, jwksUrl: `${tb}/jwks` } });
      assert.equal(reg.status, 201, JSON.stringify(reg.body));
      const appId = reg.body.data.id;
      await as("it")("POST", `/api/apps/${appId}/licenses`, {});
      await as("it")("POST", `/api/apps/${appId}/assignments`, { scope: "district" });
      assert.equal((await as("supt1")("POST", `/api/apps/${appId}/lti/approve`)).status, 200);
      assert.equal((await as("t1")("GET", "/api/my/apps")).body.data.find(x => x.id === appId).deepLinking, true);
      const asg = (await admin.query("SELECT id FROM assignments WHERE title='Published reading' AND district_id=$1", [ID.d1])).rows[0].id;

      assert.equal((await as("pu")("POST", `/api/apps/${appId}/deep-link`, { assignmentId: asg })).body.error, "deep_linking_teachers_only");
      assert.equal((await as("t1")("POST", `/api/apps/${appId}/deep-link`, { assignmentId: crypto.randomUUID() })).body.error, "assignment_not_manageable");
      // The teacher opens the tool to choose content for "Published reading".
      const start = keep(await as("t1")("POST", `/api/apps/${appId}/deep-link`, { assignmentId: asg }));
      assert.equal(start.status, 200, JSON.stringify(start.body));
      assert.equal(new URL(start.body.data.url).searchParams.get("target_link_uri"), `${tb}/dl`);
      const authorize = (await fetch(start.body.data.url, { redirect: "manual" })).headers.get("location");
      const page = keep(await fetch(authorize, { headers: { cookie: cookies() } }));
      assert.equal(page.status, 200);
      const idToken = /name="id_token" value="([^"]+)"/.exec(await page.text())[1];
      const req1 = (await jwtVerify(idToken, createRemoteJWKSet(new URL(`${server.base}/.well-known/jwks.json`)), { issuer: "http://localhost", audience: "dl-client" })).payload;
      assert.equal(req1["https://purl.imsglobal.org/spec/lti/claim/message_type"], "LtiDeepLinkingRequest");
      assert.deepEqual(req1["https://purl.imsglobal.org/spec/lti/claim/roles"], ["http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"]);
      assert.equal(req1["https://purl.imsglobal.org/spec/lti/claim/resource_link"], undefined);
      const settings = req1["https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings"];
      assert.equal(settings.deep_link_return_url, "http://localhost/lti/deep-link/return");
      assert.deepEqual(settings.accept_types, ["ltiResourceLink"]);

      // The tool answers with two items: one on its own site, one elsewhere.
      const now = Math.floor(Date.now() / 1000);
      const response = (extra = {}, key) => toolSign({ iss: "dl-client", aud: "http://localhost", iat: now, exp: now + 300, nonce: crypto.randomUUID(),
        "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiDeepLinkingResponse", "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
        "https://purl.imsglobal.org/spec/lti/claim/deployment_id": "dl-dep", "https://purl.imsglobal.org/spec/lti-dl/claim/data": settings.data,
        "https://purl.imsglobal.org/spec/lti-dl/claim/content_items": [
          { type: "ltiResourceLink", title: "Fractions practice", url: `${tb}/activity/7`, custom: { level: "3" }, lineItem: { scoreMaximum: 10 } },
          { type: "ltiResourceLink", title: "Elsewhere", url: "https://evil.example/phish" }], ...extra }, key);
      const post = (jwt, cookie = cookies()) => fetch(`${server.base}/lti/deep-link/return`, { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams({ JWT: jwt }) });
      const forged = await post(response({}, otherPriv));
      assert.equal(forged.status, 400); assert.match(await forged.text(), /jwt signature invalid/);
      const noBrowser = await post(response(), "");
      assert.equal(noBrowser.status, 403, "only the teacher's browser can complete it");
      const wrongDeployment = await post(response({ "https://purl.imsglobal.org/spec/lti/claim/deployment_id": "other" }));
      assert.equal(wrongDeployment.status, 400);
      const done = await post(response());
      const doneText = await done.text();
      assert.equal(done.status, 200, doneText);
      assert.match(doneText, /1 activity was added/); assert.match(doneText, /1 item was not added/); assert.match(doneText, /Grade passback isn&#39;t turned on/);
      assert.match(done.headers.get("content-security-policy"), /default-src 'none'/);
      const replay = await post(response());
      assert.equal(replay.status, 409); assert.match(await replay.text(), /response already used/);

      // Students see it on the assignment and open it through a normal, bound launch.
      const links = (await as("pu")("GET", `/api/lti/content-links?assignmentId=${asg}`)).body.data;
      assert.deepEqual(links.map(x => [x.title, x.appName, x.canRemove]), [["Fractions practice", "Practice Tool", false]]);
      assert.deepEqual((await as("pu")("GET", `/api/lti/content-links?assignmentId=${ID.draft}`)).body.data, []);
      const stored = (await admin.query("SELECT url, custom FROM lti_content_links WHERE id=$1", [links[0].id])).rows[0];
      assert.deepEqual(stored, { url: `${tb}/activity/7`, custom: { level: "3" } });
      const open = keep(await as("pu")("POST", `/api/apps/${appId}/launch`, { contentLinkId: links[0].id }));
      assert.equal(open.status, 200, JSON.stringify(open.body));
      const openAuth = (await fetch(open.body.data.url, { redirect: "manual" })).headers.get("location");
      const openPage = await fetch(openAuth, { headers: { cookie: cookies() } });
      const token = /name="id_token" value="([^"]+)"/.exec(await openPage.text())[1];
      const launchClaims = (await jwtVerify(token, createRemoteJWKSet(new URL(`${server.base}/.well-known/jwks.json`)), { issuer: "http://localhost", audience: "dl-client" })).payload;
      assert.deepEqual(launchClaims["https://purl.imsglobal.org/spec/lti/claim/resource_link"], { id: links[0].id, title: "Fractions practice" });
      assert.equal(launchClaims["https://purl.imsglobal.org/spec/lti/claim/target_link_uri"], `${tb}/activity/7`);
      assert.deepEqual(launchClaims["https://purl.imsglobal.org/spec/lti/claim/custom"], { level: "3" });
      assert.equal((await as("pu")("POST", `/api/apps/${appId}/launch`, { contentLinkId: crypto.randomUUID() })).body.error, "content_not_available");

      // Only the assignment's manager can remove it.
      assert.equal((await as("pu")("DELETE", `/api/lti/content-links/${links[0].id}`)).status, 404);
      assert.equal((await as("t1")("DELETE", `/api/lti/content-links/${links[0].id}`)).status, 200);
      assert.deepEqual((await as("pu")("GET", `/api/lti/content-links?assignmentId=${asg}`)).body.data, []);
      // Adding Deep Linking to an approved tool is a registration change: approval again.
      const plain = await as("it")("PATCH", `/api/apps/${appId}`, { integrationConfig: { ...reg.body.data.integrationConfig, jwksUrl: `${tb}/jwks2` } });
      assert.equal(plain.body.data.registrationStatus, "pending");
    } finally { await new Promise(r => dlTool.close(r)); }
  });

  it("LTI-03 NRPS: a course's class list goes only to an approved tool a teacher chose, through a signed token", async () => {
    const { privateKey: toolPriv, publicKey: toolPub } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { privateKey: otherPriv } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sign = (claims, key = toolPriv) => {
      const h = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "nr-1" })).toString("base64url"), p = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `${h}.${p}.${crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
    };
    const tool = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname === "/jwks") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ keys: [{ ...toolPub.export({ format: "jwk" }), kid: "nr-1", alg: "RS256", use: "sig" }] })); }
      if (u.pathname === "/login") {
        const p = new URLSearchParams({ scope: "openid", response_type: "id_token", response_mode: "form_post", prompt: "none", client_id: u.searchParams.get("client_id"),
          redirect_uri: `http://127.0.0.1:${tool.address().port}/launch`, login_hint: u.searchParams.get("login_hint"), lti_message_hint: u.searchParams.get("lti_message_hint"), state: "st", nonce: crypto.randomUUID() });
        res.writeHead(302, { location: `${server.base}/lti/authorize?${p}` }); return res.end();
      }
      res.end("tool");
    });
    await new Promise(r => tool.listen(0, "127.0.0.1", r));
    const jar = new Map();
    const launchAs = async (who, appId, linkId) => {
      const r = await as(who)("POST", `/api/apps/${appId}/launch`, { contentLinkId: linkId });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      for (const c of r.headers.getSetCookie()) { const m = /^(eduos_lti_[0-9a-f]+)=([^;]*)/.exec(c); if (m) jar.set(m[1], m[2]); }
      const auth = (await fetch(r.body.data.url, { redirect: "manual" })).headers.get("location");
      const page = await fetch(auth, { headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
      const token = /name="id_token" value="([^"]+)"/.exec(await page.text())[1];
      return (await jwtVerify(token, createRemoteJWKSet(new URL(`${server.base}/.well-known/jwks.json`)), { issuer: "http://localhost", audience: "nr-client" })).payload;
    };
    try {
      const tb = `http://127.0.0.1:${tool.address().port}`;
      const cfg = { clientId: "nr-client", deploymentId: "nr-dep", loginUrl: `${tb}/login`, redirectUris: [`${tb}/launch`], targetLinkUri: `${tb}/launch`, jwksUrl: `${tb}/jwks` };
      const body = { name: "Class Tool", vendor: "Tool Co", launchUrl: `${tb}/launch`, integrationType: "lti13", dataSharingScope: "roster_basic", dpaStatus: "signed", coppaCompliant: true };
      const { jwksUrl: _, ...noServices } = cfg;
      assert.equal((await as("it")("POST", "/api/apps", { ...body, integrationConfig: noServices })).body.error, "roster_scope_needs_names_roles");
      const reg = await as("it")("POST", "/api/apps", { ...body, integrationConfig: { ...cfg, namesRoles: true } });
      assert.equal(reg.status, 201, JSON.stringify(reg.body));
      const appId = reg.body.data.id;
      await as("it")("POST", `/api/apps/${appId}/licenses`, {});
      await as("it")("POST", `/api/apps/${appId}/assignments`, { scope: "district" });
      assert.equal((await as("supt1")("POST", `/api/apps/${appId}/lti/approve`)).status, 200);

      // A course with Alice (who has a pupil account) and Bob (who doesn't), and a placed link.
      const course = (await as("t1")("POST", "/api/learning/courses", { title: "Reading 3", subject: "ELA", gradeLevel: "3" })).body.data;
      assert.equal((await as("t1")("POST", `/api/learning/courses/${course.id}/enrollments`, { studentIds: [ID.alice, ID.bob] })).status, 200);
      const asg = (await admin.query(`INSERT INTO assignments(district_id,school_id,created_by,title,status,course_id) VALUES($1,$2,$3,'Chapter 1','published',$4) RETURNING id`,
        [ID.d1, ID.s1, USERS.t1[0], course.id])).rows[0].id;
      const link = (await admin.query(`INSERT INTO lti_content_links(district_id,assignment_id,app_id,title,url,created_by) VALUES($1,$2,$3,'Chapter 1 quiz',$4,$5) RETURNING id`,
        [ID.d1, asg, appId, `${tb}/activity/1`, USERS.t1[0]])).rows[0].id;

      const before = await launchAs("pu", appId, link);
      assert.equal(before["https://purl.imsglobal.org/spec/lti/claim/context"].title, "Reading 3", "the course is the launch context");
      assert.notEqual(before["https://purl.imsglobal.org/spec/lti/claim/context"].id, course.id, "under a per-tool identifier");
      assert.equal(before["https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice"], undefined, "no class list until a teacher shares it");

      assert.equal((await as("pu")("PUT", "/api/lti/course-sharing", { courseId: course.id, appId, enabled: true })).body.error, "course_not_manageable");
      const view = (await as("t1")("GET", `/api/lti/course-sharing?courseId=${course.id}`)).body.data;
      assert.deepEqual([view.canManage, view.candidates.map(c => c.appName).includes("Class Tool"), view.shared], [true, true, []]);
      assert.equal((await as("t1")("PUT", "/api/lti/course-sharing", { courseId: course.id, appId, enabled: true })).status, 200);
      assert.deepEqual((await as("pu")("GET", `/api/lti/course-sharing?courseId=${course.id}`)).body.data.shared.map(x => x.appName), ["Class Tool"], "students can see who gets the class list");

      const after = await launchAs("pu", appId, link);
      const nrpsUrl = new URL(after["https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice"].context_memberships_url);
      assert.deepEqual(after["https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice"].service_versions, ["2.0"]);

      // The tool gets a token with a client assertion signed by its registered key.
      const tokenUrl = `${server.base}/lti/token/${ID.d1}/${appId}`;
      const now = Math.floor(Date.now() / 1000);
      const assertion = (extra = {}, key) => sign({ iss: "nr-client", sub: "nr-client", aud: `http://localhost/lti/token/${ID.d1}/${appId}`, iat: now, exp: now + 300, jti: crypto.randomUUID(), ...extra }, key);
      const ask = (a, scope = "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly") => fetch(tokenUrl, { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: a, scope }) });
      assert.equal((await ask(assertion({}, otherPriv))).status, 401, "another key");
      assert.equal((await ask(assertion({ aud: `http://localhost/lti/token/${ID.d2}/${appId}` }))).status, 401, "another registration's token URL");
      assert.equal((await ask(assertion(), "https://purl.imsglobal.org/spec/lti-ags/scope/score")).status, 400, "grade scopes aren't offered");
      const once = assertion();
      const t = await ask(once);
      assert.equal(t.status, 200, `token: ${await t.clone().text()}`);
      const { access_token, token_type, expires_in } = await t.json();
      assert.deepEqual([token_type, expires_in], ["Bearer", 3600]);
      assert.equal((await ask(once)).status, 401, "an assertion is accepted once");

      const members = async (url = nrpsUrl, token = access_token, q = "") => fetch(`${server.base}${url.pathname}${q}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      assert.equal((await members(nrpsUrl, null)).status, 401);
      const r = await members();
      assert.equal(r.status, 200, `members: ${await r.clone().text()}`);
      assert.match(r.headers.get("content-type"), /application\/vnd\.ims\.lti-nrps\.v2\.membershipcontainer\+json/);
      const container = await r.json();
      assert.equal(container.context.id, after["https://purl.imsglobal.org/spec/lti/claim/context"].id);
      const byRole = Object.fromEntries(container.members.map(m => [m.roles[0].split("#")[1], m]));
      assert.equal(container.members.length, 2, "the teacher and Alice; Bob has no EduOS account");
      assert.equal(byRole.Learner.user_id, after.sub, "the same pseudonymous id the tool saw at launch");
      assert.equal(byRole.Instructor.name, "Teacher S1");
      assert.equal((await (await members(nrpsUrl, access_token, "?role=http://purl.imsglobal.org/vocab/lis/v2/membership%23Learner")).json()).members.length, 1);
      assert.equal((await members(new URL(`http://x/lti/nrps/${crypto.randomUUID()}/memberships`))).status, 404);
      const logged = (await admin.query("SELECT service, members FROM lti_service_access_log WHERE app_id=$1 ORDER BY at", [appId])).rows;
      assert.deepEqual(logged.map(x => `${x.service}:${x.members ?? "-"}`), ["token:-", "nrps_memberships:2", "nrps_memberships:1"]);

      // The teacher stops sharing: the class list is gone at once.
      assert.equal((await as("t1")("PUT", "/api/lti/course-sharing", { courseId: course.id, appId, enabled: false })).status, 200);
      assert.equal((await members()).status, 404);
      // Sharing again gives a new address (the old one stays dead); the next launch carries it.
      await as("t1")("PUT", "/api/lti/course-sharing", { courseId: course.id, appId, enabled: true });
      assert.equal((await members()).status, 404);
      const again = new URL((await launchAs("pu", appId, link))["https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice"].context_memberships_url);
      assert.notEqual(again.pathname, nrpsUrl.pathname);
      assert.equal((await members(again)).status, 200);
      // Any change to the registration invalidates issued tokens until it's approved again.
      await as("it")("PATCH", `/api/apps/${appId}`, { integrationConfig: { ...cfg, namesRoles: true, redirectUris: [`${tb}/launch`, `${tb}/launch2`] } });
      assert.equal((await members(again)).status, 401);
    } finally { await new Promise(r => tool.close(r)); }
  });

  it("LTI-04 AGS: district guidelines, school approval, teacher switch; tool scores never silently replace a teacher's grade", async () => {
    const { privateKey: toolPriv, publicKey: toolPub } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sign = c => { const h = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "g-1" })).toString("base64url"), p = Buffer.from(JSON.stringify(c)).toString("base64url");
      return `${h}.${p}.${crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), toolPriv).toString("base64url")}`; };
    const tool = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname === "/jwks") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ keys: [{ ...toolPub.export({ format: "jwk" }), kid: "g-1", alg: "RS256", use: "sig" }] })); }
      if (u.pathname === "/login") {
        const p = new URLSearchParams({ scope: "openid", response_type: "id_token", response_mode: "form_post", prompt: "none", client_id: u.searchParams.get("client_id"),
          redirect_uri: `http://127.0.0.1:${tool.address().port}/launch`, login_hint: u.searchParams.get("login_hint"), lti_message_hint: u.searchParams.get("lti_message_hint"), state: "st", nonce: crypto.randomUUID() });
        res.writeHead(302, { location: `${server.base}/lti/authorize?${p}` }); return res.end();
      }
      res.end("tool");
    });
    await new Promise(r => tool.listen(0, "127.0.0.1", r));
    const jar = new Map();
    const launch = async (who, appId, linkId) => {
      const r = await as(who)("POST", `/api/apps/${appId}/launch`, { contentLinkId: linkId });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      for (const c of r.headers.getSetCookie()) { const m = /^(eduos_lti_[0-9a-f]+)=([^;]*)/.exec(c); if (m) jar.set(m[1], m[2]); }
      const auth = (await fetch(r.body.data.url, { redirect: "manual" })).headers.get("location");
      const html = await (await fetch(auth, { headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } })).text();
      return (await jwtVerify(/name="id_token" value="([^"]+)"/.exec(html)[1], createRemoteJWKSet(new URL(`${server.base}/.well-known/jwks.json`)), { issuer: "http://localhost", audience: "g-client" })).payload;
    };
    try {
      const tb = `http://127.0.0.1:${tool.address().port}`;
      const reg = await as("it")("POST", "/api/apps", { name: "Grading Tool", vendor: "Tool Co", launchUrl: `${tb}/launch`, integrationType: "lti13", dataSharingScope: "none", coppaCompliant: true,
        integrationConfig: { clientId: "g-client", deploymentId: "g-dep", loginUrl: `${tb}/login`, redirectUris: [`${tb}/launch`], targetLinkUri: `${tb}/launch`, jwksUrl: `${tb}/jwks`, assignmentGrades: true } });
      assert.equal(reg.status, 201, JSON.stringify(reg.body));
      const appId = reg.body.data.id;
      await as("it")("POST", `/api/apps/${appId}/licenses`, {});
      await as("it")("POST", `/api/apps/${appId}/assignments`, { scope: "district" });
      assert.equal((await as("supt1")("POST", `/api/apps/${appId}/lti/approve`)).status, 200);
      const asg = (await admin.query(`INSERT INTO assignments(district_id,school_id,created_by,title,status,points_possible) VALUES($1,$2,$3,'Unit test','published',20) RETURNING id`,
        [ID.d1, ID.s1, USERS.t1[0]])).rows[0].id;
      const link = (await admin.query(`INSERT INTO lti_content_links(district_id,assignment_id,app_id,title,url,created_by) VALUES($1,$2,$3,'Unit quiz',$4,$5) RETURNING id`,
        [ID.d1, asg, appId, `${tb}/quiz/1`, USERS.t1[0]])).rows[0].id;
      const grades = on => as("t1")("PUT", `/api/lti/content-links/${link}/grades`, { enabled: on });

      // District guidelines first, then the school, then the teacher.
      assert.equal((await grades(true)).body.error, "district_grade_passback_off");
      assert.equal((await as("p1")("PUT", "/api/lti/grade-policy", { enabled: true, teacherReviewRequired: true })).status, 403, "schools don't set district guidelines");
      assert.equal((await as("supt1")("PUT", "/api/lti/grade-policy", { enabled: true, teacherReviewRequired: true })).status, 200);
      assert.equal((await grades(true)).body.error, "school_has_not_approved_tool");
      assert.equal((await as("supt1")("PUT", "/api/lti/grade-approvals", { appId, schoolId: ID.s1, approved: true })).body.error, "schools_approve_grade_passback");
      assert.ok((await as("p1")("GET", "/api/lti/grade-approvals")).body.data.candidates.some(x => x.appId === appId));
      assert.equal((await as("p1")("PUT", "/api/lti/grade-approvals", { appId, approved: true })).status, 200);
      assert.equal((await as("t1")("PUT", "/api/lti/grade-approvals", { appId, approved: true })).status, 403);
      assert.equal((await grades(true)).status, 200);
      assert.equal((await as("p1")("PUT", `/api/lti/content-links/${link}/grades`, { enabled: false })).status, 403, "principals approve the school tool, not activity grade switches");

      // The student's launch now carries this activity's line item.
      const claims = await launch("pu", appId, link);
      const endpoint = claims["https://purl.imsglobal.org/spec/lti-ags/claim/endpoint"];
      assert.deepEqual(endpoint.scope, ["https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly", "https://purl.imsglobal.org/spec/lti-ags/scope/score"]);
      const li = new URL(endpoint.lineitem);

      // The tool signs in and reads the line item.
      const now = Math.floor(Date.now() / 1000);
      const token = async scope => fetch(`${server.base}/lti/token/${ID.d1}/${appId}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: sign({ iss: "g-client", sub: "g-client", aud: `http://localhost/lti/token/${ID.d1}/${appId}`, iat: now, exp: now + 300, jti: crypto.randomUUID() }), scope }) });
      assert.equal((await token("https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly")).status, 400, "no class lists for this tool");
      const scoreOnly = await (await token("https://purl.imsglobal.org/spec/lti-ags/scope/score")).json();
      assert.equal((await fetch(`${server.base}${li.pathname}`, { headers: { authorization: `Bearer ${scoreOnly.access_token}` } })).status, 401,
        "score-only tokens cannot read line items");
      const t = await (await token("https://purl.imsglobal.org/spec/lti-ags/scope/score https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly")).json();
      const auth = { authorization: `Bearer ${t.access_token}` };
      const item = await (await fetch(`${server.base}${li.pathname}`, { headers: auth })).json();
      assert.deepEqual([item.scoreMaximum, item.label, item.resourceLinkId], [20, "Unit quiz", link]);
      let clock = Date.now() - 60_000;
      const score = (given, max = 10, userId = claims.sub, extra = {}) => fetch(`${server.base}${li.pathname}/scores`, { method: "POST",
        headers: { ...auth, "content-type": "application/vnd.ims.lis.v1.score+json" },
        body: JSON.stringify({ userId, scoreGiven: given, scoreMaximum: max, activityProgress: "Completed", gradingProgress: "FullyGraded", timestamp: new Date(clock += 1000).toISOString(), ...extra }) });
      const sub = async () => (await admin.query("SELECT score::float8 AS score, points_earned::float8 AS points, grade_source FROM assignment_submissions WHERE assignment_id=$1 AND student_id=$2", [asg, ID.alice])).rows[0];

      // Teacher review (district default): the score waits.
      assert.equal((await score(8)).status, 204);
      assert.equal((await score(11, 10)).status, 400, "a score cannot exceed its maximum");
      assert.equal(await sub(), undefined, "nothing reaches the gradebook before review");
      assert.equal((await score(8, 10, "someone-else")).status, 422);
      assert.equal((await score(1, 10, claims.sub, { timestamp: new Date(Date.now() - 3_600_000).toISOString() })).status, 204, "older scores are accepted but ignored");
      const list = (await as("t1")("GET", `/api/lti/scores?assignmentId=${asg}`)).body.data;
      assert.deepEqual(list.map(x => [x.studentName, x.scoreGiven, x.status]), [["Alice A", 8, "pending"]]);
      assert.equal((await as("pu")("GET", `/api/lti/scores?assignmentId=${asg}`)).status, 403, "students cannot access the teacher review endpoint");
      assert.equal((await as("p1")("GET", `/api/lti/scores?assignmentId=${asg}`)).status, 403, "principals do not review individual learner scores");
      assert.equal((await as("t1")("POST", `/api/lti/scores/${list[0].id}/record`, {})).status, 200);
      assert.deepEqual(await sub(), { score: 80, points: 16, grade_source: "lti" });

      // A teacher's own grade is never replaced without asking.
      const subId = (await admin.query("SELECT id FROM assignment_submissions WHERE assignment_id=$1 AND student_id=$2", [asg, ID.alice])).rows[0].id;
      await admin.query(`INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [ID.d1, ID.s1, USERS.t1[0], ID.alice, USERS.p1[0]]);
      assert.equal((await as("t1")("POST", `/api/assignments/${asg}/submissions/${subId}/grade`, { score: 95 })).status, 200);
      assert.equal((await sub()).grade_source, "teacher");
      assert.equal((await score(9)).status, 204);
      const id9 = (await as("t1")("GET", `/api/lti/scores?assignmentId=${asg}`)).body.data[0].id;
      assert.equal((await as("t1")("POST", `/api/lti/scores/${id9}/record`, {})).body.error, "teacher_grade_exists");
      assert.equal((await sub()).score, 95);

      // Without review (district choice): scores count at once, but still not over the teacher's grade.
      assert.equal((await as("supt1")("PUT", "/api/lti/grade-policy", { enabled: true, teacherReviewRequired: false })).status, 200);
      assert.equal((await score(10)).status, 204);
      assert.equal((await sub()).score, 95, "the teacher's 95 stands");
      assert.equal((await as("t1")("POST", `/api/lti/scores/${id9}/record`, { overwrite: true })).status, 200, "unless the teacher chooses");
      assert.deepEqual(await sub(), { score: 100, points: 20, grade_source: "lti" });
      assert.equal((await score(5)).status, 204);
      assert.deepEqual(await sub(), { score: 50, points: 10, grade_source: "lti" }, "tool grades update tool grades without review");

      // District oversight: sees every school's approvals and activity, and can revoke.
      const overview = (await as("supt1")("GET", "/api/lti/grade-approvals")).body.data;
      const mine = overview.approvals.find(x => x.appId === appId);
      assert.equal(mine.schoolName, "S1"); assert.ok(mine.scores30d >= 5);
      assert.equal((await as("supt1")("PUT", "/api/lti/grade-approvals", { appId, schoolId: ID.s1, approved: false, reason: "Vendor contract under review" })).status, 200);
      assert.equal((await score(7)).status, 404, "revoked: the tool can't post");
      assert.equal((await launch("pu", appId, link))["https://purl.imsglobal.org/spec/lti-ags/claim/endpoint"], undefined);
      const events = (await admin.query("SELECT outcome FROM lti_score_events WHERE content_link_id=$1 ORDER BY received_at", [link])).rows.map(r => r.outcome);
      assert.deepEqual(events, ["pending", "stale_ignored", "pending", "pending", "recorded"]);
      await as("supt1")("PUT", "/api/lti/grade-policy", { enabled: false, teacherReviewRequired: true });
    } finally { await new Promise(r => tool.close(r)); }
  });

  it("every role gets a home dashboard scoped like its list endpoints", async () => {
    for (const name of ["supt1", "it", "p1", "p2", "t1", "pa", "pu"]) {
      const r = await as(name)("GET", "/api/home");
      assert.equal(r.status, 200, `${name} ${JSON.stringify(r.body)}`);
    }
    const it = (await as("it")("GET", "/api/home")).body.data;
    assert.equal(it.integrations.ltiEnabled, true); assert.ok(!("students" in it), "IT home carries no student counts");
    assert.equal((await as("p2")("GET", "/api/home")).body.data.students, 1);
    const family = (await as("pa")("GET", "/api/home")).body.data;
    assert.deepEqual(family.children.map(c => c.id), [ID.alice]);
    const pupil = (await as("pu")("GET", "/api/home")).body.data;
    assert.equal(pupil.children.length, 1); assert.equal(pupil.youngLearner, false, "grade 3 is not in the youngest band");
    assert.ok((await admin.query("SELECT 1 FROM audit_events WHERE resource_type='home_summary'")).rowCount >= 2);
  });

  it("lists are paged and the SIS import has no row cap", async () => {
    const students = Array.from({ length: 6000 }, (_, i) => ({ localStudentNumber: `BULK-${i}`, displayName: `Bulk Student ${i}`, gradeLevel: String(1 + i % 12) }));
    const attendance = students.slice(0, 11000 > students.length ? students.length : 11000).map((x, i) => ({ sourceEventId: `bulk-ev-${i}`, localStudentNumber: x.localStudentNumber, eventDate: "2026-03-02", status: "present" }));
    const r = await as("supt1")("POST", "/api/integrations/sis/import", { schoolId: ID.s2, sourceSystem: "bulk", sourceBatchId: "bulk-1", students, attendance });
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    const again = await as("supt1")("POST", "/api/integrations/sis/import", { schoolId: ID.s2, sourceSystem: "bulk", sourceBatchId: "bulk-2", students: students.slice(0, 10), attendance: attendance.slice(0, 10) });
    assert.equal(again.status, 201);
    const runs = await admin.query("SELECT students_upserted,attendance_imported FROM sis_sync_runs WHERE source_batch_id IN ('bulk-1','bulk-2') ORDER BY source_batch_id");
    assert.deepEqual(runs.rows.map(x => [x.students_upserted, x.attendance_imported]), [[6000, 6000], [10, 0]], "re-imported events are skipped");
    const conflict = await as("supt1")("POST", "/api/integrations/sis/import", { schoolId: ID.s1, sourceSystem: "bulk", sourceBatchId: "bulk-3", students: students.slice(0, 1), attendance: [] });
    assert.equal(conflict.status, 409, "a student owned by another school is not moved");
    const page1 = await as("p2")("GET", "/api/students?limit=500");
    assert.equal(page1.body.data.length, 500); assert.equal(page1.body.page.total, 6001); assert.equal(page1.body.page.nextOffset, 500);
    const last = await as("p2")("GET", "/api/students?limit=1000&offset=6000");
    assert.equal(last.body.data.length, 1); assert.equal(last.body.page.nextOffset, null);
    const search = await as("p2")("GET", "/api/students?q=Bulk%20Student%20599");
    assert.ok(search.body.data.length >= 1 && search.body.data.every(x => x.display_name.includes("Bulk Student 599")));
    assert.equal((await as("p2")("GET", "/api/students?q=%25")).body.data.length, 0, "LIKE wildcards are escaped");
    assert.equal((await as("p1")("GET", "/api/students?q=Bulk")).body.data.length, 0, "search stays within the school");
    const exp = await fetch(`${server.base}/api/audit/export`, { method: "POST", headers: { cookie: s.supt1.cookie, "x-csrf-token": s.supt1.csrf } });
    const csv = await exp.text();
    const total = (await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE district_id=$1", [ID.d1])).rows[0].n;
    assert.equal(csv.trim().split("\r\n").length - 1, total, "the export streams every audit event");
  });
  it("EduOS launches the district's Canvas LMS destination through the approved app catalog", async () => {
    const canvasUrl = "https://district.instructure.com/";
    const reg = await as("it")("POST", "/api/apps", {
      name: "Canvas LMS", vendor: "Instructure", description: "District learning management system",
      category: "Learning Management System", launchUrl: canvasUrl, integrationType: "oidc_sso",
      dataSharingScope: "identity", dpaStatus: "signed", coppaCompliant: true, ferpaSchoolOfficial: true
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const id = reg.body.data.id;
    assert.equal((await as("it")("POST", `/api/apps/${id}/licenses`, {})).status, 201);
    assert.equal((await as("it")("POST", `/api/apps/${id}/assignments`, { scope: "district" })).status, 201);

    const visible = await as("pu")("GET", "/api/my/apps");
    assert.ok(visible.body.data.some(x => x.id === id && x.integrationType === "oidc_sso"));
    const launched = await as("pu")("POST", `/api/apps/${id}/launch`);
    assert.equal(launched.status, 200, JSON.stringify(launched.body));
    assert.deepEqual(launched.body.data, { url: canvasUrl, integrationType: "oidc_sso" });

    const events = await admin.query(
      "SELECT action,detail FROM audit_events WHERE resource_type='app' AND resource_id=$1 AND action='launch'",
      [id]
    );
    assert.equal(events.rowCount, 1);
    assert.equal(JSON.parse(events.rows[0].detail).dataSharingScope, "identity");
  });

});
