// Release gate (EDUOS-DB-02): a backup of a populated database restores into
// a new database and the API runs on the copy, as the non-owner runtime role,
// with districts still isolated. This is the rollback path: migrations only
// go forward, so undoing an upgrade means restoring the backup taken before it
// (docs/MIGRATIONS.md).
//
// Also pins two facts the procedure depends on:
//   - pg_dump must run as a superuser or BYPASSRLS role: as the table owner
//     it stops at the first table with forced row-level security;
//   - pg_restore resolves functions with an empty search_path, so a function
//     used by a generated column, index or default must name its schema.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { PG_URL, ID, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const exec = promisify(execFile);
function tool(name) {
  const dirs = [process.env.PG_BIN, ...(existsSync("/usr/lib/postgresql") ? readdirSync("/usr/lib/postgresql").sort().reverse().map(v => `/usr/lib/postgresql/${v}/bin`) : []), "/usr/bin", "/usr/local/bin"];
  return dirs.filter(Boolean).map(d => path.join(d, name)).find(existsSync);
}
const PG_DUMP = tool("pg_dump"), PG_RESTORE = tool("pg_restore");
const skip = !PG_URL ? "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run"
  : (!PG_DUMP || !PG_RESTORE) && !process.env.CI ? "pg_dump/pg_restore not installed" : false;

describe("backup and restore of a populated database", { skip }, () => {
  let db, idp, env, server, dir, restoreName, restoreUrl;

  before(async () => {
    assert.ok(PG_DUMP && PG_RESTORE, "pg_dump and pg_restore are required in CI");
    db = await createDatabase();
    idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    dir = mkdtempSync(path.join(os.tmpdir(), "eduos-backup-"));
    restoreName = `${db.names.db}_restored`;
    const u = new URL(db.adminUrl); u.pathname = `/${restoreName}`; restoreUrl = u.toString();
  });
  after(async () => {
    await server?.stop(); await idp?.close();
    const c = new pg.Client(PG_URL); await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${restoreName} WITH (FORCE)`).catch(() => {});
    await c.end();
    await db?.drop?.();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("a backup taken as the table owner fails under forced row-level security", async () => {
    await assert.rejects(exec(PG_DUMP, ["-Fc", "-f", path.join(dir, "owner.dump"), db.ownerUrl]), /row-level security/);
  });

  it("a superuser backup restores into a new database, owned by the owner role, with nothing failing", async () => {
    await exec(PG_DUMP, ["-Fc", "-f", path.join(dir, "eduos.dump"), db.adminUrl]);
    const c = new pg.Client(PG_URL); await c.connect();
    await c.query(`CREATE DATABASE ${restoreName} OWNER ${db.names.owner}`);
    await c.end();
    // --exit-on-error: any statement that fails (a function that can't be
    // resolved, a missing grant) fails the drill rather than leaving a partial copy.
    const r = await exec(PG_RESTORE, ["--exit-on-error", "--no-owner", "--role", db.names.owner, "-d", restoreUrl, path.join(dir, "eduos.dump")])
      .catch(e => ({ failed: true, stderr: e.stderr }));
    assert.ok(!r.failed, `pg_restore failed: ${r.stderr}`);
    const a = new pg.Client(restoreUrl); await a.connect();
    try {
      const counts = (await a.query(`SELECT (SELECT count(*) FROM students)::int AS students, (SELECT count(*) FROM schema_migrations)::int AS migrations,
        (SELECT count(*) FROM student_redact_tokens)::int AS tokens`)).rows[0];
      assert.equal(counts.students, 4);
      assert.ok(counts.migrations >= 50, `${counts.migrations} migrations recorded`);
      assert.ok(counts.tokens > 0, "the redaction index came across");
      const { rows: [s] } = await a.query("SELECT redact_number_compact FROM students WHERE id=$1", [ID.alice]);
      assert.equal(s.redact_number_compact, "s1a", "generated columns recompute on the copy");
    } finally { await a.end(); }
  });

  it("the migrator re-applies grants on the copy, and the API runs on it as the runtime role, still district-isolated", async () => {
    const ownerRestoreUrl = (() => { const u = new URL(db.ownerUrl); u.pathname = `/${restoreName}`; return u.toString(); })();
    const appRestoreUrl = (() => { const u = new URL(db.appUrl); u.pathname = `/${restoreName}`; return u.toString(); })();
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: ownerRestoreUrl });
    assert.equal(m.code, 0, m.out);
    assert.doesNotMatch(m.out.replace(/already applied/g, ""), /\.sql applied/, "nothing left to migrate on the copy");
    server = await startServer({ ...env, DATABASE_URL: appRestoreUrl });
    const s = await login(server.base, idp, "supt1", { email_verified: true });
    assert.ok(s.cookie, "signed in on the restored copy");
    const r = await client(server.base, s)("GET", "/api/students");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const listed = JSON.stringify(r.body);
    assert.ok(listed.includes(ID.alice) && !listed.includes(ID.xavier), "D1 students only");
  });
});
