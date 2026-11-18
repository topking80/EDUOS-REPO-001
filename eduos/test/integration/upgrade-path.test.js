// Release gate: upgrading an existing, populated database. A fresh database is
// migrated to an older release (through 040) as the non-superuser owner role,
// given that release's runtime grants and populated with data in every
// district; then the current migrator runs as the owner, exactly as in a
// production upgrade. Afterwards the runtime role must still be a non-owner
// under row-level security, no SECURITY DEFINER function may be executable by
// PUBLIC, existing rows must have been carried forward, a second run must be a
// no-op, and the API must start and serve only the caller's district.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const OLD_RELEASE_LAST = "040_external_integrations.sql";
const METRICS_TOKEN = "upgrade-metrics-token-0123456789";

async function migrationList() {
  const text = await readFile(new URL("../../src/migrate.js", import.meta.url), "utf8");
  const listed = JSON.parse(/const migrations = (\[[^\]]*\]);/.exec(text)[1]);
  // 37.6.0: after the listed 001-050, the migrator applies the numbered files in db/ in name order.
  const shipped = (await readdir(new URL("../../db/", import.meta.url))).filter(f => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return [...listed, ...shipped.filter(n => !listed.includes(n))];
}

// The older release's grants: the current template, statement by statement,
// keeping each one that applies to the older schema (statements for objects
// added later fail and are skipped, as they did not exist then).
async function applyOldGrants(owner, appRole, database) {
  const template = await readFile(new URL("../../db/runtime_grants.template.sql", import.meta.url), "utf8");
  // Same substitution as src/migrate.js (which can't be imported here: it opens the database pool).
  const sql = template.replace(/\beduos_app\b/g, appRole).replace(/\bDATABASE eduos\b/g, `DATABASE ${database}`).replace(/--[^\n]*/g, "");
  let applied = 0;
  for (const stmt of sql.split(";").map(s => s.trim()).filter(Boolean)) {
    await owner.query("SAVEPOINT g");
    try { await owner.query(stmt); applied++; await owner.query("RELEASE SAVEPOINT g"); }
    catch { await owner.query("ROLLBACK TO SAVEPOINT g"); }
  }
  return applied;
}

