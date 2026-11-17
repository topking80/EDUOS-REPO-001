import test from "node:test";
import assert from "node:assert/strict";
import { createLimiter, processWebhookOutbox } from "../src/webhook-outbox.js";

test("webhook lease is renewed only after a concurrency slot is acquired", async () => {
  const limiter = createLimiter(1);
  // The slot is free when the job is claimed (a worker claims nothing when
  // every slot is busy) and taken by another delivery right after the claim.
  let releaseSlot, occupied;
  const order = [];
  let claimResolved;
  const claimDone = new Promise(resolve => { claimResolved = resolve; });
  const job = {
    id: "job-1", subscription_id: "sub-1", event_id: "event-1",
    event_type: "pupil.enrolled", payload: { type: "pupil.enrolled" },
    delivery_id: "delivery-1", attempts: 0, max_attempts: 3,
    lease_token: "lease-1", available_at: new Date(), created_at: new Date()
  };

  const withTenantTransaction = async (_actor, callback) => callback({
    query: async sql => {
      if (sql.includes("WITH candidates AS")) {
        order.push("claim");
        occupied = limiter.run(() => new Promise(resolve => { releaseSlot = resolve; }));
        claimResolved();
        return { rows: [job], rowCount: 1 };
      }
      if (sql.includes("SELECT id,url FROM webhook_subscriptions")) {
        order.push("subscription");
        return { rows: [{ id: "sub-1", url: "https://hooks.example.org/events" }], rowCount: 1 };
      }
      if (sql.includes("SET lease_until=now()")) {
        order.push("renew");
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO webhook_deliveries")) {
        order.push("ledger");
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SET status=$3")) {
        order.push("settle");
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE webhook_subscriptions")) return { rows: [], rowCount: 1 };
      throw new Error("Unexpected SQL in test: " + sql.slice(0, 100));
    }
  });

  const processing = processWebhookOutbox(
    { districtId: "district-1", userId: "scheduler", role: "scheduler" },
    { limit: 1 },
    {
      withTenantTransaction, signingKey: "k".repeat(40), limiter,
      deliver: async () => {
        order.push("deliver");
        return [{ attempt: 1, outcome: "delivered", statusCode: 204, durationMs: 1 }];
      },
      log: { warn() {}, error() {} }
    }
  );

  await claimDone;
  // The occupied slot must prevent even the lease renewal. Renewing here would
  // start the lease clock while this job is still waiting in the queue.
  assert.deepEqual(order, ["claim"]);
  releaseSlot();
  await Promise.all([occupied, processing]);
  // Settle first: only the lease holder writes the attempt to the ledger.
  assert.deepEqual(order, ["claim", "subscription", "renew", "deliver", "settle", "ledger"]);
});

test("a worker claims no more jobs than there are free delivery slots", async () => {
  const limiter = createLimiter(3);
  let releaseSlot;
  const occupied = limiter.run(() => new Promise(resolve => { releaseSlot = resolve; }));
  let claimLimit;
  const withTenantTransaction = async (_actor, callback) => callback({
    query: async (sql, params) => {
      if (sql.includes("WITH candidates AS")) { claimLimit = params[0]; return { rows: [], rowCount: 0 }; }
      throw new Error("Unexpected SQL in test: " + sql.slice(0, 100));
    }
  });
  const run = () => processWebhookOutbox({ districtId: "d", userId: "scheduler", role: "scheduler" }, { limit: 25 },
    { withTenantTransaction, signingKey: "k".repeat(40), limiter, log: { warn() {}, error() {} } });
  await run();
  assert.equal(claimLimit, 2, "three slots, one busy");
  const busy = [limiter.run(() => new Promise(() => {})), limiter.run(() => new Promise(() => {}))];
  claimLimit = undefined;
  // 2026-11-17 audit, finding 6: with no free slot the worker claims nothing
  // (it used to claim one, which then sat in the limiter queue).
  assert.equal(await run(), 0, "no free slot: nothing claimed");
  assert.equal(claimLimit, undefined, "the claim query never ran");
  releaseSlot(); await occupied; void busy;
  await processWebhookOutbox({ districtId: "d", userId: "s", role: "s" }, { limit: 25 },
    { withTenantTransaction, signingKey: "k".repeat(40), log: { warn() {}, error() {} } });
  assert.equal(claimLimit, 25, "without a limiter the requested batch size stands");
});
