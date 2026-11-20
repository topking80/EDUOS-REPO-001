// 32.2.0 unit tests: limits, IT admin role, district resource mesh, LTI 1.3.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { ROLE_PERMISSIONS, canPerform, isDistrictRole, isGrantable } from "../src/policy.js";
import { loadPlatformKey, signJwt, makeHint, readHint, consumeHint, launchClaims, validLtiConfig, pairwiseSub } from "../src/lti.js";
import { FLOW_EVENT_TYPES, serverFlowEvent } from "../src/flow-events.js";

Object.assign(process.env, { DATABASE_URL: process.env.DATABASE_URL || "postgres://u:p@localhost/x", PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN || "http://localhost",
  OIDC_ISSUER: process.env.OIDC_ISSUER || "http://127.0.0.1:9", OIDC_CLIENT_ID: "x", OIDC_CLIENT_SECRET: "x", OIDC_REDIRECT_URI: "http://localhost/auth/callback" });
const read = p => readFile(new URL(`../${p}`, import.meta.url), "utf8");
const pem = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

test("IT admin is district-wide with no student-record permissions", () => {
  const it = { role: "it_admin", districtId: "d", userId: "u" };
  assert.equal(isDistrictRole("it_admin"), true); assert.equal(isDistrictRole("principal"), false);
  for (const [r, a] of [["schools", "create"], ["webhooks", "manage"], ["apps", "manage"], ["apps", "decide"], ["district", "manage"], ["audit", "read"]])
    assert.equal(canPerform(it, r, a), true, `${r}:${a}`);
  for (const r of ["students", "assignments", "attendance", "cases"]) assert.deepEqual(ROLE_PERMISSIONS.it_admin[r], undefined, r);
  assert.equal(canPerform(it, "audit", "export"), false);
});

test("apps permissions follow the role ladder and are not grantable", () => {
  const can = (role, action) => canPerform({ role, districtId: "d", userId: "u" }, "apps", action);
  assert.equal(can("principal", "share"), true); assert.equal(can("principal", "manage"), false); assert.equal(can("principal", "decide"), false);
  assert.equal(can("teacher", "request"), true); assert.equal(can("teacher", "report"), false);
  for (const r of ["parent", "pupil"]) { assert.equal(can(r, "launch"), true); assert.equal(can(r, "read"), false); assert.equal(can(r, "request"), false); }
  for (const a of ["manage", "share", "decide", "launch"]) assert.equal(isGrantable("apps", a), false);
  assert.equal(isGrantable("district", "manage"), false);
});

test("catalog events are server-only, carry ids only, and families never emit", () => {
  for (const t of ["app.registered", "app.licensed", "app.assigned", "app.unassigned", "app.retired", "app.requested", "app.request.decided"]) {
    assert.ok(FLOW_EVENT_TYPES[t], t); assert.equal(FLOW_EVENT_TYPES[t].client, false);
    assert.ok(!FLOW_EVENT_TYPES[t].emitters.some(r => ["parent", "pupil"].includes(r)));
  }
  const e = serverFlowEvent("app.assigned", "it_admin", crypto.randomUUID());
  assert.deepEqual(Object.keys(e.refs), ["resource"]);
  assert.equal(serverFlowEvent("app.assigned", "teacher", crypto.randomUUID()), null);
});

test("pagination clamps limits and reports the next offset", async () => {
  const { pageOf, pageSql, paged } = await import("../src/paging.js");
  assert.deepEqual(pageOf({ query: {} }), { limit: 200, offset: 0 });
  assert.deepEqual(pageOf({ query: { limit: "999999", offset: "40" } }), { limit: 1000, offset: 40 });
  assert.deepEqual(pageOf({ query: { limit: "0", offset: "-5" } }), { limit: 1, offset: 0 });
  assert.deepEqual(pageOf({ query: { limit: "1;DROP", offset: "1e3" } }), { limit: 200, offset: 0 });
  assert.equal(pageSql({ limit: 50, offset: 100 }), "LIMIT 51 OFFSET 100");
  assert.deepEqual(paged([1, 2, 3], { limit: 2, offset: 0 }), { data: [1, 2], page: { limit: 2, offset: 0, nextOffset: 2 } });
  assert.deepEqual(paged([1], { limit: 2, offset: 4 }, { total: 5 }).page, { limit: 2, offset: 4, nextOffset: null, total: 5 });
});

