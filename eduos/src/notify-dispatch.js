// 32.4.0: hand pending external notifications (email/SMS/push) to their
// adapters. Run as the migration OWNER role, like the retention job:
//   DATABASE_URL=<owner url> node src/notify-dispatch.js
//   docker compose --profile ops run --rm notify
// No real sender ships with 32.4.0: "log" records a dry run, "off" skips.
//
// Outcomes (release gate): delivered_at is set only when an adapter confirms
// delivery; "skipped" (dry run, channel off) is not a delivery. A temporary
// failure waits for next_attempt_at (exponential back-off) and becomes
// "failed" after MAX_ATTEMPTS; every attempt sets last_attempt_at. Each row is
// committed on its own, so one bad row can't roll back the outcomes already
// recorded for others in the batch.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";
import { adapterFor, attemptOutcome } from "./notify.js";

export async function dispatchPending({ db = pool, limit = 500, log = console.log, adapters = adapterFor } = {}) {
  const districts = (await db.query("SELECT id FROM districts WHERE status='active'")).rows;
  const tally = { handled: 0, delivered: 0, skipped: 0, retrying: 0, failed: 0 };
  for (const d of districts) {
    const client = await db.connect();
    try {
      for (let n = 0; n < limit; n++) {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.district_id',$1,true)", [d.id]);
        // The adapter gets the id, channel and recipient only.
        const row = (await client.query(
          `SELECT id,channel,recipient_user_id,attempts FROM notification_outbox
            WHERE district_id=$1 AND status='pending' AND channel<>'in_app' AND (next_attempt_at IS NULL OR next_attempt_at<=now())
            ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [d.id])).rows[0];
        if (!row) { await client.query("COMMIT"); break; }
        let result;
        try { result = await adapters(row.channel).send({ id: row.id, channel: row.channel, recipient_user_id: row.recipient_user_id }, log); }
        catch (e) { result = { status: "pending", note: String(e?.message || e).slice(0, 300) }; }
        const out = attemptOutcome(result, row.attempts);
        await client.query(
          `UPDATE notification_outbox SET status=$2, attempts=$3, last_error=$4, last_attempt_at=now(),
                  delivered_at=CASE WHEN $2='delivered' THEN now() END,
                  next_attempt_at=CASE WHEN $5::int IS NULL THEN NULL ELSE now()+make_interval(secs => $5::int) END
            WHERE id=$1`,
          [row.id, out.status, out.attempts, out.status === "delivered" ? null : out.note, out.retryInSeconds]);
        await client.query("COMMIT");
        tally.handled++;
        tally[out.status === "pending" ? "retrying" : out.status]++;
      }
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
    finally { client.release(); }
  }
  return tally;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  dispatchPending().then(t => { console.log(`notification dispatch: ${t.handled} handled (${t.delivered} delivered, ${t.skipped} skipped, ${t.retrying} to retry, ${t.failed} failed)`); return pool.end(); })
    .catch(async e => { console.error(`notification dispatch failed: ${e.message}`); await pool.end(); process.exit(1); });
}
