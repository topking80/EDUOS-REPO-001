// Behavioural regression tests for the 32.0.53 security/privacy fixes.
// These execute the real modules (no database needed); the database-backed
// paths are covered by test/integration/postgres.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ISSUER = "http://idp.test/tenant";
const baseEnv = {
  DATABASE_URL: "postgresql://eduos_app:s3cret-pw@127.0.0.1:1/eduos",
  PUBLIC_ORIGIN: "http://localhost:8080", OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: "x",
  OIDC_CLIENT_SECRET: "x", OIDC_REDIRECT_URI: "http://localhost:8080/auth/callback"
};
for (const [k, v] of Object.entries(baseEnv)) process.env[k] = v;
delete process.env.EDUOS_DEMO_MODE;

// Load config in a child process with a specific environment.
function loadConfig(env) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    "const {config}=await import('./src/config.js');console.log(JSON.stringify(config))"],
    { cwd: ROOT, env: { PATH: process.env.PATH, ...baseEnv, ...env }, encoding: "utf8" });
  return r.status === 0 ? { config: JSON.parse(r.stdout.trim().split("\n").pop()) } : { error: r.stderr };
}

// ---- Finding 4: guardian email validation actually runs ----
test("guardian email regex accepts ordinary addresses and rejects malformed ones", async () => {
  const { GUARDIAN_EMAIL_RE } = await import("../src/server.js");
  for (const ok of ["parent@example.org", "first.last+kid@school.k12.us", "A@B.CO"])
    assert.ok(GUARDIAN_EMAIL_RE.test(ok), ok);
  for (const bad of ["", "parent", "parent@", "@example.org", "a b@example.org", "parent@example", "parent@@example.org"])
    assert.ok(!GUARDIAN_EMAIL_RE.test(bad), bad);
});

// ---- Finding 17 + 14: JSON errors, app config ----
test("malformed JSON is 400, oversized bodies are 413 and app-config reports demo mode off", async () => {
  const { app } = await import("../src/server.js");
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // The JSON body parser runs before authentication, so no session is needed.
    const post = body => fetch(`${base}/api/audit/export`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const bad = await post("{oops");
    assert.equal(bad.status, 400); assert.equal((await bad.json()).error, "invalid_json");
    const big = await post(JSON.stringify({ x: "y".repeat(2_000_000) }));
    assert.equal(big.status, 413); assert.equal((await big.json()).error, "payload_too_large");
    const cfg = await (await fetch(`${base}/api/app-config`)).json();
    assert.deepEqual(cfg, { demoMode: false });
  } finally { await new Promise(r => server.close(r)); }
});

// ---- Finding 8: OIDC discovery cache poisoning ----
test("OIDC metadata is cached only after issuer validation succeeds", async () => {
  const { getOidcMetadata } = await import("../src/oidc.js");
  const realFetch = globalThis.fetch;
  let issuer = "https://evil.example";
  globalThis.fetch = async () => new Response(JSON.stringify({ issuer, authorization_endpoint: `${ISSUER}/a`, token_endpoint: `${ISSUER}/t`, jwks_uri: `${ISSUER}/k` }), { status: 200 });
  try {
    await assert.rejects(getOidcMetadata(), /issuer mismatch/);
    await assert.rejects(getOidcMetadata(), /issuer mismatch/, "a rejected document must not be served from cache");
    issuer = ISSUER;
    assert.equal((await getOidcMetadata()).issuer, ISSUER);
  } finally { globalThis.fetch = realFetch; }
});

// ---- Finding 9: email_verified / Entra ID ----
test("verified email extraction supports claim, entra and trusted modes", async () => {
  const { verifiedEmailFromClaims } = await import("../src/oidc.js");
  assert.equal(verifiedEmailFromClaims({ email: "P@X.org", email_verified: true }, "claim"), "p@x.org");
  assert.equal(verifiedEmailFromClaims({ email: "p@x.org" }, "claim"), null);
  assert.equal(verifiedEmailFromClaims({ email: "p@x.org", email_verified: false }, "claim"), null);
  assert.equal(verifiedEmailFromClaims({ email: "p@x.org", xms_edov: true }, "claim"), null);
  assert.equal(verifiedEmailFromClaims({ email: "p@x.org", xms_edov: true }, "entra"), "p@x.org");
  assert.equal(verifiedEmailFromClaims({ email: "p@x.org" }, "entra"), null);
  assert.equal(verifiedEmailFromClaims({ email: "p@x.org" }, "trusted"), "p@x.org");
  assert.equal(verifiedEmailFromClaims({ email: "not-an-email", email_verified: true }, "claim"), null);
});

