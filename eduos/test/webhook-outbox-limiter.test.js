import test from "node:test";
import assert from "node:assert/strict";
import { createLimiter, processWebhookOutbox } from "../src/webhook-outbox.js";

test("webhook lease is renewed only after a concurrency slot is acquired", async () => {
  const limiter = createLimiter(1);
  let releaseSlot;
  const occupied = limiter.run(() => new Promise(resolve => { releaseSlot = resolve; }));
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
  assert.deepEqual(order, ["claim", "subscription", "renew", "deliver", "ledger", "settle"]);
});
