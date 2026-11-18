import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { run, createDatabase } from "./harness.js";

const PG_URL = process.env.EDUOS_TEST_PG_URL || "";
const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

test("webhook SECURITY DEFINER entry points work while runtime remains RLS-scoped", { skip }, async t => {
  const db = await createDatabase();
  let admin, app;
  try {
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development",
      EDUOS_APP_ROLE: db.names.app
    };
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    app = new pg.Client(db.appUrl); await app.connect();

    const policies = (await admin.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             pg_get_userbyid(c.relowner) AS owner,
             p.prosecdef, pg_get_userbyid(p.proowner) AS function_owner
        FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
        JOIN pg_proc p ON p.pronamespace=n.oid
       WHERE c.relname IN ('commerce_webhook_endpoints','commerce_provider_accounts',
                           'commerce_payments','commerce_webhook_events')
         AND p.proname IN ('eduos_commerce_webhook_account','eduos_commerce_receive_webhook',
                           'eduos_commerce_claim_webhook')
       ORDER BY c.relname, p.proname
    `)).rows;
    assert.ok(policies.length >= 6, JSON.stringify(policies));
    for (const row of policies) {
      assert.equal(row.relrowsecurity, true, row.relname);
      assert.equal(row.relforcerowsecurity, false, row.relname);
      assert.equal(row.owner, db.names.owner, row.relname);
      assert.equal(row.prosecdef, true, row.relname);
      assert.equal(row.function_owner, db.names.owner, row.relname);
    }

    // Runtime has no tenant GUC and is not the owner: ordinary reads stay empty.
    const rls = await app.query("SELECT row_security_active('commerce_webhook_events') AS active");
    assert.equal(rls.rows[0].active, true);
    const visible = await app.query("SELECT count(*)::int AS n FROM commerce_webhook_events");
    assert.equal(visible.rows[0].n, 0);
    // These narrow SECURITY DEFINER functions can now resolve safely without a
    // user session or tenant GUC; unknown tokens and empty queues are harmless.
    const account = await app.query("SELECT count(*)::int AS n FROM eduos_commerce_webhook_account($1)", ["a".repeat(64)]);
    assert.equal(account.rows[0].n, 0);
    const receive = await app.query(
      "SELECT eduos_commerce_receive_webhook($1,'paypal','evt_1234','PAYMENT.CAPTURE.COMPLETED',$2,'order_1234','capture_1234',100,'USD') AS outcome",
      ["a".repeat(64), "b".repeat(64)]
    );
    assert.equal(receive.rows[0].outcome, "endpoint_not_found");
    const claim = await app.query("SELECT eduos_commerce_claim_webhook() AS event");
    assert.equal(claim.rows[0].event, null);
  } finally {
    await app?.end();
    await admin?.end();
    await db.drop();
  }
});