// ---- Finding 16: CSRF token derivation ----
test("CSRF tokens are derived from the session and stable", async () => {
  const { csrfTokenFor } = await import("../src/auth.js");
  assert.equal(csrfTokenFor("abc"), csrfTokenFor("abc"));
  assert.notEqual(csrfTokenFor("abc"), csrfTokenFor("abd"));
  assert.match(csrfTokenFor("abc"), /^[A-Za-z0-9_-]{43}$/);
});

// ---- Finding 20: webhook SSRF IPv6 ranges ----
test("webhook targets block IPv6 transition and deprecated ranges but allow public IPv4", async () => {
  const { isBlockedAddress } = await import("../src/webhooks.js");
  for (const ip of ["2002:7f00:1::1", "2002:a9fe:a9fe::1", "64:ff9b:1::a00:1", "::7f00:1", "::a9fe:a9fe", "::ffff:0:7f00:1", "fec0::1",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "127.0.0.1", "10.1.2.3", "169.254.169.254", "fe80::1", "fc00::1", "::1"])
    assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])
    assert.equal(isBlockedAddress(ip), false, ip);
});

// ---- Findings 1 + 11: configuration guards ----
test("config rejects placeholder database passwords", () => {
  for (const pw of ["change-this", "changeme", "postgres"]) {
    const r = loadConfig({ DATABASE_URL: `postgresql://eduos_app:${pw}@db:5432/eduos` });
    assert.match(r.error || "", /placeholder/i, pw);
  }
  assert.ok(loadConfig({}).config);
});
test("production allows non-TLS only to a private-network database when opted in", () => {
  const prod = { NODE_ENV: "production", PUBLIC_ORIGIN: "https://eduos.example.org", OIDC_REDIRECT_URI: "https://eduos.example.org/auth/callback", OIDC_ISSUER: "https://idp.example.org" };
  assert.ok(loadConfig({ ...prod, DATABASE_URL: "postgresql://eduos_app:pw-123@db:5432/eduos" }).error, "default still requires TLS");
  assert.ok(loadConfig({ ...prod, DATABASE_URL: "postgresql://eduos_app:pw-123@db:5432/eduos", DATABASE_SSL_ALLOW_PRIVATE_NETWORK: "true" }).config);
  assert.ok(loadConfig({ ...prod, DATABASE_URL: "postgresql://eduos_app:pw-123@db.example.com:5432/eduos", DATABASE_SSL_ALLOW_PRIVATE_NETWORK: "true" }).error,
    "a public hostname still requires TLS");
});
test("isPrivateDatabaseHost classifies hosts", async () => {
  const { isPrivateDatabaseHost } = await import("../src/config.js");
  for (const h of ["db", "localhost", "127.0.0.1", "10.0.0.5", "172.30.0.3", "192.168.1.2", "[fd00::1]"]) assert.equal(isPrivateDatabaseHost(h), true, h);
  for (const h of ["db.example.com", "8.8.8.8", "172.32.0.1", "", "[2001:db8::1]"]) assert.equal(isPrivateDatabaseHost(h), false, h);
});

