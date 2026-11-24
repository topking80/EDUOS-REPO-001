// Device sign-in (RFC 8628) for TVs, Roku and the Windows app, end to end
// against real PostgreSQL: a screen asks for a code, a signed-in person
// approves it, the screen polls and gets a bearer session. TV and Roku
// sessions are read-only; a device session can't approve another device.
// Run: EDUOS_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres npm run test:integration
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("device sign-in (RFC 8628)", { skip }, () => {
  let db, idp, server, admin;

  const post = (path, body, headers = {}) => fetch(`${server.base}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null), cache: r.headers.get("cache-control") }));
  const startCode = (clientKind = "android_tv", deviceLabel = "Living room") => post("/auth/device/code", { clientKind, deviceLabel });
  const poll = deviceCode => post("/auth/device/token", { deviceCode });
  const bearer = (token, csrf) => async (method, path, body) => {
    const headers = { authorization: `Bearer ${token}` };
    if (csrf) headers["x-csrf-token"] = csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(`${server.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json ?? text };
  };
  // Polls are limited to one per interval; tests skip the wait by ageing the last poll.
  const agePolls = () => admin.query("UPDATE device_sign_in_requests SET last_polled_at = now() - interval '1 minute' WHERE last_polled_at IS NOT NULL");

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, DEVICE_SIGN_IN_ENABLED: "true" });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop?.(); });

  it("signs a TV in after a signed-in parent approves its code, and the TV session is read-only", async () => {
    const start = await startCode();
    assert.equal(start.status, 200, JSON.stringify(start.body));
    assert.match(start.cache, /no-store/);
    assert.match(start.body.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    assert.match(start.body.verificationUri, /\/device\/$/);
    assert.equal(start.body.verificationUriComplete, `${start.body.verificationUri}#${start.body.userCode}`);
    assert.ok(Array.isArray(start.body.qr) && start.body.qr.length >= 21 && start.body.qr.every(r => /^[01]+$/.test(r) && r.length === start.body.qr.length), "square QR module rows");
    assert.equal(start.body.expiresIn, 600); assert.equal(start.body.interval, 5);
    // Only hashes are stored.
    const stored = (await admin.query("SELECT device_code_hash, user_code_hash, client_kind, device_label, status FROM device_sign_in_requests")).rows;
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0].device_code_hash, start.body.deviceCode);
    assert.deepEqual([stored[0].client_kind, stored[0].device_label, stored[0].status], ["android_tv", "Living room", "pending"]);

    assert.deepEqual(await poll(start.body.deviceCode).then(r => [r.status, r.body.error]), [400, "authorization_pending"]);
    assert.deepEqual(await poll(start.body.deviceCode).then(r => [r.status, r.body.error]), [400, "slow_down"], "polling faster than the interval");

    const parent = await login(server.base, idp, "pa", { email_verified: true });
    const web = client(server.base, parent);
    const check = await web("POST", "/api/device-sign-in/check", { userCode: start.body.userCode.toLowerCase().replace("-", " ") });
    assert.equal(check.status, 200, JSON.stringify(check.body));
    assert.deepEqual([check.body.data.clientKind, check.body.data.deviceLabel, check.body.data.readOnly], ["android_tv", "Living room", true]);
    const approved = await web("POST", "/api/device-sign-in/approve", { userCode: start.body.userCode });
    assert.equal(approved.status, 200); assert.equal(approved.body.data.status, "approved");
    assert.equal((await web("POST", "/api/device-sign-in/approve", { userCode: start.body.userCode })).status, 404, "approve once");

    await agePolls();
    const tok = await poll(start.body.deviceCode);
    assert.equal(tok.status, 200, JSON.stringify(tok.body));
    assert.equal(tok.body.tokenType, "Bearer"); assert.equal(tok.body.role, "parent");
    assert.equal(tok.body.clientKind, "android_tv"); assert.equal(tok.body.readOnly, true);
    assert.match(tok.cache, /no-store/);
    assert.equal((await poll(start.body.deviceCode)).body.error, "invalid_grant", "single use");
    assert.equal((await admin.query("SELECT client_kind FROM sessions WHERE user_id=$1 AND client_kind IS NOT NULL", [USERS.pa[0]])).rows[0].client_kind, "android_tv");

    const audit = (await admin.query("SELECT action, actor_user_id, detail FROM audit_events WHERE resource_type='device_sign_in' ORDER BY occurred_at")).rows;
    assert.deepEqual(audit.map(a => [a.action, a.actor_user_id, a.detail]),
      [["approve", USERS.pa[0], "client_kind=android_tv"], ["session_created", USERS.pa[0], "client_kind=android_tv"]], "approval and redemption are audited");
    const tv = bearer(tok.body.sessionToken, tok.body.csrfToken);
    const me = await tv("GET", "/api/me");
    assert.equal(me.status, 200); assert.equal(me.body.userId, USERS.pa[0]);
    assert.equal((await tv("GET", "/api/family/children")).status, 200, "reads work");
    const write = await tv("POST", "/api/family/messages", { body: "hello" });
    assert.deepEqual([write.status, write.body.error], [403, "device_session_read_only"]);
    // A device can't approve another device, even a Windows one.
    const other = await startCode("windows", "Study PC");
    assert.equal((await tv("POST", "/api/device-sign-in/approve", { userCode: other.body.userCode })).status, 403);
    assert.equal((await tv("POST", "/auth/logout")).status, 204, "a TV can always sign out");
    assert.equal((await tv("GET", "/api/me")).status, 401);
  });

  it("a Windows sign-in is a full session but still can't approve devices", async () => {
    const start = await startCode("windows", "Study PC");
    const teacher = client(server.base, await login(server.base, idp, "t1", { email_verified: true }));
    assert.equal((await teacher("POST", "/api/device-sign-in/approve", { userCode: start.body.userCode })).status, 200);
    await agePolls();
    const tok = await poll(start.body.deviceCode);
    assert.equal(tok.status, 200); assert.equal(tok.body.readOnly, false); assert.equal(tok.body.role, "teacher");
    const pc = bearer(tok.body.sessionToken, tok.body.csrfToken);
    const tv = await startCode("roku");
    const refused = await pc("POST", "/api/device-sign-in/approve", { userCode: tv.body.userCode });
    assert.deepEqual([refused.status, refused.body.error], [403, "device_session_cannot_approve"]);
  });

  it("a TV session keeps its read-only kind when switching role", async () => {
    const start = await startCode("fire_tv");
    const tp = client(server.base, await login(server.base, idp, "tp", { email_verified: true }));
    assert.equal((await tp("POST", "/api/device-sign-in/approve", { userCode: start.body.userCode })).status, 200);
    await agePolls();
    const tok = (await poll(start.body.deviceCode)).body;
    const tv = bearer(tok.sessionToken, tok.csrfToken);
    const memberships = (await tv("GET", "/api/memberships")).body.data;
    const parentRole = memberships.find(m => m.role === "parent");
    const switched = await tv("POST", "/api/session/membership", { membershipId: parentRole.id });
    assert.equal(switched.status, 200, JSON.stringify(switched.body)); assert.equal(switched.body.role, "parent");
    const after = bearer(switched.body.sessionToken, switched.body.csrfToken);
    assert.equal((await after("POST", "/api/family/messages", { body: "x" })).body.error, "device_session_read_only");
  });

  it("refuses denied, expired, unknown and malformed codes", async () => {
    const parent = client(server.base, await login(server.base, idp, "pb", { email_verified: true }));
    const denied = await startCode();
    assert.equal((await parent("POST", "/api/device-sign-in/deny", { userCode: denied.body.userCode })).status, 200);
    assert.equal((await poll(denied.body.deviceCode)).body.error, "access_denied");
    assert.equal((await poll(denied.body.deviceCode)).body.error, "invalid_grant", "gone after the denial is reported");

    const expired = await startCode();
    await admin.query("UPDATE device_sign_in_requests SET expires_at = now() - interval '1 second' WHERE status='pending'");
    assert.equal((await parent("POST", "/api/device-sign-in/approve", { userCode: expired.body.userCode })).status, 404);
    assert.equal((await poll(expired.body.deviceCode)).body.error, "expired_token");

    for (const userCode of ["", "AAAA-AAAA", "BCDF", 12345678, "BCDF-GHJK-LMNP"])
      assert.deepEqual(await parent("POST", "/api/device-sign-in/approve", { userCode }).then(r => [r.status, r.body.error]), [400, "invalid_user_code"], String(userCode));
    assert.equal((await parent("POST", "/api/device-sign-in/check", { userCode: "BCDF-GHJK" })).status, 404);
    for (const body of [{}, { deviceCode: "x" }, { deviceCode: "y".repeat(300) }])
      assert.equal((await post("/auth/device/token", body)).body.error, "invalid_request");
    assert.equal((await poll("z".repeat(43))).body.error, "invalid_grant");
    for (const body of [{}, { clientKind: "smart_fridge" }, { clientKind: "roku", deviceLabel: 5 }])
      assert.equal((await post("/auth/device/code", body)).status, 400, JSON.stringify(body));
    // Approving needs a session and the CSRF token.
    assert.equal((await post("/api/device-sign-in/approve", { userCode: "BCDF-GHJK" })).status, 401);
  });

  it("re-checks the approving membership when the device redeems", async () => {
    const start = await startCode("roku");
    const parent = client(server.base, await login(server.base, idp, "pb", { email_verified: true }));
    assert.equal((await parent("POST", "/api/device-sign-in/approve", { userCode: start.body.userCode })).status, 200);
    await admin.query("UPDATE memberships SET status='disabled' WHERE user_id=$1", [USERS.pb[0]]);
    try {
      await agePolls();
      assert.deepEqual(await poll(start.body.deviceCode).then(r => [r.status, r.body.error]), [403, "account_not_active"]);
    } finally { await admin.query("UPDATE memberships SET status='active' WHERE user_id=$1", [USERS.pb[0]]); }
  });
});

describe("device sign-in is off by default", { skip }, () => {
  let db, idp, server;
  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    assert.equal((await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl })).code, 0);
    await seed(db.adminUrl, idp.issuer);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
  });
  after(async () => { await server?.stop(); await idp?.close(); await db?.drop?.(); });
  it("answers 404 until DEVICE_SIGN_IN_ENABLED=true", async () => {
    for (const path of ["/auth/device/code", "/auth/device/token"]) {
      const r = await fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientKind: "roku", deviceCode: "x".repeat(43) }) });
      assert.equal(r.status, 404, path); assert.equal((await r.json()).error, "device_sign_in_disabled");
    }
  });
});
