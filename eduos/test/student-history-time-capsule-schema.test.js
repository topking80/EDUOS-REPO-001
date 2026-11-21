import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const migration = readFileSync(new URL("../db/086_student_history_time_capsule.sql", import.meta.url), "utf8");
const grants = readFileSync(new URL("../db/runtime_grants.template.sql", import.meta.url), "utf8");
const migrationDocs = readFileSync(new URL("../docs/MIGRATIONS.md", import.meta.url), "utf8");
const shippedMigrationNames = readdirSync(new URL("../db/", import.meta.url)).filter(name => name.startsWith("086_") && name.endsWith(".sql")).sort();

const tables = [
  "student_history_entries",
  "student_history_entry_revisions",
  "student_history_entry_attachments",
  "student_time_capsules",
  "student_time_capsule_items",
  "student_time_capsule_recipients",
  "student_time_capsule_events"
];

test("TC-01 creates the complete student history and Time Capsule relational foundation", () => {
  for (const table of tables) assert.ok(migration.includes(`CREATE TABLE ${table} (`), table);
});

test("TC-01 data is tenant- and school-scoped with forced row-level security", () => {
  assert.ok(migration.includes("ALTER TABLE %I ENABLE ROW LEVEL SECURITY"));
  assert.ok(migration.includes("ALTER TABLE %I FORCE ROW LEVEL SECURITY"));
  assert.ok(migration.includes("current_setting(''app.district_id'', true)"));
  assert.ok(migration.includes("current_setting(''app.school_id'', true)"));
  assert.ok(migration.includes("current_setting(''app.role'', true) = ''superintendent''"));
  for (const table of tables) assert.ok(migration.includes(`'${table}'`), `${table} is included in the RLS loop`);
});

test("history revisions are captured transactionally and cannot be rewritten", () => {
  assert.ok(migration.includes("AFTER INSERT OR UPDATE ON student_history_entries"));
  assert.ok(migration.includes("NEW.revision_no := OLD.revision_no + 1"));
  assert.ok(migration.includes("INSERT INTO student_history_entry_revisions"));
  assert.ok(migration.includes("student_history_revisions_append_only"));
  assert.ok(migration.includes("student_time_capsule_events_append_only"));
  assert.ok(migration.includes("REVOKE ALL ON FUNCTION eduos_student_history_capture_revision() FROM PUBLIC"));
  assert.ok(migration.includes("REVOKE ALL ON FUNCTION eduos_student_history_write_revision() FROM PUBLIC"));
  assert.ok(migration.includes("LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp"));
});

test("media attachments reference the existing private media registry, never binary payloads or public URLs", () => {
  assert.ok(migration.includes("REFERENCES private_media_objects(district_id, school_id, asset_id)"));
  assert.ok(migration.includes("private_media_objects_district_school_asset_uq"));
  assert.ok(!migration.toLowerCase().includes("bytea"));
  assert.ok(!migration.includes("http://") && !migration.includes("https://"));
});

test("capsule items bind to same-student history and retain a specific entry revision", () => {
  assert.ok(migration.includes("entry_revision_no integer NOT NULL CHECK (entry_revision_no >= 1)"));
  assert.ok(migration.includes("FOREIGN KEY (district_id, entry_id, entry_revision_no)"));
  assert.ok(migration.includes("REFERENCES student_history_entry_revisions(district_id, entry_id, revision_no)"));
  assert.ok(migration.includes("FOREIGN KEY (district_id, school_id, student_id, entry_id)"));
  assert.ok(migration.includes("FOREIGN KEY (district_id, school_id, student_id, capsule_id)"));
  assert.ok(migration.includes("FOREIGN KEY (district_id, recipient_user_id) REFERENCES district_users"));
});

test("history authors, revision actors, and capsule owners/recipients are district members", () => {
  assert.ok(migration.includes("FOREIGN KEY (district_id, author_user_id) REFERENCES district_users"));
  assert.ok(migration.includes("FOREIGN KEY (district_id, actor_user_id) REFERENCES district_users"));
  assert.ok(migration.includes("FOREIGN KEY (district_id, owner_user_id) REFERENCES district_users"));
});

