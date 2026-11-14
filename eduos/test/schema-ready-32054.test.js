// 32.0.54: the API refuses to start against an unmigrated or partially
// migrated database (stub db here; real PostgreSQL in test/integration).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const env = {
  DATABASE_URL: "postgresql://eduos_app:x@127.0.0.1:1/eduos", PUBLIC_ORIGIN: "http://localhost:8080",
  OIDC_ISSUER: "http://idp.test/t", OIDC_CLIENT_ID: "x", OIDC_CLIENT_SECRET: "x",
  OIDC_REDIRECT_URI: "http://localhost:8080/auth/callback"
};
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;
const { assertSchemaReady, shippedMigrations } = await import("../src/db.js");

const stub = (reg, names, err) => ({
  async query(sql) {
    if (sql.includes("to_regclass")) return { rows: [{ reg }] };
    if (err) throw err;
    return { rows: names.map(name => ({ name })) };
  }
});

test("shipped migrations match the migrator's ordered list", async () => {
  const runner = await readFile(new URL("../src/migrate.js", import.meta.url), "utf8");
  const listed = JSON.parse(runner.match(/const migrations = (\[[^\]]+\])/)[1]);
  assert.deepEqual(await shippedMigrations(), listed);
});

test("refuses a database without schema_migrations", async () => {
  await assert.rejects(assertSchemaReady(stub(null, [])), /not migrated.*npm run db:migrate/);
});

test("refuses a database with a missing migration", async () => {
  const all = await shippedMigrations();
  await assert.rejects(assertSchemaReady(stub("schema_migrations", all.slice(0, -1))),
    new RegExp(`1 migration\\(s\\) not applied \\(${all.at(-1).replace(".", "\\.")}\\)`));
});

test("explains missing grants on schema_migrations", async () => {
  await assert.rejects(assertSchemaReady(stub("schema_migrations", [], Object.assign(new Error("denied"), { code: "42501" }))),
    /grants are out of date/);
});

test("accepts a fully migrated database", async () => {
  const all = await shippedMigrations();
  assert.equal(await assertSchemaReady(stub("schema_migrations", all)), all.length);
});
