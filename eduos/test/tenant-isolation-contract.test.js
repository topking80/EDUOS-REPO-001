import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const migrations = readdirSync("db").filter(name => /^\d+.*\.sql$/.test(name)).sort();
const sql = migrations.map(name => readFileSync(`db/${name}`, "utf8")).join("\n");
const server = readFileSync("src/server.js", "utf8");
const db = readFileSync("src/db.js", "utf8");

const tenantTables = [
  "schools", "students", "student_user_links", "attendance_events", "audit_events",
  "assignments", "assignment_submissions", "access_requests", "permission_grants",
  "student_intervention_cases", "student_case_notes", "family_messages",
  "teacher_classroom_preferences", "sis_sync_runs", "sis_attendance_imports",
  "guardian_invitations", "flow_events", "webhook_subscriptions", "webhook_deliveries"
];

test("every tenant-owned table has ENABLE and FORCE RLS plus district-scoped USING and WITH CHECK", () => {
  for (const table of tenantTables) {
    if (["schools", "students", "student_user_links", "attendance_events", "audit_events"].includes(table)) {
      assert.match(sql, /ALTER TABLE %I ENABLE ROW LEVEL SECURITY/);
      assert.match(sql, /ALTER TABLE %I FORCE ROW LEVEL SECURITY/);
      assert.match(sql, new RegExp(`'${table}'`), `${table}: included in initial policy loop`);
    } else {
      const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(sql, new RegExp(`ALTER TABLE ${escaped} ENABLE ROW LEVEL SECURITY`, "i"), `${table}: ENABLE RLS`);
      assert.match(sql, new RegExp(`ALTER TABLE ${escaped} FORCE ROW LEVEL SECURITY`, "i"), `${table}: FORCE RLS`);
      const policy = new RegExp(`CREATE POLICY tenant_isolation ON ${escaped}\\s+USING \\(district_id\\s*=\\s*nullif\\(current_setting\\('app\\.district_id', true\\), ''\\)::uuid\\)\\s+WITH CHECK \\(district_id\\s*=\\s*nullif\\(current_setting\\('app\\.district_id', true\\), ''\\)::uuid\\)`, "i");
      assert.match(sql, policy, `${table}: district isolation policy`);
    }
  }
});

test("tenant transaction sets district, user and role transaction-locally before callback and rolls back errors", () => {
  assert.match(db, /await client\.query\("BEGIN"\)/);
  assert.match(db, /set_config\('app\.district_id', \$1, true\), set_config\('app\.user_id', \$2, true\), set_config\('app\.role', \$3, true\)/);
  assert.match(db, /const result = await callback\(client\)/);
  assert.match(db, /await client\.query\("COMMIT"\)/);
  assert.match(db, /await client\.query\("ROLLBACK"\)/);
  assert.match(db, /client\.release\(\)/);
  assert.match(db, /if \(!actor\?\.districtId \|\| !actor\?\.userId \|\| !actor\?\.role\)/);
});

test("school-sensitive SQL binds district scope and restricts staff to assigned schools", () => {
  const checks = [
    /s\.school_id=\$4::uuid/,
    /WHERE l\.district_id=\$1 AND l\.user_id=\$2 AND l\.status='active'/,
    /WHERE r\.district_id=\$1 AND \(\$2 IN \('superintendent','it_admin'\) OR r\.school_id=\$3\)/,
    /if\(req\.actor\.role!=="superintendent"&&student\.rows\[0\]\.school_id!==req\.actor\.schoolId\)/
  ];
  for (const pattern of checks) assert.match(server, pattern);
});

test("tenant transaction rejects incomplete actor context before opening a connection", () => {
  assert.match(db, /Tenant transaction requires districtId, userId, and role/);
  assert.match(db, /typeof callback !== "function"/);
});
