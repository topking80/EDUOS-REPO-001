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
import { loadPlatformKey, signJwt } from "../../src/lti.js";
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
    assert.equal((await as("it")("POST", "/api/apps", { name: "Bad LTI", vendor: "x", launchUrl: `${base}/x`, integrationType: "lti13", integrationConfig: { clientId: "c" } })).body.error, "invalid_lti_config");
    assert.equal((await as("it")("POST", "/api/apps", { name: "Secret LTI", vendor: "x", launchUrl: `${base}/x`, integrationType: "link", integrationConfig: { clientSecret: "x" } })).body.error, "integration_config_must_not_hold_secrets");
    await as("it")("POST", `/api/apps/${reg.body.data.id}/licenses`, {});
    await as("it")("POST", `/api/apps/${reg.body.data.id}/assignments`, { scope: "district" });
    const launch = await as("pu")("POST", `/api/apps/${reg.body.data.id}/launch`);
    assert.equal(launch.status, 200, JSON.stringify(launch.body));
    const login1 = await fetch(launch.body.data.url, { redirect: "manual" });
    const authorize = login1.headers.get("location");
    // Executable OIDC negative cases: reject malformed protocol parameters
    // before consuming the valid one-time launch hint.
    for (const [name, value] of [
      ["scope", "openid profile"], ["response_type", "code"], ["response_mode", "query"],
      ["prompt", "login"], ["client_id", "another-client"], ["nonce", ""], ["state", ""],
      ["redirect_uri", "https://evil.example/callback"]
    ]) {
      const invalid = new URL(authorize);
      invalid.searchParams.set(name, value);
      const denied = await fetch(invalid);
      assert.equal(denied.status, 400, `OIDC rejects ${name}=${value}`);
      assert.match(await denied.text(), /LTI launch refused/);
    }
    for (const name of ["scope", "response_type", "response_mode", "nonce", "state", "redirect_uri", "client_id"]) {
      const missing = new URL(authorize);
      missing.searchParams.delete(name);
      assert.equal((await fetch(missing)).status, 400, `OIDC requires ${name}`);
    }
    const page = await fetch(authorize);
    assert.equal(page.status, 200);
    const html = await page.text();
    const token = /name="id_token" value="([^"]+)"/.exec(html)[1];
    assert.match(page.headers.get("content-security-policy"), new RegExp(`form-action ${base.replace(/[.:/]/g, "\\$&")}`));
    const { payload, protectedHeader } = await jwtVerify(token, createRemoteJWKSet(new URL(`${server.base}/.well-known/jwks.json`)), { issuer: "http://localhost", audience: "tool-client" });
    assert.equal(protectedHeader.alg, "RS256"); assert.equal(payload.nonce, "n-1");
    const jwksResponse = await fetch(`${server.base}/.well-known/jwks.json`);
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
    assert.equal((await fetch(authorize)).status, 409, "a launch hint is single-use");
    const evil = new URL(authorize); evil.searchParams.set("redirect_uri", "https://evil.example/steal");
    assert.equal((await fetch(evil)).status, 400);
    const forged = new URL(authorize); forged.searchParams.set("lti_message_hint", forged.searchParams.get("lti_message_hint").replace(/^(.{10})(.)/, (_, a, c) => a + (c === "A" ? "B" : "A")));
    assert.equal((await fetch(forged)).status, 400);

    // Reject OIDC parameter pollution across query and form transports.
    const pollutionLaunch = await as("pu")("POST", `/api/apps/${reg.body.data.id}/launch`);
    assert.equal(pollutionLaunch.status, 200);
    const pollutionInit = await fetch(pollutionLaunch.body.data.url, { redirect: "manual" });
    const pollutionAuthorize = new URL(pollutionInit.headers.get("location"));
    const pollutionForm = new URLSearchParams(pollutionAuthorize.searchParams);
    const polluted = await fetch(`${server.base}/lti/authorize?scope=openid`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: pollutionForm
    });
    assert.equal(polluted.status, 400);
    assert.match(await polluted.text(), /duplicate_request_parameters/);

    // OIDC response_mode=form_post must reject JSON even when the payload
    // contains otherwise valid OIDC parameters.
    const jsonPost = await fetch(`${server.base}/lti/authorize`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(pollutionForm))
    });
    assert.equal(jsonPost.status, 415);
    assert.match(await jsonPost.text(), /unsupported_content_type/);

    // Repeated URL-encoded protocol fields parse as arrays and must fail the
    // scalar OIDC parameter validation rather than selecting one value.
    const duplicateForm = new URLSearchParams(pollutionForm);
    duplicateForm.append("scope", "openid");
    const duplicated = await fetch(`${server.base}/lti/authorize`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: duplicateForm
    });
    assert.equal(duplicated.status, 400);
    assert.match(await duplicated.text(), /invalid_request/);

    // The route-specific URL-encoded parser has a 16KB ceiling. Oversized
    // callback bodies must fail closed before OIDC validation or token issue.
    const oversizedForm = new URLSearchParams(pollutionForm);
    oversizedForm.set("padding", "x".repeat(17 * 1024));
    const oversized = await fetch(`${server.base}/lti/authorize`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: oversizedForm
    });
    const oversizedBody = await oversized.text();
    assert.equal(oversized.status, 413, `oversized LTI form response: ${oversizedBody}`);
    assert.match(oversizedBody, /payload_too_large/);

    // Revocation-window regression tests: each scenario gets a fresh launch
    // hint, then changes authoritative PostgreSQL state before the callback.
    // Restore fixture state in finally so one assertion cannot poison later cases.
    const expectRevokedCallback = async ({ revoke, restore, expected }) => {
      const freshLaunch = await as("pu")("POST", `/api/apps/${reg.body.data.id}/launch`);
      assert.equal(freshLaunch.status, 200, JSON.stringify(freshLaunch.body));
      const initiation = await fetch(freshLaunch.body.data.url, { redirect: "manual" });
      assert.equal(initiation.status, 302);
      const callback = initiation.headers.get("location");
      assert.ok(callback, "tool login initiation must produce an authorization request");
      try {
        await revoke({ launchUrl: freshLaunch.body.data.url });
        const denied = await fetch(callback);
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
});
