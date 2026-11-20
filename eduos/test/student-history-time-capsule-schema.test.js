import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../db/086_student_history_time_capsule.sql", import.meta.url), "utf8");
const grants = readFileSync(new URL("../db/runtime_grants.template.sql", import.meta.url), "utf8");
const migrationDocs = readFileSync(new URL("../docs/MIGRATIONS.md", import.meta.url), "utf8");

test("TC-01 creates the complete student history and Time Capsule relational foundation", () => {
  for (const table of [
    "student_history_entries",
    "student_history_entry_revisions",
    "student_history_entry_attachments",
    "student_time_capsules",
    "student_time_capsule_items",
    "student_time_capsule_recipients",
    "student_time_capsule_events"
  ]) assert.match(migration, new RegExp(`CREATE TABLE ${table}\\b`), table);
});

test("TC-01 data is tenant- and school-scoped with forced row-level security", () => {
  assert.match(migration, /ALTER TABLE %I ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE %I FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /app\\.district_id/);
  assert.match(migration, /app\\.school_id/);
  assert.match(migration, /current_setting\(''app\\.role'', true\) = ''superintendent''/);
  assert.equal((migration.match(/CREATE POLICY %I ON %I/g) || []).length, 1, "one policy is created for each table in the explicit table list");
  for (const table of [
    "student_history_entries", "student_history_entry_revisions", "student_history_entry_attachments",
    "student_time_capsules", "student_time_capsule_items", "student_time_capsule_recipients", "student_time_capsule_events"
  ]) assert.ok(migration.includes(`'${table}'`), `${table} is included in the RLS loop`);
});

test("history revisions are captured transactionally and cannot be rewritten", () => {
  assert.match(migration, /AFTER INSERT OR UPDATE ON student_history_entries/);
  assert.match(migration, /NEW\\.revision_no := OLD\\.revision_no \\+ 1/);
  assert.match(migration, /INSERT INTO student_history_entry_revisions/);
  assert.match(migration, /student_history_revisions_append_only/);
  assert.match(migration, /student_time_capsule_events_append_only/);
  assert.match(migration, /REVOKE ALL ON FUNCTION eduos_student_history_.* FROM PUBLIC/);
});

test("media attachments reference the existing private media registry, never binary payloads or public URLs", () => {
  assert.match(migration, /REFERENCES private_media_objects\(district_id, school_id, asset_id\)/);
  assert.match(migration, /storage_key/);
  assert.doesNotMatch(migration, /https?:\\/\\//i);
  assert.doesNotMatch(migration, /bytea/i);
});

test("capsule items bind to same-student history and retain a specific entry revision", () => {
  assert.match(migration, /entry_revision_no integer NOT NULL CHECK \(entry_revision_no >= 1\)/);
  assert.match(migration, /FOREIGN KEY \(district_id, school_id, student_id, entry_id\)/);
  assert.match(migration, /FOREIGN KEY \(district_id, school_id, student_id, capsule_id\)/);
  assert.match(migration, /FOREIGN KEY \(district_id, recipient_user_id\) REFERENCES memberships/);
});

test("runtime role gets only the operations required by TC-01 and no destructive privileges", () => {
  for (const table of ["student_history_entries", "student_time_capsules"]) {
    assert.match(grants, new RegExp(`GRANT SELECT, INSERT, UPDATE ON ${table} TO eduos_app`));
    assert.match(grants, new RegExp(`REVOKE DELETE, TRUNCATE ON ${table} FROM eduos_app`));
  }
  for (const table of ["student_history_entry_revisions", "student_history_entry_attachments", "student_time_capsule_items", "student_time_capsule_events"]) {
    assert.match(grants, new RegExp(`GRANT SELECT, INSERT ON ${table} TO eduos_app`));
    assert.match(grants, new RegExp(`REVOKE UPDATE, DELETE, TRUNCATE ON ${table} FROM eduos_app`));
  }
  assert.match(grants, /GRANT SELECT, INSERT, UPDATE ON student_time_capsule_recipients TO eduos_app/);
  assert.match(grants, /REVOKE DELETE, TRUNCATE ON student_time_capsule_recipients FROM eduos_app/);
});

test("migration guide explains automatic numbered migration discovery and forward-only recovery", () => {
  assert.match(migrationDocs, /numbered migration files in `db\/`/);
  assert.match(migrationDocs, /Migrations only go forward/);
});
