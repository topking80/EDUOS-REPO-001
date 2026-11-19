import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { ID, baseEnv, run, createDatabase, seed } from "./harness.js";

const PG_URL = process.env.EDUOS_TEST_PG_URL || "";
const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

test("LTI replay claims are one-time, tenant-bound, and inaccessible to the runtime table role", { skip }, async () => {
  const db = await createDatabase();
  let admin, app;
  try {
    const env = baseEnv({ EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, "https://idp.example.test");
    admin = new pg.Client(db.adminUrl); await admin.connect();
    app = new pg.Client(db.appUrl); await app.connect();

    const fn = (district, launch) => app.query(
      "SELECT eduos_lti_consume_launch($1::uuid,$2::text,$3::timestamptz) AS consumed",
      [district, launch, new Date(Date.now() + 60_000)]
    );

    // Runtime may execute the narrow function but cannot inspect or mutate its ledger.
    const privileges = await app.query(
      "SELECT has_table_privilege(current_user,'lti_launch_replays','SELECT') AS can_read, " +
      "has_table_privilege(current_user,'lti_launch_replays','INSERT') AS can_insert"
    );
    assert.equal(privileges.rows[0].can_read, false);
    assert.equal(privileges.rows[0].can_insert, false);
    await assert.rejects(() => app.query("SELECT * FROM lti_launch_replays"), { code: "42501" });

    // Tenant context is mandatory and cannot be forged by passing another district id.
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.district_id',$1,true)", [ID.d1]);
    await assert.rejects(() => fn(ID.d2, "cross-district-launch"), { code: "42501" });
    await app.query("ROLLBACK");

    // Expired-row cleanup is scoped to the caller's district only.
    const expiredD1 = "expired-d1-" + crypto.randomUUID();
    const expiredD2 = "expired-d2-" + crypto.randomUUID();
    await admin.query(
      "INSERT INTO lti_launch_replays(district_id,launch_id,expires_at,created_at) " +
      "VALUES ($1,$2,now()-interval '1 hour',now()-interval '2 hours'), " +
      "($3,$4,now()-interval '1 hour',now()-interval '2 hours')",
      [ID.d1, expiredD1, ID.d2, expiredD2]
    );

    await app.query("BEGIN");
    await app.query("SELECT set_config('app.district_id',$1,true)", [ID.d1]);
    const first = await fn(ID.d1, "single-use-launch");
    const second = await fn(ID.d1, "single-use-launch");
    assert.equal(first.rows[0].consumed, true);
    assert.equal(second.rows[0].consumed, false);
    await app.query("COMMIT");

    const remaining = await admin.query(
      "SELECT district_id,launch_id FROM lti_launch_replays WHERE launch_id=ANY($1::text[]) ORDER BY launch_id",
      [[expiredD1, expiredD2]]
    );
    assert.deepEqual(remaining.rows.map(r => r.launch_id), [expiredD2]);
    const definer = await admin.query(
      "SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner " +
      "FROM pg_proc p WHERE p.proname='eduos_lti_consume_launch'"
    );
    assert.equal(definer.rows[0].prosecdef, true);
    assert.equal(definer.rows[0].owner, db.names.owner);
  } finally {
    await app?.end();
    await admin?.end();
    await db.drop();
  }
});
