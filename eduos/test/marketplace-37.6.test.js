// 37.6.0 marketplace: wiring, privacy checklist, fee hook placeholder.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CHECKLIST } from "../src/marketplace/checklist.js";
import { FEES_STATUS } from "../src/marketplace/fees.js";

const sql = fs.readFileSync(new URL("../db/064_marketplace.sql", import.meta.url), "utf8");
const grants = fs.readFileSync(new URL("../db/runtime_grants.template.sql", import.meta.url), "utf8");
const mesh = fs.readFileSync(new URL("../src/mesh-routes.js", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../src/marketplace-routes.js", import.meta.url), "utf8");
const migrate = fs.readFileSync(new URL("../src/migrate.js", import.meta.url), "utf8");

test("the privacy checklist covers DPA, COPPA, FERPA, minimization, no ads/profiling, no tracking/biometrics, deletion, security", () => {
  assert.deepEqual(CHECKLIST.map(c => c[0]), ["dpa_signed", "coppa", "ferpa_school_official", "data_minimized", "no_ads_or_profiling", "no_tracking_or_biometrics", "deletion_on_request", "security_reviewed"]);
});
test("the fee hook is a placeholder: no amounts, no payments", () => {
  assert.equal(FEES_STATUS, "deferred");
  const fee = sql.slice(sql.indexOf("CREATE TABLE marketplace_fee_events"), sql.indexOf("marketplace_fee_events_append_only"));
  assert.doesNotMatch(fee, /amount|price|currency|card|payment/i);
  assert.doesNotMatch(routes, /fetch\(|stripe|paypal/i);
});
test("approval reuses the existing licensing tables and the request queue", () => {
  for (const t of ["INSERT INTO app_licenses", "INSERT INTO app_assignments", "INSERT INTO app_requests", "UPDATE app_requests SET status='approved'"]) assert.ok(routes.includes(t), t);
  assert.match(mesh, /if \(decision === "approved" && q\.listing_id\) return fail\(409, "use_marketplace_approval"\)/);
  assert.match(sql, /CREATE TRIGGER app_requests_marketplace_guard BEFORE UPDATE ON app_requests/);
});
test("migration 064 is registered; RLS hides unapproved listings from schools; reviews and fee events are append-only", () => {
  assert.match(migrate, /for \(const name of await shippedMigrations\(\)\) if \(!migrations\.includes\(name\)\) migrations\.push\(name\);/);
  assert.ok(fs.existsSync(new URL("../db/064_marketplace.sql", import.meta.url)));
  assert.match(sql, /eduos_ctx_role\(\) IN \('principal','teacher'\) AND status='listed' AND privacy_status='approved'/);
  assert.match(grants, /REVOKE UPDATE, DELETE, TRUNCATE ON marketplace_privacy_reviews, marketplace_fee_events FROM eduos_app/);
});