test("config rejects unsafe or contradictory limit settings", async () => {
  const { run } = await import("./integration/harness.js");
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: "postgres://u:p@localhost/x", PUBLIC_ORIGIN: "http://localhost",
    OIDC_ISSUER: "http://127.0.0.1:9", OIDC_CLIENT_ID: "x", OIDC_CLIENT_SECRET: "x", OIDC_REDIRECT_URI: "http://localhost/auth/callback" };
  for (const bad of [{ PAGE_SIZE_MAX: "0" }, { PAGE_SIZE_DEFAULT: "2000", PAGE_SIZE_MAX: "1000" }, { JSON_BODY_LIMIT: "lots" }, { SIS_IMPORT_MAX_MB: "100000" }, { SESSION_MAX_PER_USER: "0" }]) {
    const r = await run(["-e", "import('./src/config.js').then(()=>process.exit(0),e=>{console.error(e.message);process.exit(3)})"], { ...env, ...bad });
    assert.equal(r.code, 3, JSON.stringify(bad) + r.out);
  }
  const ok = await run(["-e", "import('./src/config.js').then(m=>{console.log(JSON.stringify([m.config.sisImportMaxBytes,m.config.guardianInviteRateLimit,m.config.webhookMaxInFlight]));process.exit(0)})"], env);
  assert.equal(ok.code, 0, ok.out); assert.deepEqual(JSON.parse(ok.out), [50 * 1024 * 1024, 1000, 16]);
});

test("LTI: JWKS, RS256 signature, scope-limited claims and pairwise subject", () => {
  const key = loadPlatformKey(pem);
  assert.equal(key.jwks.keys.length, 1); assert.ok(!("d" in key.jwks.keys[0]), "JWKS never exposes the private exponent");
  const app = { id: crypto.randomUUID(), launch_url: "https://tool/launch", data_sharing_scope: "none", integration_config: { clientId: "c1", deploymentId: "dep" } };
  const user = { id: crypto.randomUUID(), display_name: "Pupil A", email: "a@x" };
  const school = { id: crypto.randomUUID(), name: "S1" };
  const base = { key, issuer: "https://eduos", launch: { role: "pupil", districtId: "d" }, user, school, nonce: "n" };
  const none = launchClaims({ ...base, app });
  assert.ok(!none.name && !none.email && !none["https://purl.imsglobal.org/spec/lti/claim/context"]);
  assert.equal(none.sub, pairwiseSub(key, app.id, user.id)); assert.notEqual(none.sub, user.id);
  assert.notEqual(pairwiseSub(key, crypto.randomUUID(), user.id), none.sub, "subjects differ between apps");
  const ident = launchClaims({ ...base, app: { ...app, data_sharing_scope: "identity" } });
  assert.equal(ident.name, "Pupil A"); assert.ok(!ident["https://purl.imsglobal.org/spec/lti/claim/context"]);
  const roster = launchClaims({ ...base, app: { ...app, data_sharing_scope: "roster_full" } });
  assert.ok(!roster["https://purl.imsglobal.org/spec/lti/claim/context"]);
  for (const scope of ["roster_basic", "roster_full", "grades", "attendance", "unknown"]) {
    const claims = launchClaims({ ...base, app: { ...app, data_sharing_scope: scope } });
    assert.ok(!claims.name && !claims.email && !claims["https://purl.imsglobal.org/spec/lti/claim/context"], scope);
  }
  const jwt = signJwt(key, none);
  const [h, b, sig] = jwt.split(".");
  const pub = crypto.createPublicKey({ key: key.jwks.keys[0], format: "jwk" });
  assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${b}`), pub, Buffer.from(sig, "base64url")));
  assert.equal(JSON.parse(Buffer.from(h, "base64url")).kid, key.kid);
});

test("LTI: hints are signed, expire, and are single-use; configs are validated", () => {
  const key = loadPlatformKey(pem);
  const hint = makeHint(key, { l: "launch-1", u: "u" }, 1000);
  assert.equal(readHint(key, hint, 2000).l, "launch-1");
  assert.equal(readHint(key, hint, 1000 + 5 * 60_000 + 1), null, "expired");
  const [body, mac] = hint.split(".");
  const tampered = Buffer.from(JSON.stringify({ l: "launch-2", u: "u", exp: 9e15 })).toString("base64url");
  assert.equal(readHint(key, `${tampered}.${mac}`, 2000), null);
  assert.equal(readHint(loadPlatformKey(crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" })), hint, 2000), null, "other platform key");
  assert.equal(readHint(key, body, 2000), null);
  const id = crypto.randomUUID();
  assert.equal(consumeHint(id), true); assert.equal(consumeHint(id), false);
  assert.equal(validLtiConfig({ clientId: "c", deploymentId: "d", loginUrl: "https://t/login", redirectUris: ["https://t/launch"], targetLinkUri: "https://t/launch" }), true);
  assert.equal(validLtiConfig({ clientId: "c", deploymentId: "d", loginUrl: "javascript:alert(1)", redirectUris: ["https://t/launch"], targetLinkUri: "https://t/launch" }), false);
  assert.equal(validLtiConfig({ clientId: "c", deploymentId: "d", loginUrl: "https://t/login", redirectUris: [], targetLinkUri: "https://t/launch" }), false);
  assert.throws(() => loadPlatformKey(crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" })));
});

test("grade parsing and COPPA threshold", async () => {
  const { gradeNumber, COPPA_MAX_GRADE, YOUNG_LEARNER_MAX_GRADE } = await import("../src/mesh-routes.js");
  assert.deepEqual(["PK", "K", "tk", "3", "12", "college", null].map(gradeNumber), [-1, 0, 0, 3, 12, null, null]);
  assert.equal(COPPA_MAX_GRADE, 7); assert.ok(YOUNG_LEARNER_MAX_GRADE < COPPA_MAX_GRADE);
});

test("migration 010: every mesh table is tenant-isolated with FORCE RLS; usage rows are restricted", async () => {
  const sql = await read("db/010_district_resource_mesh.sql");
  const migrate = await read("src/migrate.js");
  assert.ok(migrate.includes('"010_district_resource_mesh.sql"'));
  for (const t of ["district_settings", "apps", "app_licenses", "app_assignments", "app_requests", "app_seats", "app_launches"]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${t} \\(`)); assert.ok(sql.includes(`'${t}'`), t);
  }
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  for (const t of ["app_launches", "app_seats", "app_requests"]) assert.match(sql, new RegExp(`CREATE POLICY own_scope ON ${t} AS RESTRICTIVE`));
  assert.match(sql, /CREATE FUNCTION eduos_claim_seat\(p_license uuid\)[\s\S]*SECURITY DEFINER/);
  assert.match(sql, /memberships_school_scope_check[\s\S]*'superintendent','it_admin'\) AND school_id IS NULL/);
  const grants = await read("db/runtime_grants.template.sql");
  assert.match(grants, /REVOKE INSERT, UPDATE ON app_seats FROM eduos_app/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION eduos_claim_seat\(uuid\), eduos_app_usage\(uuid\) TO eduos_app/);
});

