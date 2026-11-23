import test from "node:test";
import assert from "node:assert/strict";
// src/config.js requires these at import time. Use inert local defaults (as the
// session tests do) so this unit test runs without a deployment environment;
// db.js is imported afterwards so the defaults are in place first. Nothing here
// opens a database connection: every query goes through fakeClient().
process.env.DATABASE_URL ||= "postgresql://u@127.0.0.1:1/db";
process.env.PUBLIC_ORIGIN ||= "http://localhost:8080";
process.env.OIDC_ISSUER ||= "http://localhost/oidc";
process.env.OIDC_CLIENT_ID ||= "eduos-test-client";
process.env.OIDC_CLIENT_SECRET ||= "test-secret";
process.env.OIDC_REDIRECT_URI ||= "http://localhost:8080/auth/callback";
const { pool, withTenantTransaction, assertSafeRuntimeRole } = await import("../src/db.js");

function fakeClient({ failCallback = false } = {}) {
  const calls = [];
  let released = false;
  return {
    calls,
    get released() { return released; },
    async query(sql, params) {
      calls.push({ sql: String(sql).trim(), params });
      if (failCallback && String(sql).includes("CALLBACK_SENTINEL")) throw new Error("synthetic failure");
      return { rows: [], rowCount: 0 };
    },
    release() { released = true; }
  };
}

test("tenant transaction sets district, user, role and school context transaction-locally", async () => {
  const client = fakeClient();
  const original = pool.connect;
  pool.connect = async () => client;
  try {
    const result = await withTenantTransaction(
      { districtId: "district-a", userId: "user-a", role: "teacher", schoolId: "school-a" },
      async c => { await c.query("SELECT 1"); return "ok"; }
    );
    assert.equal(result, "ok");
    const context = client.calls.find(c => c.sql.includes("set_config"));
    assert.ok(context);
    assert.deepEqual(context.params, ["district-a", "user-a", "teacher", "school-a", "teacher"]);
    assert.match(context.sql, /set_config\('app\.district_id', \$1, true\)/);
    assert.ok(client.calls.some(c => c.sql === "COMMIT"));
    assert.equal(client.released, true);
  } finally { pool.connect = original; }
});

test("tenant transaction clears school context for district-level actors", async () => {
  const client = fakeClient();
  const original = pool.connect;
  pool.connect = async () => client;
  try {
    await withTenantTransaction(
      { districtId: "district-a", userId: "admin-a", role: "superintendent" },
      async () => true
    );
    const context = client.calls.find(c => c.sql.includes("set_config"));
    assert.deepEqual(context.params, ["district-a", "admin-a", "superintendent", "", "superintendent"]);
  } finally { pool.connect = original; }
});

test("tenant transaction rolls back failures and always releases the connection", async () => {
  const client = fakeClient();
  const original = pool.connect;
  pool.connect = async () => client;
  try {
    await assert.rejects(
      withTenantTransaction(
        { districtId: "district-a", userId: "user-a", role: "teacher" },
        async () => { throw new Error("operation failed"); }
      ),
      /operation failed/
    );
    assert.ok(client.calls.some(c => c.sql === "ROLLBACK"));
    assert.equal(client.calls.some(c => c.sql === "COMMIT"), false);
    assert.equal(client.released, true);
  } finally { pool.connect = original; }
});

test("tenant transaction rejects incomplete identity before acquiring a connection", async () => {
  const original = pool.connect;
  let acquired = false;
  pool.connect = async () => { acquired = true; throw new Error("should not connect"); };
  try {
    await assert.rejects(withTenantTransaction({ districtId: "district-a", role: "teacher" }, async () => {}), /requires districtId, userId, and role/);
    assert.equal(acquired, false);
  } finally { pool.connect = original; }
});

test("runtime database role guard rejects superuser, BYPASSRLS, and an owner of any schema object", async () => {
  const original = pool.query;
  try {
    for (const role of [
      { name: "root", rolsuper: true, rolbypassrls: false, owned_relations: null, owned_functions: null },
      { name: "bypass", rolsuper: false, rolbypassrls: true, owned_relations: null, owned_functions: null },
      { name: "owner", rolsuper: false, rolbypassrls: false, owned_relations: ["students"], owned_functions: null },
      // 37.7.0 audit: owning any table (not just students) or a function is refused too.
      { name: "partial", rolsuper: false, rolbypassrls: false, owned_relations: ["webhook_outbox"], owned_functions: null },
      { name: "definer", rolsuper: false, rolbypassrls: false, owned_relations: null, owned_functions: ["eduos_webhook_slot_acquire"] }
    ]) {
      pool.query = async () => ({ rows: [role] });
      await assert.rejects(assertSafeRuntimeRole(pool), /Refusing to start/);
    }
    pool.query = async () => ({ rows: [{ name: "eduos_app", rolsuper: false, rolbypassrls: false, owned_relations: null, owned_functions: null }] });
    assert.equal(await assertSafeRuntimeRole(pool), "eduos_app");
  } finally { pool.query = original; }
});

test("a vice principal's transaction runs with the principal's authority and keeps the membership role", async () => {
  const client = fakeClient();
  const original = pool.connect;
  pool.connect = async () => client;
  try {
    await withTenantTransaction({ districtId: "district-a", userId: "vp-a", role: "principal", membershipRole: "vice_principal", schoolId: "school-a" }, async () => true);
    const context = client.calls.find(c => c.sql.includes("set_config"));
    assert.match(context.sql, /set_config\('app\.membership_role', \$5, true\)/);
    assert.deepEqual(context.params, ["district-a", "vp-a", "principal", "school-a", "vice_principal"]);
  } finally { pool.connect = original; }
});
