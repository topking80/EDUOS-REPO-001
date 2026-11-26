// Master Control database access. Its own pool and login; every query runs
// with search_path set to the master_control schema only.
import pg from "pg";

export function createDb(cfg) {
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 10, options: `-c search_path=${cfg.schema},pg_temp` });
  return {
    pool,
    query: (sql, params) => pool.query(sql, params),
    /** Serialized write: one administrative change at a time keeps the
     * model check and the audit hash chain consistent. */
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(hashtext('eduos-master-control'))");
        const out = await fn(c);
        await c.query("COMMIT");
        return out;
      } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
      finally { c.release(); }
    },
    end: () => pool.end(),
  };
}

/**
 * Refuse to run with a login that could read district data, bypass RLS, or
 * administer the server. Master Control's separation from student records is
 * a database fact, checked here at every start.
 */
export async function assertSeparated(db) {
  const { rows: [r] } = await db.query(`SELECT current_user AS u, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb
    FROM pg_roles r WHERE r.rolname = current_user`);
  if (r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.rolcreatedb)
    throw new Error(`Refusing to start: Master Control's login ${r.u} is a superuser or can bypass RLS, create roles or create databases`);
  const { rows } = await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('master_control','pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','v','m','p','f')
      AND (has_table_privilege(c.oid, 'SELECT') OR has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE'))
    LIMIT 5`);
  if (rows.length) throw new Error(`Refusing to start: Master Control's login can reach tables outside its schema (${rows.map(x => x.relname).join(", ")})`);
  const { rows: [m] } = await db.query("SELECT to_regclass('master_control.audit_log') AS reg");
  if (!m.reg) throw new Error("Refusing to start: Master Control's schema is not migrated; run `npm run mc:migrate`");
}
