import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../db/074_commerce_webhook_endpoints.sql", import.meta.url), "utf8");
const grants = await readFile(new URL("../db/runtime_grants.template.sql", import.meta.url), "utf8");

test("webhook endpoint tokens are stored only as unique SHA-256 digests", () => {
  assert.match(migration, /token_sha256 text NOT NULL UNIQUE CHECK\(token_sha256 ~ '\^\[a-f0-9\]\{64\}\$'\)/);
  assert.match(migration, /CREATE INDEX commerce_webhook_endpoints_active[\s\S]*WHERE active/);
  assert.doesNotMatch(migration, /token_secret\s+text/i);
});

test("endpoint registry is forced through district RLS", () => {
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /district_id = nullif\(current_setting\('app\.district_id', true\), ''\)::uuid/);
});

test("public resolver is narrow, token-only, and returns encrypted credentials", () => {
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /SET search_path = pg_catalog, public/);
  assert.match(migration, /WHERE e\.token_sha256=p_token_sha256[\s\S]*AND e\.active[\s\S]*AND a\.enabled/);
  assert.match(migration, /secrets_enc text/);
  assert.match(migration, /REVOKE ALL ON FUNCTION eduos_commerce_webhook_account\(text\) FROM PUBLIC/);
  assert.doesNotMatch(migration, /p_district_id|p_processor\s+text/i);
});

test("runtime can manage tenant endpoints and call only the resolver function", () => {
  assert.match(grants, /GRANT SELECT, INSERT, UPDATE ON commerce_webhook_endpoints TO eduos_app/);
  assert.match(grants, /REVOKE DELETE, TRUNCATE ON commerce_webhook_endpoints FROM eduos_app/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION eduos_commerce_webhook_account\(text\) TO eduos_app/);
});


const setup = await readFile(new URL("../src/commerce/setup.js", import.meta.url), "utf8");
const routes = await readFile(new URL("../src/commerce-routes.js", import.meta.url), "utf8");
const helpers = await readFile(new URL("../src/route-helpers.js", import.meta.url), "utf8");

test("district endpoint issuance uses high-entropy one-time tokens and persists only digests", () => {
  assert.match(setup, /randomBytes\(32\)\.toString\("hex"\)/);
  assert.match(setup, /createHash\("sha256"\)\.update\(token, "utf8"\)\.digest\("hex"\)/);
  assert.match(setup, /token_sha256,created_by/);
  assert.doesNotMatch(setup, /INSERT INTO commerce_webhook_endpoints[^;]*\btoken\b/i);
  assert.match(setup, /UPDATE commerce_webhook_endpoints SET active=false, revoked_at=now\(\)/);
});

test("webhook endpoint lifecycle is restricted to provider administrators and responses are not cached", () => {
  assert.match(routes, /app\.post\(["\`]\/api\/commerce\/providers\/:processor\/webhook-endpoint/i);
  assert.match(routes, /app\.post\(["\`]\/api\/commerce\/providers\/:processor\/webhook-endpoint\/rotate/i);
  assert.match(routes, /app\.delete\(["\`]\/api\/commerce\/providers\/:processor\/webhook-endpoint/i);
  assert.match(routes, /const provAdmin = \[limiter, requireSession, requireCsrf, requirePermission\("commerce", "providers"\)\]/);
  assert.match(helpers, /Cache-Control", "no-store"/);
});
