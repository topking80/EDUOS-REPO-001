import { config } from "./config.js";

// Defer loading the PostgreSQL driver until the first real database operation.
// This lets pure policy/auth tests import middleware without a running DB driver,
// while production still uses the official `pg` Pool with the same settings.
let realPool;
let poolPromise;
const errorListeners = new Set();
async function getPool() {
  if (!poolPromise) {
    poolPromise = import("pg").then(({ default: pg }) => {
      const { Pool } = pg;
      // DATE columns are calendar days: return "YYYY-MM-DD" instead of a Date at
      // server-local midnight, which shifts the day in UTC+ time zones.
      pg.types.setTypeParser(1082, value => value);
      realPool = new Pool({
        connectionString: config.databaseUrl,
        ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
        max: Number(process.env.DATABASE_POOL_MAX) || 20,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        application_name: "eduos-api"
      });
      realPool.on("error", err => {
        // Do not log query parameters or credentials.
        console.error("Unexpected PostgreSQL pool error:", err.message);
        for (const listener of errorListeners) listener(err);
      });
      return realPool;
    }).catch(error => { poolPromise = undefined; throw error; });
  }
  return poolPromise;
}

export const pool = {
  query: (...args) => getPool().then(p => p.query(...args)),
  connect: (...args) => getPool().then(p => p.connect(...args)),
  end: async () => {
    const pending = poolPromise;
    if (!pending) return;
    try {
      const instance = await pending;
      await instance.end();
    } finally {
      // Reset even if pool creation or shutdown fails, allowing a clean retry.
      if (poolPromise === pending) {
        realPool = undefined;
        poolPromise = undefined;
      }
    }
  },
  /** Connection counts for /metrics (null until the first query). */
  stats: () => realPool ? { total: realPool.totalCount, idle: realPool.idleCount, waiting: realPool.waitingCount } : null,
  on: (event, listener) => {
    if (event === "error" && typeof listener === "function") errorListeners.add(listener);
    return pool;
  }
};

/** Every tenant-owned query must run through this transaction helper. */
export async function withTenantTransaction(actor, callback) {
  if (!actor?.districtId || !actor?.userId || !actor?.role) {
    throw new TypeError("Tenant transaction requires districtId, userId, and role");
  }
  if (typeof callback !== "function") throw new TypeError("Transaction callback is required");

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      "SELECT set_config('app.district_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', $3, true), set_config('app.school_id', $4, true), set_config('app.membership_role', $5, true)",
      [String(actor.districtId), String(actor.userId), String(actor.role), actor.schoolId ? String(actor.schoolId) : "", String(actor.membershipRole || actor.role)]
    );
    const result = await callback(client);
    await client.query("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) {
        // Preserve the original operation error while retaining rollback context.
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

/** The numbered migrations shipped in db/ (the same set src/migrate.js applies). */
export async function shippedMigrations() {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(new URL("../db/", import.meta.url))).filter(f => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
}

/**
 * Refuse to start against a database that has not been fully migrated, instead
 * of failing later on the first request with "relation does not exist".
 */
export async function assertSchemaReady(db = pool, expected = null) {
  const want = expected || await shippedMigrations();
  const hint = "run `npm run db:migrate` with DATABASE_URL set to the migration owner role";
  const { rows: [{ reg }] } = await db.query("SELECT to_regclass('public.schema_migrations') AS reg");
  if (!reg) throw new Error(`Refusing to start: the database schema is not migrated (no schema_migrations table); ${hint}`);
  let applied;
  try {
    applied = new Set((await db.query("SELECT name FROM schema_migrations")).rows.map(r => r.name));
  } catch (error) {
    if (error?.code === "42501") throw new Error(`Refusing to start: the runtime role cannot read schema_migrations (grants are out of date); ${hint}`);
    throw error;
  }
  const missing = want.filter(name => !applied.has(name));
  if (missing.length) throw new Error(`Refusing to start: ${missing.length} migration(s) not applied (${missing.join(", ")}); ${hint}`);
  return want.length;
}

/**
 * Refuse to run with a database role that defeats row-level security:
 * superusers and BYPASSRLS roles ignore RLS, and an object's owner (or any
 * member of the owning role) can disable it, rewrite policies or replace a
 * SECURITY DEFINER function. 2026-11-17 audit, finding 7: every
 * table, view, sequence and function in the schema is checked, not just
 * students.
 */
export async function assertSafeRuntimeRole(db = pool) {
  const { rows: [role] } = await db.query(
    `SELECT current_user AS name, r.rolsuper, r.rolbypassrls,
            (SELECT array_agg(DISTINCT c.relname::text ORDER BY c.relname::text) FROM pg_class c
              WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','S','f')
                AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS owned_relations,
            (SELECT array_agg(DISTINCT p.proname::text ORDER BY p.proname::text) FROM pg_proc p
              WHERE p.pronamespace='public'::regnamespace AND pg_has_role(current_user, p.proowner, 'MEMBER')) AS owned_functions
       FROM pg_roles r WHERE r.rolname=current_user`);
  if (!role) throw new Error("Unable to inspect the database role");
  if (role.rolsuper) throw new Error(`Refusing to start: database role ${role.name} is a superuser (row-level security would be bypassed)`);
  if (role.rolbypassrls) throw new Error(`Refusing to start: database role ${role.name} has BYPASSRLS`);
  const owned = [...(role.owned_relations || []), ...(role.owned_functions || []).map(f => `${f}()`)];
  if (owned.length) throw new Error(`Refusing to start: database role ${role.name} owns EduOS schema objects (${owned.slice(0, 5).join(", ")}${owned.length > 5 ? `, +${owned.length - 5} more` : ""}); use the dedicated runtime role`);
  return role.name;
}

/**
 * HSP-01: a transaction in a homeschool family's context. app.family_id is
 * the family; app.district_id and app.school_id are empty, so no district
 * table's row-level security matches anything in it.
 */
export async function withFamilyTransaction(actor, callback) {
  if (actor?.tenantKind !== "homeschool_family" || !actor.familyId || !actor.userId) throw new TypeError("Family transaction requires a family session");
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    await client.query(
      "SELECT set_config('app.family_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', $3, true), set_config('app.district_id', '', true), set_config('app.school_id', '', true), set_config('app.membership_role', $3, true)",
      [String(actor.familyId), String(actor.userId), `family_${actor.familyRole}`]);
    const result = await callback(client);
    await client.query("COMMIT");
    open = false;
    return result;
  } catch (error) {
    if (open) { try { await client.query("ROLLBACK"); } catch (e) { error.rollbackError = e; } }
    throw error;
  } finally { client.release(); }
}

/** HSP-01: a transaction outside any family, as the signed-in user only (creating a family, accepting an invitation). */
export async function withUserTransaction(actor, callback) {
  if (!actor?.userId) throw new TypeError("User transaction requires a user");
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.family_id', '', true), set_config('app.district_id', '', true), set_config('app.school_id', '', true), set_config('app.role', '', true)", [String(actor.userId)]);
    const result = await callback(client);
    await client.query("COMMIT");
    open = false;
    return result;
  } catch (error) {
    if (open) { try { await client.query("ROLLBACK"); } catch (e) { error.rollbackError = e; } }
    throw error;
  } finally { client.release(); }
}
