// 37.7.0 audit hardening: regression tests for the 2026-11-17 third-party audit of main
// 546d2da, against real PostgreSQL as the NON-OWNER runtime role (the API is a
// child process on the runtime role; in-process workers use the same role).
// Every receiver is a loopback server in this process: no external network.
// Run: EDUOS_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres node --test test/integration/audit-hardening.test.js
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { PG_URL, ID, USERS, baseEnv, run, createDatabase, seed, startIdp, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const SIGNING_KEY = "w".repeat(40);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (check, ms) => { const end = Date.now() + ms; while (!(await check()) && Date.now() < end) await sleep(25); return check(); };
const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => "timed_out")]);

/** Loopback receiver. mode "ok" answers 204; "trickle" sends 200 then one byte per 100 ms forever. */
async function receiver(mode = "ok") {
  const state = { hits: 0, open: 0, closed: 0, sockets: new Set(), timers: new Set() };
  const server = http.createServer((req, res) => {
    state.hits += 1; state.open += 1;
    res.on("close", () => { state.open -= 1; state.closed += 1; });
    req.resume();
    if (mode === "ok") return req.on("end", () => { res.writeHead(204); res.end(); });
    res.writeHead(200, { "transfer-encoding": "chunked" });
    const t = setInterval(() => res.write("."), 100); state.timers.add(t);
    res.on("close", () => clearInterval(t));
  });
  server.on("connection", s => { state.sockets.add(s); s.on("close", () => state.sockets.delete(s)); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  state.url = `http://127.0.0.1:${server.address().port}/hook`;
  state.close = () => { for (const t of state.timers) clearInterval(t); for (const s of state.sockets) s.destroy(); return new Promise(r => server.close(r)); };
  return state;
}

describe("37.7.0 audit hardening (runtime role, real PostgreSQL)", { skip }, () => {
  let db, admin, idp, api, pool, withTenantTransaction, assertSafeRuntimeRole, outbox;
  const supt1 = { districtId: ID.d1, userId: USERS.supt1[0], role: "superintendent", schoolId: null };
  const receivers = [];

  const subscription = async url => (await admin.query(`INSERT INTO webhook_subscriptions(district_id,created_by,url,event_types)
    VALUES($1,$2,$3,ARRAY['*']) RETURNING id`, [ID.d1, USERS.supt1[0], url])).rows[0].id;
  async function job(sub) {
    const ev = (await admin.query(`INSERT INTO flow_events(district_id,actor_user_id,actor_role,event_type,audience,source)
      VALUES($1,$2,'superintendent','pupil.enrolled',ARRAY['superintendent'],'server') RETURNING id`, [ID.d1, USERS.supt1[0]])).rows[0].id;
    return (await admin.query(`INSERT INTO webhook_outbox(district_id,subscription_id,event_id,event_type,payload,max_attempts)
      VALUES($1,$2,$3,'pupil.enrolled','{"type":"pupil.enrolled"}'::jsonb,5) RETURNING id`, [ID.d1, sub, ev])).rows[0].id;
  }
  const row = async id => (await admin.query("SELECT status,attempts,lease_token,last_outcome,last_error FROM webhook_outbox WHERE id=$1", [id])).rows[0];
  // Start every test from an empty queue and no active subscriptions.
  const reset = async () => {
    await admin.query("UPDATE webhook_outbox SET status='cancelled',lease_until=NULL,lease_token=NULL WHERE status IN ('pending','processing')");
    await admin.query("UPDATE webhook_subscriptions SET status='disabled',disabled_at=now() WHERE status='active'");
    await admin.query("DELETE FROM district_settings WHERE district_id=$1", [ID.d1]).catch(() => {});
    await admin.query("DELETE FROM webhook_delivery_slots").catch(() => {});
  };
  const work = (deps = {}) => outbox.processWebhookOutbox(supt1, { limit: 10 }, {
    withTenantTransaction, signingKey: SIGNING_KEY, log: { error: () => {}, warn: () => {} },
    deliveryOptions: { allowInsecureLoopback: true, sleep: async () => {} }, ...deps
  });

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    // The API on the runtime role; the scheduled sweep is OFF so the only way
    // a delivery can start is a request (that's what finding 2 is about).
    api = await startServer({ ...env, DATABASE_URL: db.appUrl, WEBHOOK_SIGNING_KEY: SIGNING_KEY,
      WEBHOOK_ALLOW_INSECURE_LOOPBACK: "true", WEBHOOK_DISPATCH_INTERVAL_SECONDS: "0" });
    Object.assign(process.env, { ...env, DATABASE_URL: db.appUrl });
    ({ pool, withTenantTransaction, assertSafeRuntimeRole } = await import("../../src/db.js"));
    outbox = await import("../../src/webhook-outbox.js");
    assert.equal((await pool.query("SELECT current_user AS u")).rows[0].u, db.names.app, "in-process code runs as the runtime role");
  });
  after(async () => {
    await api?.stop(); await idp?.close();
    for (const r of receivers) await r.close();
    await pool?.end(); await admin?.end(); await db?.drop?.();
  });

  it("finding 1: a trickling receiver can't outlive the job deadline; the socket is destroyed and the slot freed", async () => {
    await reset();
    const rx = await receiver("trickle"); receivers.push(rx);
    const j = await job(await subscription(rx.url));
    const limiter = outbox.createLimiter(2);
    const started = Date.now();
    // Per-attempt timeout far beyond the job deadline: only the deadline can stop it.
    const claimed = await within(work({ limiter, leaseSeconds: 4, jobDeadlineMs: 500,
      deliveryOptions: { allowInsecureLoopback: true, timeoutMs: 60_000, sleep: async () => {} } }), 6000);
    assert.equal(claimed, 1, "the worker returned");
    assert.ok(Date.now() - started < 4000, `returned after ${Date.now() - started} ms`);
    assert.equal(rx.hits, 1);
    assert.ok(await until(() => rx.open === 0, 1000), "the receiver's connection was closed by the worker");
    assert.equal(limiter.active, 0, "the in-process slot is free");
    const r = await row(j);
    assert.deepEqual([r.status, r.attempts, r.last_outcome, r.last_error], ["pending", 1, "timeout", "job_deadline"]);
  });

  it("finding 2: reading GET /api/flow-events starts no outbound delivery", async () => {
    await reset();
    const rx = await receiver("ok"); receivers.push(rx);
    const j = await job(await subscription(rx.url));
    const supt = client(api.base, await login(api.base, idp, "supt1", { email_verified: true }));
    for (let i = 0; i < 3; i++) assert.equal((await supt("GET", "/api/flow-events")).status, 200);
    await sleep(1500);
    assert.equal(rx.hits, 0, "no request reached the receiver");
    const r = await row(j);
    assert.deepEqual([r.status, r.attempts, r.lease_token], ["pending", 0, null], "the job was not claimed");
  });

  it("finding 3: concurrent registrations of one URL create exactly one subscription", async () => {
    await reset();
    const supt = client(api.base, await login(api.base, idp, "supt1", { email_verified: true }));
    const url = `http://127.0.0.1:9999/race-${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 8 }, () => supt("POST", "/api/webhooks", { url, eventTypes: ["assignment.created"] })));
    const codes = results.map(r => r.status).sort();
    assert.deepEqual(codes, [201, 409, 409, 409, 409, 409, 409, 409], JSON.stringify(results.map(r => [r.status, r.body?.error])));
    assert.ok(results.filter(r => r.status === 409).every(r => r.body.error === "webhook_already_registered"));
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM webhook_subscriptions WHERE url=$1 AND status='active'", [url])).rows[0].n, 1);
  });

  it("finding 3: the database itself rejects a duplicate active URL from the runtime role", async () => {
    await reset();
    const url = `http://127.0.0.1:9999/direct-${Date.now()}`;
    const insert = () => withTenantTransaction(supt1, c => c.query(
      "INSERT INTO webhook_subscriptions(district_id,created_by,url,event_types) VALUES($1,$2,$3,ARRAY['*'])", [ID.d1, USERS.supt1[0], url]));
    await insert();
    await assert.rejects(insert(), e => e.code === "23505" && e.constraint === "webhook_subscriptions_active_url");
  });

  it("finding 3: concurrent registrations can't exceed max_active_webhooks", async () => {
    await reset();
    await admin.query(`INSERT INTO district_settings(district_id,max_active_webhooks) VALUES($1,2)
      ON CONFLICT (district_id) DO UPDATE SET max_active_webhooks=2`, [ID.d1]);
    const supt = client(api.base, await login(api.base, idp, "supt1", { email_verified: true }));
    const stamp = Date.now();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      supt("POST", "/api/webhooks", { url: `http://127.0.0.1:9999/cap-${stamp}-${i}`, eventTypes: ["assignment.created"] })));
    assert.equal(results.filter(r => r.status === 201).length, 2, JSON.stringify(results.map(r => [r.status, r.body?.error])));
    assert.ok(results.filter(r => r.status !== 201).every(r => r.status === 409 && r.body.error === "webhook_limit_reached"));
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM webhook_subscriptions WHERE district_id=$1 AND status='active'", [ID.d1])).rows[0].n, 2);
    // And a direct insert past the cap, bypassing the API, is refused by PostgreSQL.
    await assert.rejects(withTenantTransaction(supt1, c => c.query(
      "INSERT INTO webhook_subscriptions(district_id,created_by,url,event_types) VALUES($1,$2,$3,ARRAY['*'])",
      [ID.d1, USERS.supt1[0], `http://127.0.0.1:9999/cap-${stamp}-direct`])), e => e.code === "23514" && e.constraint === "webhook_subscriptions_district_cap");
  });

  it("finding 4: the flow event and its outbox jobs commit with the assignment, or not at all", async () => {
    await reset();
    await subscription(`http://127.0.0.1:9999/flow-${Date.now()}`);
    const teacher = client(api.base, await login(api.base, idp, "t1", { email_verified: true }));
    // Make the flow_events insert fail (as the admin; removed below).
    await admin.query(`CREATE FUNCTION it_fail_flow() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'flow store down'; END $$`);
    await admin.query("CREATE TRIGGER it_fail_flow BEFORE INSERT ON flow_events FOR EACH ROW EXECUTE FUNCTION it_fail_flow()");
    try {
      const failed = await teacher("POST", "/api/assignments", { title: "Lost event check", status: "published" });
      assert.equal(failed.status, 500, "the request fails when its event can't be recorded");
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM assignments WHERE title='Lost event check'")).rows[0].n, 0,
        "no assignment without its event");
    } finally {
      await admin.query("DROP TRIGGER it_fail_flow ON flow_events"); await admin.query("DROP FUNCTION it_fail_flow()");
    }
    const ok = await teacher("POST", "/api/assignments", { title: "Event committed check", status: "published" });
    assert.equal(ok.status, 201);
    // Present the moment the response arrives: same transaction, not after it.
    const ev = (await admin.query("SELECT id FROM flow_events WHERE event_type='assignment.created' AND refs->>'resource'=$1", [ok.body.data.id])).rows;
    assert.equal(ev.length, 1, "the event committed with the assignment");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM webhook_outbox WHERE event_id=$1", [ev[0].id])).rows[0].n, 1, "and its outbox job");
  });

  it("finding 5: replicas sharing the database never exceed the global ceiling", async () => {
    await reset();
    const rx = await receiver("ok"); receivers.push(rx);
    const sub = await subscription(rx.url);
    const jobs = []; for (let i = 0; i < 8; i++) jobs.push(await job(sub));
    let inFlight = 0, peak = 0, sent = 0;
    const deliver = async () => { inFlight += 1; peak = Math.max(peak, inFlight); await sleep(150); inFlight -= 1; sent += 1;
      return [{ attempt: 1, outcome: "delivered", statusCode: 204, durationMs: 150 }]; };
    // Two "replicas": separate in-process limiters of 2, one shared ceiling of 2.
    const replica = () => ({ limiter: outbox.createLimiter(2), globalSlots: outbox.createGlobalSlots(pool, 2, { leaseSeconds: 60 }), deliver });
    const a = replica(), b = replica();
    for (let round = 0; round < 12 && sent < 8; round++) {
      await Promise.all([work(a), work(b), work(a), work(b)]);
      await admin.query("UPDATE webhook_outbox SET available_at=now() WHERE status='pending'");
    }
    assert.equal(sent, 8, "every job was eventually delivered");
    assert.ok(peak <= 2, `peak in flight across both replicas was ${peak}; the ceiling is 2`);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM webhook_delivery_slots")).rows[0].n, 0, "every slot was released");
    const states = (await admin.query("SELECT status,count(*)::int AS n FROM webhook_outbox WHERE id=ANY($1) GROUP BY status", [jobs])).rows;
    assert.deepEqual(states, [{ status: "delivered", n: 8 }]);
    const attempts = (await admin.query("SELECT max(attempts)::int AS n FROM webhook_outbox WHERE id=ANY($1)", [jobs])).rows[0].n;
    assert.equal(attempts, 1, "a job handed back for want of a slot didn't use up an attempt");
  });

  it("finding 5: with every global slot taken, a worker claims nothing", async () => {
    await reset();
    const j = await job(await subscription(`http://127.0.0.1:9999/full-${Date.now()}`));
    const slots = outbox.createGlobalSlots(pool, 2, { leaseSeconds: 60 });
    const held = [await slots.acquire(), await slots.acquire()];
    assert.ok(held.every(Boolean)); assert.equal(await slots.acquire(), null, "a third slot is refused");
    let calls = 0;
    try {
      assert.equal(await work({ globalSlots: slots, limiter: outbox.createLimiter(4), deliver: async () => { calls += 1; return [{ attempt: 1, outcome: "delivered", statusCode: 204, durationMs: 1 }]; } }), 0);
      assert.equal(calls, 0);
      const r = await row(j); assert.deepEqual([r.status, r.attempts, r.lease_token], ["pending", 0, null]);
    } finally { for (const h of held) await slots.release(h); }
    // The runtime role can only use the slot functions, never the table.
    await assert.rejects(pool.query("SELECT * FROM webhook_delivery_slots"), e => e.code === "42501");
    await assert.rejects(pool.query("DELETE FROM webhook_delivery_slots"), e => e.code === "42501");
  });

  it("finding 6: zero free in-process slots means zero claims", async () => {
    await reset();
    const j = await job(await subscription(`http://127.0.0.1:9999/busy-${Date.now()}`));
    const limiter = outbox.createLimiter(1);
    let release; const busy = limiter.run(() => new Promise(r => { release = r; }));
    try {
      const claimed = await within(work({ limiter, deliver: async () => [{ attempt: 1, outcome: "delivered", statusCode: 204, durationMs: 1 }] }), 2000);
      assert.equal(claimed, 0, "nothing claimed while the only slot is busy");
      const r = await row(j); assert.deepEqual([r.status, r.lease_token], ["pending", null]);
    } finally { release(); await busy; }
  });

  it("finding 7: the runtime role guard refuses a role that owns ANY schema object, not just students", async () => {
    assert.equal(await assertSafeRuntimeRole(pool), db.names.app, "the dedicated runtime role passes");
    await admin.query(`ALTER TABLE webhook_outbox OWNER TO ${db.names.app}`);
    try {
      await assert.rejects(assertSafeRuntimeRole(pool), /owns EduOS schema objects \(webhook_outbox\)/);
    } finally { await admin.query(`ALTER TABLE webhook_outbox OWNER TO ${db.names.owner}`); }
    await admin.query(`GRANT ${db.names.owner} TO ${db.names.app}`);
    try {
      await assert.rejects(assertSafeRuntimeRole(pool), /owns EduOS schema objects/, "membership in the owner role counts as owning");
    } finally { await admin.query(`REVOKE ${db.names.owner} FROM ${db.names.app}`); }
    assert.equal(await assertSafeRuntimeRole(pool), db.names.app);
  });
});
