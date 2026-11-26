// FED-03: create or update Master Control's schema (`npm run mc:migrate`).
// Run as the migration owner (MC_MIGRATE_DATABASE_URL, else MC_DATABASE_URL);
// then grants the runtime role (MC_APP_ROLE) this schema and nothing else.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const dir = new URL("../../db/master-control/", import.meta.url);

export async function migrate({ url = process.env.MC_MIGRATE_DATABASE_URL || process.env.MC_DATABASE_URL, appRole = process.env.MC_APP_ROLE || "mc_app" } = {}) {
  if (!url) throw new Error("MC_MIGRATE_DATABASE_URL (or MC_DATABASE_URL) is required");
  if (!IDENT.test(appRole)) throw new Error("MC_APP_ROLE must be a simple lower-case SQL identifier");
  const c = new pg.Client(url); await c.connect();
  try {
    const role = await c.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1", [appRole]);
    if (!role.rowCount) throw new Error(`Runtime role ${appRole} does not exist; create it (LOGIN NOSUPERUSER NOBYPASSRLS) first`);
    if (role.rows[0].rolsuper || role.rows[0].rolbypassrls) throw new Error(`Runtime role ${appRole} is a superuser or has BYPASSRLS`);
    await c.query("CREATE SCHEMA IF NOT EXISTS master_control");
    await c.query("CREATE TABLE IF NOT EXISTS master_control.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const files = (await readdir(dir)).filter(f => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
    for (const f of files) {
      if ((await c.query("SELECT 1 FROM master_control.schema_migrations WHERE name=$1", [f])).rowCount) continue;
      await c.query("BEGIN");
      try {
        await c.query(await readFile(new URL(f, dir), "utf8"));
        await c.query("INSERT INTO master_control.schema_migrations(name) VALUES ($1)", [f]);
        await c.query("COMMIT");
        console.log(`master control ${f} applied`);
      } catch (e) { await c.query("ROLLBACK"); throw e; }
    }
    const grants = (await readFile(new URL("runtime_grants.template.sql", dir), "utf8")).replace(/\bmc_app\b/g, appRole);
    await c.query(grants);
    console.log(`master control grants applied to ${appRole}`);
  } finally { await c.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate().catch(e => { console.error(e.message); process.exit(1); });
}
