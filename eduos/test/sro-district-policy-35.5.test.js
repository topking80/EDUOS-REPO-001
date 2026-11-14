import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const admin = await readFile(new URL("../src/admin-routes.js", import.meta.url), "utf8");
const migration = await readFile(new URL("../db/021_sro_district_policy.sql", import.meta.url), "utf8");
const runner = await readFile(new URL("../src/migrate.js", import.meta.url), "utf8");
const grants = await readFile(new URL("../db/runtime_grants.template.sql", import.meta.url), "utf8");

test("35.5 policy is superintendent-editable and district-admin-readable", () => {
  assert.match(admin, /app\.get\("\/api\/admin\/sro-policy"/);
  assert.match(admin, /app\.put\("\/api\/admin\/sro-policy"/);
  assert.match(admin, /req\.actor\.role !== "superintendent"/);
  assert.match(admin, /allowedSchoolIds/);
  assert.match(admin, /requireSuperintendentApproval/);
});

test("SRO creation, membership assignment and reactivation enforce district policy", () => {
  assert.equal((admin.match(/sroPolicyAllows\(client, req\.actor\.districtId/g) || []).length, 3);
  assert.match(admin, /sro_district_policy_restriction/);
  assert.match(admin, /allowed_school_ids\.includes\(schoolId\)/);
});

test("policy storage is tenant-RLS protected and runtime grants are narrow", () => {
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /app\.district_id/);
  assert.match(grants, /GRANT SELECT, INSERT, UPDATE ON sro_district_policies TO eduos_app/);
  assert.match(grants, /REVOKE DELETE, TRUNCATE ON sro_district_policies/);
});

test("migration 021 is registered", () => assert.match(runner, /021_sro_district_policy\.sql/));
