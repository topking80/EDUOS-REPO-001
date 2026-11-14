// Audit 37.4.0 item 7: durable webhook outbox worker lifecycle against real
// PostgreSQL, as the non-owner runtime role. Network delivery is injected
// (lookup/send), so DNS failures and receiver errors are deterministic.
// Run: EDUOS_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres npm run test:integration
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, baseEnv, run, createDatabase, seed } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const SIGNING_KEY = "w".repeat(40);
const PUBLIC_IP = [{ address: "93.184.216.34", family: 4 }];

describe("37.4.0 webhook outbox lifecycle against real PostgreSQL", { skip }, () => {
  let db, admin, pool, withTenantTransaction, processWebhookOutbox, WEBHOOK_DISABLE_AFTER_FAILURES;
  const supt1 = { districtId: ID.d1, userId: USERS.supt1[0], role: "superintendent", schoolId: null };
  const supt2 = { districtId: ID.d2, userId: USERS.supt2[0], role: "superintendent", schoolId: null };

  // One worker run. `lookup` and `send` replace DNS and HTTP; everything else is the real code.
  const work = (actor, { lookup = async () => PUBLIC_IP, send, limit = 10 } = {}) =>
    processWebhookOutbox(actor, { limit }, {
      withTenantTransaction, signingKey: SIGNING_KEY,
      deliveryOptions: { lookup, send, sleep: async () => {} },
      log: { error: () => {} }
    });
  const delivered = async () => ({ outcome: "delivered", statusCode: 204, durationMs: 1 });

  async function subscription({ failureCount = 0, district = ID.d1, creator = USERS.supt1[0] } = {}) {
    return (await admin.query(`INSERT INTO webhook_subscriptions(district_id,created_by,url,event_types,failure_count)
      VALUES($1,$2,'https://hooks.example.test/events',ARRAY['*'],$3) RETURNING id`, [district, creator, failureCount])).rows[0].id;
  }
  async function job(sub, { maxAttempts = 5, district = ID.d1, actor = USERS.supt1[0] } = {}) {
    const ev = (await admin.query(`INSERT INTO flow_events(district_id,actor_user_id,actor_role,event_type,audience,source)
      VALUES($1,$2,'superintendent','pupil.enrolled',ARRAY['superintendent'],'server') RETURNING id`, [district, actor])).rows[0].id;
    return (await admin.query(`INSERT INTO webhook_outbox(district_id,subscription_id,event_id,event_type,payload,max_attempts)
      VALUES($1,$2,$3,'pupil.enrolled','{"type":"pupil.enrolled"}'::jsonb,$4) RETURNING id,delivery_id`, [district, sub, ev, maxAttempts])).rows[0];
  }
  const outbox = async id => (await admin.query("SELECT * FROM webhook_outbox WHERE id=$1", [id])).rows[0];
  const sub = async id => (await admin.query("SELECT status,failure_count,last_outcome,disabled_at FROM webhook_subscriptions WHERE id=$1", [id])).rows[0];
  const ledger = async deliveryId => (await admin.query("SELECT attempt,outcome,status_code FROM webhook_deliveries WHERE delivery_id=$1 ORDER BY attempt", [deliveryId])).rows;
  const makeDue = id => admin.query("UPDATE webhook_outbox SET available_at=now() WHERE id=$1", [id]);
  // Each test starts from a clean queue so claims are predictable.
  const clearQueue = () => admin.query("UPDATE webhook_outbox SET status='cancelled',lease_until=NULL,lease_token=NULL WHERE status IN ('pending','processing')");

  before(async () => {
    db = await createDatabase();
    const env = baseEnv({ EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, "http://127.0.0.1:9");
    admin = new pg.Client(db.adminUrl); await admin.connect();
    // The worker runs in this process as the runtime role, exactly as the API does.
    Object.assign(process.env, { ...env, DATABASE_URL: db.appUrl });
    ({ pool, withTenantTransaction } = await import("../../src/db.js"));
    ({ processWebhookOutbox } = await import("../../src/webhook-outbox.js"));
    ({ WEBHOOK_DISABLE_AFTER_FAILURES } = await import("../../src/webhooks.js"));
  });
  after(async () => { await pool?.end(); await admin?.end(); await db?.drop?.(); });

  it("a DNS outage is retried on a later run and then delivered with the same delivery id", async () => {
    await clearQueue();
    const s = await subscription(), j = await job(s);
    let lookups = 0;
    const flakyDns = async () => { lookups += 1; if (lookups === 1) throw new Error("EAI_AGAIN"); return PUBLIC_IP; };
    let sends = 0; const send = async req => { sends += 1; assert.equal(req.headers["X-EduOS-Delivery"], j.delivery_id); return delivered(); };

    assert.equal(await work(supt1, { lookup: flakyDns, send }), 1);
    let row = await outbox(j.id);
    assert.equal(row.status, "pending", "transient DNS failure is not a dead letter");
    assert.equal(row.attempts, 1); assert.equal(row.last_outcome, "network_error"); assert.equal(row.last_error, "dns_failure");
    assert.equal(row.lease_token, null);
    const wait = (row.available_at - row.updated_at) / 1000;
    assert.ok(wait >= 14 && wait <= 16, `first retry is backed off ~15 s, got ${wait}`);
    assert.equal(sends, 0);
    assert.equal(await work(supt1, { lookup: flakyDns, send }), 0, "not due yet");

    await makeDue(j.id);
    assert.equal(await work(supt1, { lookup: flakyDns, send }), 1);
    row = await outbox(j.id);
    assert.equal(row.status, "delivered"); assert.equal(row.attempts, 2); assert.ok(row.completed_at);
    assert.equal(sends, 1);
    assert.deepEqual((await ledger(j.delivery_id)).map(x => [x.attempt, x.outcome]), [[1, "network_error"], [2, "delivered"]]);
    assert.deepEqual(await sub(s).then(x => [x.failure_count, x.last_outcome]), [0, "delivered"], "success resets the failure count");
  });

  it("retries back off exponentially and exhaust into dead_letter at max_attempts", async () => {
    await clearQueue();
    const s = await subscription(), j = await job(s, { maxAttempts: 3 });
    const failing = async () => ({ outcome: "http_error", statusCode: 503, durationMs: 1 });
    const waits = [];
    for (let i = 1; i <= 3; i++) {
      await makeDue(j.id);
      assert.equal(await work(supt1, { send: failing }), 1);
      const row = await outbox(j.id);
      assert.equal(row.attempts, i);
      if (i < 3) { assert.equal(row.status, "pending"); waits.push(Math.round((row.available_at - row.updated_at) / 1000)); }
      else { assert.equal(row.status, "dead_letter"); assert.ok(row.completed_at); assert.equal(row.last_status_code, 503); }
    }
    assert.deepEqual(waits, [15, 30]);
    await makeDue(j.id);
    assert.equal(await work(supt1, { send: failing }), 0, "dead letters are never claimed again");
    assert.deepEqual((await ledger(j.delivery_id)).map(x => x.attempt), [1, 2, 3]);
  });

  it("a receiver domain that doesn't exist gets one retry, then is dead-lettered; a brief NXDOMAIN recovers", async () => {
    await clearQueue();
    const nx = async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND hooks.example.test"), { code: "ENOTFOUND" }); };
    const send = async () => { throw new Error("must not send"); };
    const s = await subscription(), gone = await job(s);
    assert.equal(await work(supt1, { lookup: nx, send }), 1);
    let row = await outbox(gone.id);
    assert.deepEqual([row.status, row.attempts, row.last_outcome, row.last_error], ["pending", 1, "network_error", "dns_not_found"]);
    await makeDue(gone.id);
    assert.equal(await work(supt1, { lookup: nx, send }), 1);
    row = await outbox(gone.id);
    assert.deepEqual([row.status, row.attempts, row.last_error], ["dead_letter", 2, "dns_not_found"], "stops after 2 of 5 attempts");

    // A resolver that answers NXDOMAIN once and then recovers loses nothing.
    const blip = await job(s);
    let lookups = 0;
    const flaky = async name => { lookups += 1; return lookups === 1 ? nx(name) : PUBLIC_IP; };
    assert.equal(await work(supt1, { lookup: flaky, send: delivered }), 1);
    await makeDue(blip.id);
    assert.equal(await work(supt1, { lookup: flaky, send: delivered }), 1);
    assert.deepEqual([(await outbox(blip.id)).status, (await outbox(blip.id)).attempts], ["delivered", 2]);
  });

  it("an unsafe DNS answer is a dead letter on the first attempt and nothing is sent", async () => {
    await clearQueue();
    const s = await subscription(), j = await job(s);
    const send = async () => { throw new Error("must not send to a private address"); };
    assert.equal(await work(supt1, { lookup: async () => [{ address: "10.0.0.8", family: 4 }], send }), 1);
    const row = await outbox(j.id);
    assert.deepEqual([row.status, row.attempts, row.last_outcome, row.last_error], ["dead_letter", 1, "blocked", "address_not_allowed"]);
  });

  it("a subscription is disabled after repeated failures and its remaining jobs are cancelled", async () => {
    await clearQueue();
    const s = await subscription({ failureCount: WEBHOOK_DISABLE_AFTER_FAILURES - 2 });
    const a = await job(s), b = await job(s);
    const failing = async () => ({ outcome: "http_error", statusCode: 500, durationMs: 1 });
    assert.equal(await work(supt1, { send: failing, limit: 1 }), 1);
    assert.deepEqual(await sub(s).then(x => [x.status, x.failure_count]), ["active", WEBHOOK_DISABLE_AFTER_FAILURES - 1]);
    assert.equal(await work(supt1, { send: failing, limit: 1 }), 1);
    const disabled = await sub(s);
    assert.deepEqual([disabled.status, disabled.failure_count, disabled.last_outcome], ["disabled", WEBHOOK_DISABLE_AFTER_FAILURES, "http_error"]);
    assert.ok(disabled.disabled_at);
    // Both jobs were attempted once and are pending; once due they are cancelled, not sent.
    await makeDue(a.id); await makeDue(b.id);
    let sends = 0;
    assert.equal(await work(supt1, { send: async () => { sends += 1; return delivered(); } }), 2);
    assert.deepEqual([(await outbox(a.id)).status, (await outbox(b.id)).status], ["cancelled", "cancelled"]);
    assert.equal(sends, 0);
  });

  it("an expired lease is reclaimed; a live lease is not", async () => {
    await clearQueue();
    const s = await subscription();
    const expired = await job(s), live = await job(s);
    await admin.query(`UPDATE webhook_outbox SET status='processing',lease_token=gen_random_uuid(),lease_until=now()-interval '1 second' WHERE id=$1`, [expired.id]);
    await admin.query(`UPDATE webhook_outbox SET status='processing',lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes' WHERE id=$1`, [live.id]);
    const sent = [];
    assert.equal(await work(supt1, { send: async req => { sent.push(req.headers["X-EduOS-Delivery"]); return delivered(); } }), 1);
    assert.deepEqual(sent, [expired.delivery_id], "the stable delivery id is reused after a crash");
    assert.equal((await outbox(expired.id)).status, "delivered");
    assert.equal((await outbox(live.id)).status, "processing", "another worker still holds it");
  });

  it("a worker that lost its lease does not change the subscription's failure state", async () => {
    await clearQueue();
    const s = await subscription({ failureCount: WEBHOOK_DISABLE_AFTER_FAILURES - 1 });
    const j = await job(s);
    // Worker A claims the job, then stalls past its lease. Worker B reclaims and
    // delivers. A finally gets an error back from the receiver.
    const slowFailure = async () => {
      await admin.query("UPDATE webhook_outbox SET lease_until=now()-interval '1 second' WHERE id=$1", [j.id]);
      assert.equal(await work(supt1, { send: delivered }), 1, "worker B reclaims the expired lease");
      return { outcome: "http_error", statusCode: 500, durationMs: 1 };
    };
    assert.equal(await work(supt1, { send: slowFailure }), 1);
    const row = await outbox(j.id);
    assert.deepEqual([row.status, row.last_outcome], ["delivered", "delivered"], "A's late result cannot overwrite B's");
    const after = await sub(s);
    assert.deepEqual([after.status, after.failure_count, after.last_outcome], ["active", 0, "delivered"],
      "A's stale failure must not count against (or disable) the subscription");
    // 036: one ledger row per attempt. B recorded attempt 1 first; A's late duplicate is ignored.
    assert.deepEqual((await ledger(j.delivery_id)).map(x => [x.attempt, x.outcome]), [[1, "delivered"]]);
    const idx = (await admin.query("SELECT indexdef FROM pg_indexes WHERE indexname='webhook_deliveries_attempt_unique'")).rows[0];
    assert.match(idx.indexdef, /UNIQUE INDEX .* \(delivery_id, attempt\)$/, "clean database: full unique index");
  });

  it("competing workers never claim the same job twice", async () => {
    await clearQueue();
    const s = await subscription();
    const jobs = []; for (let i = 0; i < 8; i++) jobs.push(await job(s));
    const sends = new Map();
    const slowSend = async req => {
      const id = req.headers["X-EduOS-Delivery"]; sends.set(id, (sends.get(id) || 0) + 1);
      await new Promise(r => setTimeout(r, 20)); return delivered();
    };
    const claimed = await Promise.all([work(supt1, { send: slowSend, limit: 5 }), work(supt1, { send: slowSend, limit: 5 }), work(supt1, { send: slowSend, limit: 5 })]);
    assert.equal(claimed.reduce((a, b) => a + b, 0), 8, `claims per worker: ${claimed}`);
    assert.equal(sends.size, 8); assert.ok([...sends.values()].every(n => n === 1), "each job sent exactly once");
    for (const j of jobs) assert.equal((await outbox(j.id)).status, "delivered");
  });

  it("the scheduled dispatcher drains every district's queue without API activity", async () => {
    await clearQueue();
    const { dispatchWebhooks } = await import("../../src/webhook-dispatch.js");
    const ownerPool = new pg.Pool({ connectionString: db.ownerUrl, max: 2 });
    try {
      const s1 = await subscription(), s2 = await subscription({ district: ID.d2, creator: USERS.supt2[0] });
      const d1Jobs = [await job(s1), await job(s1), await job(s1)];
      const d2Job = await job(s2, { district: ID.d2, actor: USERS.supt2[0] });
      const backedOff = await job(s1);
      await admin.query("UPDATE webhook_outbox SET available_at=now()+interval '10 minutes' WHERE id=$1", [backedOff.id]);
      const sent = [];
      const options = { lookup: async () => PUBLIC_IP, send: async req => { sent.push(req.headers["X-EduOS-Delivery"]); return delivered(); }, sleep: async () => {} };

      assert.deepEqual(await dispatchWebhooks({ db: ownerPool, signingKey: "", deliveryOptions: options }), { skipped: "webhooks_not_configured", claimed: 0 });
      const r = await dispatchWebhooks({ db: ownerPool, signingKey: SIGNING_KEY, deliveryOptions: options, log: { error: () => {} } });
      assert.equal(r.claimed, 4);
      assert.deepEqual(sent.sort(), [...d1Jobs, d2Job].map(j => j.delivery_id).sort(), "both districts drained, each job once");
      for (const j of [...d1Jobs, d2Job]) assert.equal((await outbox(j.id)).status, "delivered");
      assert.equal((await outbox(backedOff.id)).status, "pending", "a backed-off retry waits for its time");
      assert.equal((await dispatchWebhooks({ db: ownerPool, signingKey: SIGNING_KEY, deliveryOptions: options })).claimed, 0, "nothing left to do");
    } finally { await ownerPool.end(); }
  });

  it("a worker only sees its own district's queue", async () => {
    await clearQueue();
    const s = await subscription(), j = await job(s);
    let sends = 0;
    assert.equal(await work(supt2, { send: async () => { sends += 1; return delivered(); } }), 0);
    assert.equal(sends, 0); assert.equal((await outbox(j.id)).status, "pending");
    assert.equal(await work(supt1, { send: delivered }), 1);
  });
});