// ---- Finding 21: cookies and session settings ----
test("https origins get a Secure __Host- cookie; demo mode is refused in production", () => {
  const https = loadConfig({ PUBLIC_ORIGIN: "https://eduos.example.org", OIDC_REDIRECT_URI: "https://eduos.example.org/auth/callback" }).config;
  assert.equal(https.cookieName, "__Host-eduos_session"); assert.equal(https.secureCookies, true);
  const local = loadConfig({}).config;
  assert.equal(local.cookieName, "eduos_session"); assert.equal(local.secureCookies, false);
  assert.equal(local.sessionIdleMinutes, 30); assert.equal(local.sessionMaxPerUser, 5);
  assert.ok(loadConfig({ SESSION_COOKIE_NAME: "__Host-x" }).error, "__Host- requires https");
  assert.equal(loadConfig({ EDUOS_DEMO_MODE: "true" }).config.demoMode, true);
  assert.match(loadConfig({ EDUOS_DEMO_MODE: "true", NODE_ENV: "production", PUBLIC_ORIGIN: "https://e.org", OIDC_REDIRECT_URI: "https://e.org/auth/callback", OIDC_ISSUER: "https://idp.example.org", DATABASE_SSL: "true" }).error || "", /demo/i);
});

// ---- Findings 1 + 2: grants rendering ----
test("runtime grants render for a custom role/database and reject unsafe identifiers", async () => {
  const { renderRuntimeGrants } = await import("../src/migrate.js");
  const template = await readFile(new URL("../db/runtime_grants.template.sql", import.meta.url), "utf8");
  const sql = renderRuntimeGrants(template, { appRole: "district_rt", database: "edu_prod" });
  assert.ok(!/\beduos_app\b/.test(sql));
  assert.match(sql, /GRANT CONNECT ON DATABASE edu_prod TO district_rt/);
  for (const table of ["family_messages", "teacher_classroom_preferences", "sis_sync_runs", "sis_attendance_imports", "teacher_student_rosters", "oidc_pending_logins"])
    assert.match(sql, new RegExp(`ON (TABLE )?[^;]*\\b${table}\\b[^;]*TO district_rt`), table);
  assert.match(sql, /GRANT INSERT, UPDATE ON students TO district_rt/);
  assert.match(sql, /GRANT INSERT, UPDATE ON student_user_links TO district_rt/);
  assert.throws(() => renderRuntimeGrants(template, { appRole: "x; DROP TABLE students", database: "eduos" }), /identifier/);
});
// ---- Finding 13: edge enrollment rejects placeholder tokens ----
test("edge enrollment agent rejects placeholder tokens", () => {
  const r = spawnSync("python3", ["edge-platform/eduos/tests/test_enrollment_token.py"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  if (r.error?.code === "ENOENT") return; // python3 not installed
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("edge Butane configs: files-dir-relative paths, compiled base merge, intake installed, no shipped token", async () => {
  const { readdirSync } = await import("node:fs");
  const dir = new URL("../edge-platform/eduos/butane/", import.meta.url);
  for (const f of readdirSync(dir).filter(n => n.endsWith(".bu"))) {
    const bu = await readFile(new URL(f, dir), "utf8");
    assert.doesNotMatch(bu, /local: \.\.\//, f);
    assert.doesNotMatch(bu, /local: base\.bu/, f);
    assert.doesNotMatch(bu, /ENROLL-TOKEN-PLACEHOLDER/, f);
    if (/eduos-enrollment\.service/.test(bu)) {
      assert.match(bu, /local: scripts\/eduos-enrollment\.py/, `${f} installs the intake`);
      assert.match(bu, /contents_local: services\/enrollment\.service/, `${f} installs the unit`);
    }
  }
  // One canonical token path: generated by bootstrap, read by unit, Quadlet and script.
  const edge = p => readFile(new URL(`../edge-platform/eduos/${p}`, import.meta.url), "utf8");
  const canonical = "/run/eduos/enrollment-token";
  assert.ok((await edge("scripts/eduos-bootstrap.sh")).includes(`Path("${canonical}")`));
  assert.ok((await edge("services/enrollment.service")).includes(`EDUOS_ENROLL_TOKEN_FILE=${canonical}`));
  assert.ok((await edge("quadlet/eduos-enrollment.container")).includes(`EDUOS_ENROLL_TOKEN_FILE=${canonical}`));
  assert.ok((await edge("scripts/eduos-enrollment.py")).includes(`"EDUOS_ENROLL_TOKEN_FILE", "${canonical}"`));
});