describe("upgrade from an older release on a populated database", { skip }, () => {
  let db, idp, env, owner, admin, server, migrations;
  const ids = {};

  before(async () => {
    migrations = await migrationList();
    const cut = migrations.indexOf(OLD_RELEASE_LAST);
    assert.ok(cut > 0 && cut < migrations.length - 1, "the older release must be strictly older than this one");
    db = await createDatabase();
    idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, METRICS_TOKEN });

    // 1. The older release, applied by the owner role (not a superuser).
    owner = new pg.Client(db.ownerUrl); await owner.connect();
    await owner.query("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const name of migrations.slice(0, cut + 1)) {
      await owner.query("BEGIN");
      await owner.query(await readFile(new URL(`../../db/${name}`, import.meta.url), "utf8"));
      await owner.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
      await owner.query("COMMIT");
    }
    await owner.query("BEGIN");
    assert.ok(await applyOldGrants(owner, db.names.app, db.names.db) > 20, "the older grants applied");
    await owner.query("COMMIT");

    // 2. Data in both districts, including queued work in each outbox.
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    const q = (sql, p) => admin.query(sql, p).then(r => r.rows);
    for (const [d, s, supt] of [["d1", "s1", "supt1"], ["d2", "sd2", "supt2"]]) {
      const [ev] = await q(`INSERT INTO flow_events(district_id,school_id,actor_user_id,actor_role,event_type,audience,source)
        VALUES($1,$2,$3,'superintendent','attendance.recorded',ARRAY['principal'],'server') RETURNING id`, [ID[d], ID[s], USERS[supt][0]]);
      const [sub] = await q(`INSERT INTO webhook_subscriptions(district_id,created_by,url,event_types)
        VALUES($1,$2,'https://hooks.example.test/in',ARRAY['attendance.recorded']) RETURNING id`, [ID[d], USERS[supt][0]]);
      ids[d] = { ev: ev.id, sub: sub.id };
    }
    // D1: one job due for ten minutes. D2: one dead letter.
    await q(`INSERT INTO webhook_outbox(district_id,subscription_id,event_id,event_type,payload,available_at,created_at)
      VALUES($1,$2,$3,'attendance.recorded','{"k":"v"}',now()-interval '10 minutes',now()-interval '10 minutes')`, [ID.d1, ids.d1.sub, ids.d1.ev]);
    await q(`INSERT INTO webhook_outbox(district_id,subscription_id,event_id,event_type,payload,status,attempts,completed_at)
      VALUES($1,$2,$3,'attendance.recorded','{"k":"v"}','dead_letter',5,now())`, [ID.d2, ids.d2.sub, ids.d2.ev]);
    const t1 = USERS.t1[0];
    const [pending] = await q(`INSERT INTO notification_outbox(district_id,recipient_user_id,channel,kind,title,created_at)
      VALUES($1,$2,'email','announcement','Pending email',now()-interval '5 minutes') RETURNING id`, [ID.d1, t1]);
    const [skipped] = await q(`INSERT INTO notification_outbox(district_id,recipient_user_id,channel,kind,title,status,delivered_at)
      VALUES($1,$2,'sms','announcement','Skipped sms','skipped',now()-interval '1 hour') RETURNING id`, [ID.d1, t1]);
    await q(`INSERT INTO notification_outbox(district_id,recipient_user_id,channel,kind,title)
      VALUES($1,$2,'in_app','announcement','In-app note')`, [ID.d1, t1]);
    ids.pending = pending.id; ids.skipped = skipped.id;
  });
  after(async () => { await server?.stop(); await owner?.end(); await admin?.end(); await idp?.close(); await db?.drop?.(); });

  it("the current migrator upgrades it as the owner role, applying only the newer migrations", async () => {
    const r = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(r.code, 0, r.out);
    const cut = migrations.indexOf(OLD_RELEASE_LAST);
    for (const name of migrations.slice(0, cut + 1)) assert.match(r.out, new RegExp(`${name} already applied`));
    for (const name of migrations.slice(cut + 1)) assert.match(r.out, new RegExp(`${name} applied`));
    assert.match(r.out, /runtime grants applied/);
    const names = (await admin.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map(x => x.name);
    assert.deepEqual(names, [...migrations].sort());
  });

  it("existing rows are carried forward by the data migrations", async () => {
    const { rows: [s] } = await admin.query("SELECT status,delivered_at,last_attempt_at FROM notification_outbox WHERE id=$1", [ids.skipped]);
    assert.equal(s.status, "skipped");
    assert.equal(s.delivered_at, null, "a skipped send no longer claims delivery");
    assert.ok(s.last_attempt_at, "its attempt time is kept");
    const { rows: [p] } = await admin.query("SELECT status,lease_token FROM notification_outbox WHERE id=$1", [ids.pending]);
    assert.deepEqual(p, { status: "pending", lease_token: null });
    // Students that existed before the redaction index (043) are in it, in
    // both districts, so their names are caught before text leaves for an AI provider.
    const indexed = (await admin.query("SELECT DISTINCT student_id FROM student_redact_tokens WHERE kind='name'")).rows.map(r => r.student_id);
    for (const id of [ID.alice, ID.bob, ID.carol, ID.xavier]) assert.ok(indexed.includes(id), `student ${id} is in the redaction index`);
  });

  it("the runtime role stays a non-owner under row-level security", async () => {
    const app = db.names.app;
    const { rows: [role] } = await admin.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1", [app]);
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
    const owned = await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tableowner=$1", [app]);
    assert.deepEqual(owned.rows, [], "the runtime role owns no table");
    const unprotected = await admin.query(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r'
         AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='district_id' AND NOT a.attisdropped)
         AND NOT (c.relrowsecurity AND c.relforcerowsecurity) ORDER BY 1`);
    // Sign-in tables are read before any district is known. The four commerce
    // tables also intentionally have ENABLED (but not FORCE) RLS: only the
    // migration-owned, narrowly scoped SECURITY DEFINER webhook functions may
    // bypass tenant policies. The runtime role remains a non-owner and is
    // therefore still subject to those policies. Any additional exception is
    // a regression.
    assert.deepEqual(unprotected.rows.map(r => r.relname), [
      "commerce_payments", "commerce_provider_accounts",
      "commerce_webhook_endpoints", "commerce_webhook_events",
      "district_users", "memberships", "native_login_handoffs", "sessions"
    ], "only sign-in tables and the four scoped commerce definer tables may omit FORCE RLS");
    const lateRefundRls = await admin.query(`
      SELECT c.relrowsecurity,c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname='commerce_webhook_refund_cases'`);
    assert.deepEqual(
      [lateRefundRls.rows[0]?.relrowsecurity, lateRefundRls.rows[0]?.relforcerowsecurity],
      [true, true],
      "late-capture refund cases remain tenant-scoped under the runtime role"
    );
    const webhookStateCheck = await admin.query(`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid='public.commerce_webhook_events'::regclass
         AND conname='commerce_webhook_events_state_check'`);
    assert.match(webhookStateCheck.rows[0].definition, /dead_letter/,
      "retry exhaustion has an explicit terminal inbox state");
    const webhookTerminalCheck = await admin.query(`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid='public.commerce_webhook_events'::regclass
         AND conname='commerce_webhook_events_terminal_timestamp_check'`);
    assert.match(webhookTerminalCheck.rows[0].definition, /dead_letter/,
      "dead letters carry a terminal processed timestamp");
    const webhookGuard = await admin.query(
      "SELECT pg_get_functiondef('public.eduos_commerce_webhook_event_guard()'::regprocedure) AS definition");
    assert.match(webhookGuard.rows[0].definition, /dead_letter/,
      "the event guard permits only the explicit terminal transition");
    const webhookClaim = await admin.query(
      "SELECT pg_get_functiondef('public.eduos_commerce_claim_webhook()'::regprocedure) AS definition");
    assert.match(webhookClaim.rows[0].definition, /attempts < 20/,
      "dead-lettered events cannot be claimed again");
    assert.match(webhookClaim.rows[0].definition, /payer_actor IS NULL/,
      "events without a saved payer actor are terminally closed, never settled as an invented user");
    assert.match(webhookClaim.rows[0].definition, /missing_payer_actor/,
      "missing payer identity is visible to operators");
    assert.match(webhookClaim.rows[0].definition, /claimed_at IS NULL OR/,
      "orphaned processing leases with no timestamp can be recovered safely");
    const publicDefiner = await admin.query(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.prosecdef
         AND EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     WHERE a.grantee=0 AND a.privilege_type='EXECUTE')`);
    assert.deepEqual(publicDefiner.rows, [], "no SECURITY DEFINER function is executable by PUBLIC");
    // EDUOS-DB-01: every helper function a row-level security policy calls is
    // executable by the runtime role (otherwise its queries would fail), and
    // the role has EXECUTE only where the grants template gives it: no
    // EduOS function is left executable by PUBLIC.
    const policyHelpers = await admin.query(`
      SELECT DISTINCT p.proname, has_function_privilege($1, p.oid, 'EXECUTE') AS runtime
        FROM pg_depend d JOIN pg_policy pol ON d.classid='pg_policy'::regclass AND d.objid=pol.oid
        JOIN pg_proc p ON d.refclassid='pg_proc'::regclass AND d.refobjid=p.oid
        JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 1`, [app]);
    assert.ok(policyHelpers.rowCount >= 5, `found the policy helpers (${policyHelpers.rowCount})`);
    assert.deepEqual(policyHelpers.rows.filter(r => !r.runtime).map(r => r.proname), [], "every policy helper is executable by the runtime role");
    const publicAny = await admin.query(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                           WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
         -- Extension functions (pgcrypto) belong to the superuser and run as the caller.
         AND NOT EXISTS(SELECT 1 FROM pg_depend e WHERE e.classid='pg_proc'::regclass AND e.objid=p.oid AND e.deptype='e')`);
    assert.deepEqual(publicAny.rows, [], "no EduOS function is executable by PUBLIC");

    const c = new pg.Client(db.appUrl); await c.connect();
    try {
      assert.equal((await c.query("SELECT count(*)::int AS n FROM students")).rows[0].n, 0, "no tenant context, no rows");
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.district_id',$1,true)", [ID.d1]);
      const visible = (await c.query("SELECT id FROM students ORDER BY id")).rows.map(x => x.id);
      assert.ok(visible.length > 0 && !visible.includes(ID.xavier), "only the district's own students");
      await assert.rejects(c.query("DELETE FROM audit_events"), /permission denied/);
      await c.query("ROLLBACK");
    } finally { await c.end(); }
  });

  it("the runtime role can read the queue backlog: totals across districts, and its tenant setting is left alone", async () => {
    const c = new pg.Client(db.appUrl); await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.district_id',$1,true)", [ID.d2]);
      const rows = (await c.query("SELECT queue,state,jobs::int,oldest_seconds FROM eduos_queue_backlog()")).rows;
      const get = (queue, state) => rows.find(r => r.queue === queue && r.state === state);
      assert.equal(get("webhook", "ready").jobs, 1);
      assert.ok(get("webhook", "ready").oldest_seconds >= 590, "age of the job due for ten minutes");
      assert.equal(get("webhook", "dead_letter").jobs, 1, "counted from the other district too");
      assert.equal(get("notification", "ready").jobs, 1, "the pending email, not the in-app note");
      assert.ok(get("notification", "ready").oldest_seconds >= 290);
      assert.equal(get("notification", "failed").jobs, 0);
      assert.deepEqual(Object.keys(rows[0]).sort(), ["jobs", "oldest_seconds", "queue", "state"], "aggregates only");
      assert.equal((await c.query("SELECT current_setting('app.district_id',true) AS d")).rows[0].d, ID.d2, "caller's tenant restored");
      await c.query("ROLLBACK");
    } finally { await c.end(); }
  });

  it("running the migrator again changes nothing", async () => {
    const r = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out.replace(/already applied/g, ""), /\.sql applied/);
  });

  it("the API starts on the upgraded database, serves only the caller's district, and reports the backlog", async () => {
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    const s = await login(server.base, idp, "supt1", { email_verified: true });
    assert.ok(s.cookie, "signed in");
    const r = await client(server.base, s)("GET", "/api/students");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const listed = JSON.stringify(r.body);
    assert.ok(listed.includes(ID.alice) && !listed.includes(ID.xavier), "D1 students only");

    const m = await fetch(`${server.base}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    assert.equal(m.status, 200);
    const text = await m.text();
    assert.match(text, /^eduos_queue_backlog_up 1$/m);
    assert.match(text, /^eduos_queue_jobs\{queue="webhook",state="ready"\} 1$/m);
    assert.match(text, /^eduos_queue_jobs\{queue="webhook",state="dead_letter"\} 1$/m);
    assert.match(text, /^eduos_queue_jobs\{queue="notification",state="ready"\} 1$/m);
    assert.match(text, /^eduos_queue_oldest_ready_seconds\{queue="webhook"\} \d+$/m);
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-/, "no ids of any kind in the metrics");
  });
});