test("limits: list endpoints are paged, product caps are gone, security limits stay", async () => {
  const server = await read("src/server.js");
  assert.ok(!/MAX_ACTIVE_WEBHOOKS/.test(server)); assert.ok(!/students\.length>5000/.test(server)); assert.ok(!/LIMIT 5000/.test(server));
  assert.ok(!/webhooksInFlight>=MAX_WEBHOOKS_IN_FLIGHT\)\{console\.warn\("Webhook delivery skipped/.test(server), "deliveries queue instead of being dropped");
  for (const route of ["/api/students", "/api/attendance", "/api/cases", "/api/assignments", "/api/audit", "/api/rosters", "/api/flow-events", "/api/webhooks", "/api/access-requests", "/api/guardian-invitations"]) {
    const start = server.indexOf(`app.get("${route}",`); assert.ok(start > 0, route);
    assert.ok(server.slice(start, start + 2500).includes("pageSql(pgn)"), route);
  }
  for (const k of ["config.loginRateLimit", "config.guardianInviteRateLimit", "config.guardianAcceptRateLimit", "config.flowEventRateLimit", "config.webhookAdminRateLimit", "config.jsonBodyLimit", "config.sisImportMaxBytes"])
    assert.ok(server.includes(k), k);
  assert.match(server, /app\.post\("\/api\/integrations\/sis\/import",requireSession,requireCsrf,requirePermission\("schools","update"\),bulkJson,/, "large bodies are parsed only after auth");
  const docs = await read("docs/LIMITS.md");
  for (const k of ["PAGE_SIZE_MAX", "SIS_IMPORT_MAX_MB", "LOGIN_RATE_LIMIT_PER_15M", "max_active_webhooks", "SESSION_MAX_PER_USER"]) assert.ok(docs.includes(k), k);
});
