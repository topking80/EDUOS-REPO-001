// Scheduled webhook outbox dispatcher (37.4.0 audit, item 9 gap).
// Until now the outbox was drained only by authenticated API activity in the
// district, so queued webhooks waited indefinitely in a quiet district (nights,
// weekends) and backed-off retries were never picked up on time. Run this every
// minute from a scheduler, as the migration OWNER role like the other jobs:
//   DATABASE_URL=<owner url> node src/webhook-dispatch.js
//   docker compose --profile ops run --rm webhooks
// The API also runs it every WEBHOOK_DISPATCH_INTERVAL_SECONDS (default 60), so
// cron is optional. It uses the same worker as the API (src/webhook-outbox.js): leases, SKIP
// LOCKED claims, backoff, dead-lettering and auto-disable are shared, so it is
// safe to run alongside API-triggered processing and alongside itself.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";
import { config } from "./config.js";
import { processWebhookOutbox, createLimiter } from "./webhook-outbox.js";

/** A tenant transaction for scheduled jobs: district-scoped RLS, no user identity. */
export function districtTransaction(db) {
  return async (actor, callback) => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.district_id',$1,true)", [actor.districtId]);
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  };
}

export async function dispatchWebhooks({
  db = pool, signingKey = config.webhookSigningKey, previousSigningKey = config.webhookPreviousSigningKey || null,
  deliveryOptions = { allowInsecureLoopback: config.webhookAllowInsecureLoopback, allowedHosts: config.webhookAllowedHosts },
  deliver, maxPerDistrict = 200, log = console, limiter = createLimiter(config.webhookMaxInFlight)
} = {}) {
  if (!signingKey) return { skipped: "webhooks_not_configured", claimed: 0 };
  const districts = (await db.query("SELECT id FROM districts WHERE status='active' ORDER BY id")).rows;
  const deps = { withTenantTransaction: districtTransaction(db), signingKey, previousSigningKey, deliveryOptions, log, limiter, ...(deliver ? { deliver } : {}) };
  let claimed = 0;
  for (const { id } of districts) {
    const actor = { districtId: id, userId: "scheduler", role: "scheduler" };
    // Drain in batches until nothing is due, bounded so one district can't starve the rest.
    for (let done = 0; done < maxPerDistrict;) {
      const n = await processWebhookOutbox(actor, { limit: 25 }, deps);
      if (n === 0) break;
      done += n; claimed += n;
    }
  }
  return { claimed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  dispatchWebhooks().then(r => { console.log(JSON.stringify(r)); return pool.end(); })
    .catch(async e => { console.error(`webhook dispatch failed: ${e.message}`); await pool.end(); process.exit(1); });
}