test("runtime role gets only the operations required by TC-01 and no destructive privileges", () => {
  const normalized = grants.replace(/\s+/g, " ");
  for (const table of ["student_history_entries", "student_time_capsules"]) {
    const readCreateGrant = table === "student_time_capsules"
      ? "GRANT SELECT, INSERT ON student_time_capsules, student_time_capsule_recipients TO eduos_app;"
      : `GRANT SELECT, INSERT ON ${table} TO eduos_app;`;
    assert.ok(normalized.includes(readCreateGrant), `${table} has its required read/create grant`);
    assert.ok(normalized.includes(`REVOKE DELETE, TRUNCATE ON ${table} FROM eduos_app;`) ||
      (table === "student_time_capsules" && normalized.includes("REVOKE DELETE, TRUNCATE ON student_time_capsules, student_time_capsule_recipients FROM eduos_app;")),
      `${table} blocks destructive access`);
  }
  for (const table of ["student_history_entry_revisions", "student_history_entry_attachments", "student_time_capsule_items", "student_time_capsule_events"]) {
    const grant = table === "student_history_entry_revisions"
      ? "GRANT SELECT ON student_history_entry_revisions TO eduos_app;"
      : "GRANT SELECT, INSERT ON student_history_entry_attachments, student_time_capsule_items, student_time_capsule_events TO eduos_app;";
    assert.ok(normalized.includes(grant), `${table} has its required read/write grant`);
    const revoke = table === "student_history_entry_revisions"
      ? "REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON student_history_entry_revisions FROM eduos_app;"
      : "REVOKE UPDATE, DELETE, TRUNCATE ON student_history_entry_attachments, student_time_capsule_items, student_time_capsule_events FROM eduos_app;";
    assert.ok(normalized.includes(revoke), `${table} blocks forbidden mutation`);
  }
  assert.ok(normalized.includes("GRANT SELECT, INSERT ON student_time_capsules, student_time_capsule_recipients TO eduos_app;"));
  assert.ok(normalized.includes("GRANT UPDATE (entry_type, classification, title, body, occurred_at, school_year, audience, source_reference) ON student_history_entries TO eduos_app;"));
  assert.ok(normalized.includes("GRANT UPDATE (title, message, timezone, updated_at) ON student_time_capsules TO eduos_app;"));
  assert.doesNotMatch(normalized, /GRANT UPDATE \\([^)]*\\bstatus\\b[^)]*\\) ON student_history_entries TO eduos_app/);
  assert.doesNotMatch(normalized, /GRANT UPDATE \\([^)]*\\b(status|release_kind|release_at|milestone_key|sealed_at|released_at|cancelled_at)\\b[^)]*\\) ON student_time_capsules TO eduos_app/);
  assert.ok(normalized.includes("REVOKE UPDATE (status) ON student_history_entries FROM eduos_app;"));
  assert.ok(normalized.includes("REVOKE UPDATE (status, release_kind, release_at, milestone_key, sealed_at, released_at, cancelled_at) ON student_time_capsules FROM eduos_app;"));
  assert.ok(!normalized.includes("GRANT UPDATE ON student_history_entries TO eduos_app;"));
  assert.ok(!normalized.includes("GRANT UPDATE ON student_time_capsules TO eduos_app;"));
  assert.ok(normalized.includes("GRANT UPDATE (consent_status, updated_at) ON student_time_capsule_recipients TO eduos_app;"));
  assert.ok(normalized.includes("REVOKE DELETE, TRUNCATE ON student_time_capsule_recipients FROM eduos_app;"));
});

test("TC-01 migration is picked up by automatic discovery without editing the fixed legacy list", () => {
  assert.ok(shippedMigrationNames.includes("086_student_history_time_capsule.sql"));
});

test("migration guide explains automatic numbered migration discovery and forward-only recovery", () => {
  assert.ok(migrationDocs.includes("Numbered `db/NNN_*.sql` migration files are discovered"));
  assert.ok(migrationDocs.includes("Migrations only go forward"));
});
