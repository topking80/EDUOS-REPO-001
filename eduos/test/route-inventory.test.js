// SEC-05 (docs/API-ROUTE-INVENTORY.md): every route of the EduOS app either
// requires a signed-in session or is listed below with why it is reachable
// without one, how the caller is checked instead, its rate limit and its
// caching. The inventory is read from Express's router in each node tier, so
// a new route without a session fails here until it is reviewed and listed.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dump = fileURLToPath(new URL("./fixtures/route-inventory-dump.mjs", import.meta.url));
const TIERS = ["", "district", "school"];
const inventories = Object.fromEntries(TIERS.map(tier => [tier, JSON.parse(execFileSync(process.execPath, [dump], {
  env: { ...process.env, EDUOS_NODE_TIER: tier, NODE_ENV: "test" }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }))]));

// How a caller without a session is checked. `guard` must appear in the
// route's chain; `source` must appear in the final handler, before its first
// database call (so an unchecked caller never reaches the data).
const CHECKS = {
  "public": {},                                                         // anyone, by design
  "sign-in": {},                                                        // OIDC / device sign-in itself (src/auth.js, src/device-sign-in.js)
  "device-key": { source: /device_key_required/ },                      // classroom agent's device key
  "edge-device-token": { source: /device_token_required/ },             // edge device token
  "association-key": { source: /status\(401\)/ },                       // association attestation API key
  "eden-node-signature": { guard: "nodeAuth" },                         // EDEN node's Ed25519 signature
  "eden-enrollment-token": { source: /proof_of_possession_failed/ },    // one-time enrollment token + key proof
  "commerce-webhook": { source: /receiveCommerceWebhook/ },             // per-processor secret path + signature
  "wallet-capability": { source: /not_found/ },                         // unguessable share token in the path
  "lti-signed-launch": { source: /readHint|ltiAuthorize/ },             // signed launch hint + binding cookie
  "lti-deep-link-jwt": { source: /JWT/ },                               // tool-signed deep-link JWT
  "lti-client-assertion": { source: /client_assertion/ },               // OAuth client-credentials JWT
  "lti-service-token": { source: /serviceToken\(req/ },                 // LTI service bearer token
  "metrics-token": { source: /metrics_token_required/ },                // Prometheus bearer token
};

// limit: "route" = its own limiter on top of the prefix ceiling;
//        "prefix" = the /api, /auth or /lti ceiling only; "none" = an ops probe.
// cache: "no-store" (the default under /api, /auth and /lti), "no-cache" (revalidated) or "public" (sets its own max-age).
const PUBLIC = {
  "GET /health": { why: "load-balancer probe; answers ok or unavailable only", check: "public", limit: "none", cache: "no-store" },
  "GET /metrics": { why: "Prometheus scrape", check: "metrics-token", limit: "none", cache: "no-store" },
  "GET /.well-known/jwks.json": { why: "LTI public keys tools verify launches with", check: "public", limit: "none", cache: "public" },
  "GET /^\\/app(\\/.*)?$/": { why: "the web app's HTML shell; holds no data", check: "public", limit: "none", cache: "no-cache" },
  "GET /auth/login": { why: "starts sign-in", check: "sign-in", limit: "route", cache: "no-store" },
  "GET /auth/callback": { why: "finishes sign-in", check: "sign-in", limit: "route", cache: "no-store" },
  "POST /auth/native/token": { why: "mobile app's PKCE code exchange", check: "sign-in", limit: "route", cache: "no-store" },
  "POST /auth/device/code": { why: "TV / Roku / Windows sign-in start", check: "sign-in", limit: "route", cache: "no-store" },
  "POST /auth/device/token": { why: "device sign-in polling", check: "sign-in", limit: "route", cache: "no-store" },
  "GET /api/app-config": { why: "whether demo mode is on; read before sign-in", check: "public", limit: "prefix", cache: "no-store" },
  "POST /api/commerce/webhooks/:processor/:token": { why: "payment processor callbacks", check: "commerce-webhook", limit: "route", cache: "no-store" },
  "GET /api/public/branding/:districtId/:schoolId": { why: "school name and colours for the sign-in page", check: "public", limit: "route", cache: "public" },
  "GET /api/public/branding/:districtId/:schoolId/icon-:size.png": { why: "home-screen icon", check: "public", limit: "route", cache: "public" },
  "GET /api/public/branding/:districtId/:schoolId/manifest.webmanifest": { why: "installable web app manifest", check: "public", limit: "route", cache: "public" },
  "POST /api/classroom-agent/code": { why: "classroom device asks for a pairing code", check: "device-key", limit: "route", cache: "no-store" },
  "POST /api/classroom-agent/commands": { why: "classroom device collects teacher commands", check: "device-key", limit: "route", cache: "no-store" },
  "POST /api/classroom-agent/safety": { why: "classroom device checks safety state", check: "device-key", limit: "route", cache: "no-store" },
  "POST /api/classroom-agent/commands/:id/result": { why: "classroom device reports a command result", check: "device-key", limit: "route", cache: "no-store" },
  "POST /api/classroom-agent/checkin-code": { why: "room kiosk shows a check-in code", check: "device-key", limit: "route", cache: "no-store" },
  "POST /api/classroom-agent/kiosk-checkin": { why: "room kiosk records a check-in", check: "device-key", limit: "route", cache: "no-store" },
  "GET /api/association/attestations": { why: "athletic association reads attestations it was sent", check: "association-key", limit: "route", cache: "no-store" },
  "GET /api/association/attestations/:id": { why: "athletic association reads one attestation", check: "association-key", limit: "route", cache: "no-store" },
  "GET /api/public/wallet/:districtId/:token": { why: "a credential holder's share link", check: "wallet-capability", limit: "route", cache: "no-store" },
  "POST /api/public/wallet/verify": { why: "anyone may verify a signed credential", check: "public", limit: "route", cache: "no-store" },
  "POST /api/edge/health": { why: "edge device health report", check: "edge-device-token", limit: "route", cache: "no-store" },
  "GET /api/edge/update-target": { why: "edge device asks which release to run", check: "edge-device-token", limit: "route", cache: "no-store" },
  "GET /lti/authorize": { why: "LTI 1.3 OIDC launch from a tool", check: "lti-signed-launch", limit: "prefix", cache: "no-store" },
  "POST /lti/authorize": { why: "LTI 1.3 OIDC launch (form post)", check: "lti-signed-launch", limit: "prefix", cache: "no-store" },
  "POST /lti/deep-link/return": { why: "tool returns chosen content", check: "lti-deep-link-jwt", limit: "prefix", cache: "no-store" },
  "POST /lti/token/:districtId/:appId": { why: "tool gets a service token", check: "lti-client-assertion", limit: "route", cache: "no-store" },
  "GET /lti/nrps/:sharingId/memberships": { why: "tool reads a class list a teacher shared", check: "lti-service-token", limit: "route", cache: "no-store" },
  "GET /lti/ags/:linkId/lineitem": { why: "tool reads a grade column", check: "lti-service-token", limit: "route", cache: "no-store" },
  "POST /lti/ags/:linkId/lineitem/scores": { why: "tool posts a score (held for teacher review)", check: "lti-service-token", limit: "route", cache: "no-store" },
  // District hub tier only (EDUOS_NODE_TIER=district).
  "POST /api/eden/v1/enroll": { why: "a school node enrolls with a one-time token", check: "eden-enrollment-token", limit: "route", cache: "no-store" },
  "POST /api/eden/v1/heartbeat": { why: "school node heartbeat", check: "eden-node-signature", limit: "prefix", cache: "no-store" },
  "POST /api/eden/v1/messages": { why: "school node sends sealed messages", check: "eden-node-signature", limit: "prefix", cache: "no-store" },
  "GET /api/eden/v1/bundles/:kind": { why: "school node fetches signed bundles", check: "eden-node-signature", limit: "prefix", cache: "no-store" },
  "PUT /api/eden/v1/continuity": { why: "school node continuity snapshot", check: "eden-node-signature", limit: "prefix", cache: "no-store" },
  "GET /api/eden/v1/failovers/:id/package": { why: "failover package to a partner node", check: "eden-node-signature", limit: "prefix", cache: "no-store" },
  "POST /api/eden/v1/failovers/:id/activated": { why: "failover activation report", check: "eden-node-signature", limit: "prefix", cache: "no-store" },
  "PUT /api/eden/v1/failovers/:id/return": { why: "failover return package", check: "eden-node-signature", limit: "prefix", cache: "no-store" },
  "GET /api/eden/v1/failovers/:id/return": { why: "home node fetches the return package", check: "eden-node-signature", limit: "prefix", cache: "no-store" },
  "POST /api/eden/v1/failovers/:id/purged": { why: "partner confirms it purged hosted data", check: "eden-node-signature", limit: "prefix", cache: "no-store" },
  "POST /api/eden/v1/failovers/:id/imported": { why: "home node confirms it imported the return", check: "eden-node-signature", limit: "prefix", cache: "no-store" },
};

const key = r => r.methods.map(m => `${m} ${r.path}`);
const all = TIERS.flatMap(tier => inventories[tier].routes.map(r => ({ ...r, tier })));
const unique = new Map(); for (const r of all) for (const k of key(r)) if (!unique.has(k)) unique.set(k, r);
const sessionGuarded = r => r.guards.includes("requireSession");
const prefixOf = path => ["/api", "/auth", "/lti"].find(p => path.startsWith(`${p}/`)) || null;
const firstDbCall = src => { const m = /\b(?:pool|client|c)\.query\(|withTenantTransaction\(|\bsys\(|serviceTx\(/.exec(src); return m ? m.index : Infinity; };

test("the inventory sees the whole app in every tier", () => {
  for (const tier of TIERS) assert.ok(inventories[tier].routes.length > 800, `tier "${tier}": ${inventories[tier].routes.length} routes`);
  assert.ok(inventories.district.routes.some(r => r.path === "/api/eden/v1/heartbeat"), "the district hub's node API is included");
  assert.ok(inventories.school.routes.some(r => r.path === "/api/node/status"), "the school node's routes are included");
});

test("every route requires a session or is reviewed in the public list", () => {
  const unreviewed = [...unique].filter(([k, r]) => !sessionGuarded(r) && !PUBLIC[k]).map(([k, r]) => `${k} (tier "${r.tier}")`);
  assert.deepEqual(unreviewed, [], "add a session guard, or review the route and list it in PUBLIC with its check, limit and cache");
});

test("the public list has no stale or redundant entries", () => {
  for (const [k, entry] of Object.entries(PUBLIC)) {
    const r = unique.get(k);
    assert.ok(r, `${k} is listed but no longer registered`);
    assert.ok(!sessionGuarded(r), `${k} now requires a session; remove it from the list`);
    assert.ok(entry.why && CHECKS[entry.check], `${k}: a reason and a known check`);
  }
});

test("a caller without a session is checked before any data is read", () => {
  for (const [k, entry] of Object.entries(PUBLIC)) {
    const r = unique.get(k); const { guard, source } = CHECKS[entry.check];
    if (guard) assert.ok(r.guards.includes(guard), `${k}: ${guard} in its chain`);
    if (source) {
      const at = r.handler.search(source);
      assert.ok(at >= 0, `${k}: the handler checks the caller (${source})`);
      assert.ok(at < firstDbCall(r.handler), `${k}: the caller is checked before the first database call`);
    }
  }
});

test("rate limits: every /api, /auth and /lti route is under a ceiling; listed routes keep their own limiter", () => {
  for (const tier of TIERS) for (const [p, c] of Object.entries(inventories[tier].prefixes))
    assert.ok(c.rateLimits >= 1, `tier "${tier}": ${p} has a ceiling`);
  for (const [k, entry] of Object.entries(PUBLIC)) {
    const r = unique.get(k);
    if (entry.limit === "route") assert.ok(r.guards.includes("rateLimit"), `${k}: its own rate limiter`);
    if (entry.limit === "prefix") assert.ok(prefixOf(r.path), `${k}: under a limited prefix`);
    if (entry.limit === "none") assert.equal(prefixOf(r.path), null, `${k}: a prefix route can't claim no limit`);
  }
});

test("state-changing session routes check the CSRF token", () => {
  const missing = [...unique].filter(([k, r]) => sessionGuarded(r) && !/^(GET|HEAD) /.test(k) && !r.guards.includes("requireCsrf")).map(([k]) => k);
  assert.deepEqual(missing, []);
  for (const [k, r] of unique) if (r.guards.includes("requireCsrf"))
    assert.ok(r.guards.indexOf("requireSession") < r.guards.indexOf("requireCsrf"), `${k}: the session is read before the CSRF check`);
});

test("caching: /api, /auth and /lti are no-store by default; only listed routes opt into public caching", () => {
  for (const tier of TIERS) for (const [p, c] of Object.entries(inventories[tier].prefixes))
    assert.ok(c.noStoreDefault, `tier "${tier}": ${p} defaults to no-store`);
  for (const [k, entry] of Object.entries(PUBLIC)) {
    const r = unique.get(k); const sets = /Cache-Control["'],\s*["']public/.test(r.handler);
    if (entry.cache === "public") assert.ok(sets, `${k}: sets its public max-age`);
    else assert.ok(!sets, `${k}: listed no-store but sets public caching`);
  }
  const publicCached = [...unique].filter(([k, r]) => /Cache-Control["'],\s*["']public/.test(r.handler) && PUBLIC[k]?.cache !== "public").map(([k]) => k);
  assert.deepEqual(publicCached, [], "public caching only on reviewed public routes");
});

test("over HTTP: answers without a session, refused or not, are no-store", async () => {
  process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/eduos_test";
  process.env.PUBLIC_ORIGIN ||= "http://localhost:8080";
  process.env.OIDC_ISSUER ||= "https://identity.example.test";
  process.env.OIDC_CLIENT_ID ||= "eduos-test";
  process.env.OIDC_CLIENT_SECRET ||= "test-secret";
  process.env.OIDC_REDIRECT_URI ||= "http://localhost:8080/auth/callback";
  const { app } = await import("../src/server.js");
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [method, path, status] of [["GET", "/api/students", [401]], ["GET", "/api/app-config", [200]], ["POST", "/auth/logout", [401]], ["GET", "/lti/nrps/x/memberships", [401, 503]]]) {
      const r = await fetch(base + path, { method });
      assert.ok(status.includes(r.status), `${method} ${path}: ${r.status}`);
      assert.equal(r.headers.get("cache-control"), "no-store", `${method} ${path}`);
    }
  } finally { server.close(); }
});
