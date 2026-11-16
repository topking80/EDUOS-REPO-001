import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";
const migrations = ["001_initial.sql", "002_learning_workflows.sql", "003_access_control.sql", "004_student_360_cases.sql", "005_performance_indexes.sql", "006_connected_workflows.sql", "007_guardian_invitations.sql", "008_flow_events_webhooks.sql", "009_security_privacy_fixes.sql", "010_district_resource_mesh.sql", "011_school_branding.sql", "012_role_apps_transport_christie_comms.sql", "013_safetyos_pickup.sql", "014_learning_core_edal.sql", "015_eden_local_node_decn.sql", "016_operational_event_stream.sql", "017_arrival_handoff.sql", "018_arrival_exception_resolution.sql", "019_arrival_escalation_alerts.sql", "020_sro_role.sql", "021_sro_district_policy.sql", "022_library_services.sql", "023_library_circulation.sql", "024_librarian_role_and_badges.sql", "025_library_renewals_family.sql", "026_library_policy_and_notice_ledger.sql", "027_school_operations_consoles.sql", "028_unified_school_operations.sql", "029_school_operations_automation.sql", "030_school_operations_notifications.sql", "031_staff_daily_workspace.sql", "032_district_staff_management.sql", "033_durable_webhook_outbox.sql", "034_transport_checkin_integrity.sql", "035_offline_replay_retention.sql", "036_webhook_delivery_attempt_unique.sql", "037_native_app_login.sql", "038_edge_device_health.sql", "039_edge_update_approvals.sql", "040_external_integrations.sql", "041_ai_gateway.sql", "042_ai_budget_reservations.sql", "043_student_redaction_index.sql", "044_notification_delivery.sql"];

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** Render runtime_grants.template.sql for the configured runtime role/database. */
export function renderRuntimeGrants(template, { appRole, database }) {
  if (!IDENT.test(appRole)) throw new Error("EDUOS_APP_ROLE must be a simple lower-case SQL identifier");
  if (!IDENT.test(database)) throw new Error("Database name must be a simple lower-case SQL identifier");
  return template.replace(/\beduos_app\b/g, appRole).replace(/\bDATABASE eduos\b/g, `DATABASE ${database}`);
}

async function applyRuntimeGrants(appRole) {
  const role = await pool.query(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1", [appRole]);
  if (!role.rowCount) throw new Error(`Runtime role ${appRole} does not exist; create it (NOSUPERUSER NOBYPASSRLS) before migrating`);
  if (role.rows[0].rolsuper || role.rows[0].rolbypassrls)
    throw new Error(`Runtime role ${appRole} is a superuser or has BYPASSRLS; row-level security would not apply`);
  const owner = await pool.query("SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='students'");
  if (owner.rows[0]?.tableowner === appRole) throw new Error(`Runtime role ${appRole} must not own the EduOS tables`);
  const { rows: [{ db }] } = await pool.query("SELECT current_database() AS db");
  const template = await readFile(new URL("../db/runtime_grants.template.sql", import.meta.url), "utf8");
  await pool.query(renderRuntimeGrants(template, { appRole, database: db }));
  console.log(`runtime grants applied to ${appRole}`);
}

async function main() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const name of migrations) {
      const exists = await pool.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name]);
      if (exists.rowCount) { console.log(`${name} already applied`); continue; }
      const sql = await readFile(new URL(`../db/${name}`, import.meta.url), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
        await client.query("COMMIT");
        console.log(`${name} applied`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    }
    // Grants are re-applied on every run (idempotent) unless explicitly disabled.
    if (process.env.MIGRATE_APPLY_GRANTS !== "false") await applyRuntimeGrants(process.env.EDUOS_APP_ROLE || "eduos_app");
  } finally { await pool.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
