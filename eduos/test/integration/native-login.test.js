// Native mobile app sign-in (RFC 8252) end to end against real PostgreSQL:
// system-browser OIDC -> app redirect with a single-use code -> PKCE-bound
// exchange -> bearer session. Also covers the refusals that make it safe.
// Run: EDUOS_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres npm run test:integration
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { PG_URL, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const APP_REDIRECT = "org.eduos.app:/oauth2redirect";

const pkce = () => {
  const verifier = crypto.randomBytes(48).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
};
const pickCookie = (res, prefix) => (res.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).find(c => c.startsWith(prefix));

describe("native app sign-in (RFC 8252)", { skip }, () => {
  let db, idp, server, admin;

  // Drive the system-browser half: /auth/login -> IdP -> /auth/callback.
  async function browserSignIn(sub, { challenge, redirect = APP_REDIRECT, extra = "" } = {}) {
    const q = new URLSearchParams({ next: "native", app_challenge: challenge, app_redirect: redirect });
    const start = await fetch(`${server.base}/auth/login?${q}${extra}`, { redirect: "manual" });
    if (start.status !== 302) return { status: start.status, text: await start.text() };
    const loc = new URL(start.headers.get("location"));
    const state = loc.searchParams.get("state"), nonce = loc.searchParams.get("nonce");
    const code = crypto.randomBytes(12).toString("hex");
    idp.codes.set(code, { sub, nonce, email: USERS[sub]?.[2], email_verified: true });
    const cb = await fetch(`${server.base}/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: pickCookie(start, "eduos_oidc_state_") } });
    return { status: cb.status, location: cb.headers.get("location"), setCookie: cb.headers.getSetCookie?.() || [], cache: cb.headers.get("cache-control") };
  }
  const exchange = body => fetch(`${server.base}/auth/native/token`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json(), cache: r.headers.get("cache-control") }));
  const bearer = (token, csrf) => async (method, path, body) => {
    const headers = { authorization: `Bearer ${token}` };
    if (csrf) headers["x-csrf-token"] = csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(`${server.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json ?? text };
  };

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, NATIVE_APP_REDIRECT_URIS: `${APP_REDIRECT}, https://app.example.test/cb` });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop?.(); });

  it("signs in through the system browser and returns a bearer session to the app", async () => {
    const { verifier, challenge } = pkce();
    const cb = await browserSignIn("pa", { challenge });
    assert.equal(cb.status, 303);
    const back = new URL(cb.location);
    assert.equal(`${back.protocol}${back.pathname}`, APP_REDIRECT);
    const code = back.searchParams.get("code");
    assert.match(code, /^[A-Za-z0-9_-]{40,}$/);
    assert.ok(!cb.setCookie.some(c => c.startsWith("eduos_session=") && !/Max-Age=0/i.test(c)), "no browser session is created");
    assert.match(cb.cache, /no-store/);
    // Nothing secret is stored: only a hash of the code, and no session yet.
    const stored = (await admin.query("SELECT code_hash, user_id FROM native_login_handoffs")).rows;
    assert.equal(stored.length, 1); assert.notEqual(stored[0].code_hash, code); assert.equal(stored[0].user_id, USERS.pa[0]);

    const tok = await exchange({ code, code_verifier: verifier });
    assert.equal(tok.status, 200, JSON.stringify(tok.body));
    assert.equal(tok.body.tokenType, "Bearer"); assert.equal(tok.body.role, "parent");
    assert.match(tok.cache, /no-store/);
    assert.ok(Date.parse(tok.body.expiresAt) > Date.now());

    const api = bearer(tok.body.sessionToken, tok.body.csrfToken);
    const me = await api("GET", "/api/me");
    assert.equal(me.status, 200); assert.equal(me.body.userId, USERS.pa[0]); assert.equal(me.body.role, "parent");
    assert.equal((await api("GET", "/api/csrf")).body.csrfToken, tok.body.csrfToken);

    // Writes still need the CSRF token, exactly like browser sessions.
    assert.equal((await bearer(tok.body.sessionToken)("POST", "/auth/logout")).status, 403);
    assert.equal((await api("POST", "/auth/logout")).status, 204);
    assert.equal((await api("GET", "/api/me")).status, 401, "logout revokes the bearer session");
  });

  it("a handoff code is single-use, short-lived and bound to the app's PKCE verifier", async () => {
    const a = pkce(), b = pkce();
    const code = new URL((await browserSignIn("pa", { challenge: a.challenge })).location).searchParams.get("code");
    assert.deepEqual(await exchange({ code, code_verifier: b.verifier }).then(r => [r.status, r.body.error]), [400, "invalid_grant"], "wrong verifier");
    assert.deepEqual(await exchange({ code, code_verifier: a.verifier }).then(r => [r.status, r.body.error]), [400, "invalid_grant"], "the failed attempt consumed it");

    const c = pkce();
    const code2 = new URL((await browserSignIn("pa", { challenge: c.challenge })).location).searchParams.get("code");
    assert.equal((await exchange({ code: code2, code_verifier: c.verifier })).status, 200);
    assert.equal((await exchange({ code: code2, code_verifier: c.verifier })).status, 400, "replay");

    const d = pkce();
    const code3 = new URL((await browserSignIn("pa", { challenge: d.challenge })).location).searchParams.get("code");
    await admin.query("UPDATE native_login_handoffs SET expires_at = now() - interval '1 second'");
    assert.equal((await exchange({ code: code3, code_verifier: d.verifier })).status, 400, "expired");

    for (const body of [{}, { code: "x" }, { code: "x", code_verifier: "short" }, { code: "x".repeat(200), code_verifier: d.verifier }])
      assert.equal((await exchange(body)).status, 400, JSON.stringify(body));
  });

  it("refuses unregistered redirects, bad challenges and plain challenges", async () => {
    const { challenge } = pkce();
    for (const redirect of ["org.eduos.evil:/oauth2redirect", "org.eduos.app:/oauth2redirect/x", "https://app.example.test/cb?x=1", "http://localhost/app/"]) {
      const r = await browserSignIn("pa", { challenge, redirect });
      assert.equal(r.status, 400, redirect); assert.match(r.text, /not registered/);
    }
    assert.match((await browserSignIn("pa", { challenge: "too-short" })).text, /Invalid app challenge/);
    assert.match((await browserSignIn("pa", { challenge, extra: "&app_challenge_method=plain" })).text, /Only S256/);
    // The second registered redirect works too (https app link).
    const ok = await browserSignIn("pa", { challenge, redirect: "https://app.example.test/cb" });
    assert.equal(ok.status, 303); assert.ok(ok.location.startsWith("https://app.example.test/cb?code="));
  });

  it("re-checks the account at redemption", async () => {
    const { verifier, challenge } = pkce();
    const code = new URL((await browserSignIn("pb", { challenge })).location).searchParams.get("code");
    await admin.query("UPDATE memberships SET status='disabled' WHERE user_id=$1", [USERS.pb[0]]);
    try {
      assert.deepEqual(await exchange({ code, code_verifier: verifier }).then(r => [r.status, r.body.error]), [403, "account_not_active"]);
    } finally { await admin.query("UPDATE memberships SET status='active' WHERE user_id=$1", [USERS.pb[0]]); }
  });

  it("browser sign-in is unchanged, and a cookie always wins over a bearer header", async () => {
    const web = await login(server.base, idp, "pa", { email_verified: true });
    assert.equal(web.status, 303); assert.ok(web.cookie);
    const { verifier, challenge } = pkce();
    const tok = (await exchange({ code: new URL((await browserSignIn("tp", { challenge })).location).searchParams.get("code"), code_verifier: verifier })).body;
    const r = await fetch(`${server.base}/api/me`, { headers: { cookie: web.cookie, authorization: `Bearer ${tok.sessionToken}` } });
    assert.equal((await r.json()).userId, USERS.pa[0]);
    assert.equal((await bearer("not-a-real-session-token-000000")("GET", "/api/me")).status, 401);
    assert.equal((await fetch(`${server.base}/api/me`, { headers: { authorization: "Basic abc" } })).status, 401);
  });

  it("switching membership hands a bearer client its replacement token (and only then)", async () => {
    const { verifier, challenge } = pkce();
    const tok = (await exchange({ code: new URL((await browserSignIn("tp", { challenge })).location).searchParams.get("code"), code_verifier: verifier })).body;
    const api = bearer(tok.sessionToken, tok.csrfToken);
    const memberships = (await api("GET", "/api/memberships")).body.data;
    const parentRole = memberships.find(m => m.role === "parent");
    const sw = await api("POST", "/api/session/membership", { membershipId: parentRole.id });
    assert.equal(sw.status, 200, JSON.stringify(sw.body));
    assert.equal(sw.body.role, "parent"); assert.ok(sw.body.sessionToken);
    assert.equal((await api("GET", "/api/me")).status, 401, "old token revoked");
    assert.equal((await bearer(sw.body.sessionToken, sw.body.csrfToken)("GET", "/api/me")).body.role, "parent");

    const web = await login(server.base, idp, "tp", { email_verified: true });
    const webMemberships = await fetch(`${server.base}/api/memberships`, { headers: { cookie: web.cookie } }).then(r => r.json());
    const target = webMemberships.data.find(m => m.role === "parent");
    const webSwitch = await fetch(`${server.base}/api/session/membership`, { method: "POST",
      headers: { cookie: web.cookie, "x-csrf-token": web.csrf, "content-type": "application/json" }, body: JSON.stringify({ membershipId: target.id }) }).then(r => r.json());
    assert.equal(webSwitch.sessionToken, undefined, "browsers never see the session token in a response body");
  });
});

describe("native app sign-in disabled by default", { skip }, () => {
  let db, idp, server;
  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    assert.equal((await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl })).code, 0);
    await seed(db.adminUrl, idp.issuer);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
  });
  after(async () => { await server?.stop(); await idp?.close(); await db?.drop?.(); });

  it("rejects native sign-in and token exchange when NATIVE_APP_REDIRECT_URIS is unset", async () => {
    const { challenge } = pkce();
    const r = await fetch(`${server.base}/auth/login?next=native&app_challenge=${challenge}&app_redirect=${encodeURIComponent(APP_REDIRECT)}`, { redirect: "manual" });
    assert.equal(r.status, 400); assert.match(await r.text(), /not enabled/);
    const t = await fetch(`${server.base}/auth/native/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(t.status, 404);
  });
});
