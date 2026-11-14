// 32.4.0: hand pending external notifications (email/SMS/push) to their
// adapters. Run as the migration OWNER role, like the retention job:
//   DATABASE_URL=<owner url> node src/notify-dispatch.js
//   docker compose --profile ops run --rm notify
// No real sender ships with 32.4.0: "log" records a dry run, "off" skips.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";
import { adapterFor } from "./notify.js";

export async function dispatchPending({ db = pool, limit = 500, log = console.log } = {}) {
  const districts = (await db.query("SELECT id FROM districts WHERE status='active'")).rows;
  let handled = 0;
  for (const d of districts) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.district_id',$1,true)", [d.id]);
      const rows = (await client.query(
        `SELECT id,channel,recipient_user_id,attempts FROM notification_outbox
          WHERE status='pending' AND channel<>'in_app' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
      for (const row of rows) {
        let result;
        try { result = await adapterFor(row.channel).send(row, log); }
        catch (e) { result = { status: row.attempts + 1 >= 5 ? "failed" : "pending", note: String(e.message || e).slice(0, 300) }; }
        await client.query(
          `UPDATE notification_outbox SET status=$2, attempts=attempts+1, last_error=$3,
                  delivered_at=CASE WHEN $2 IN ('delivered','skipped') THEN now() END WHERE id=$1`,
          [row.id, result.status, result.note || null]);
        handled++;
      }
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
    finally { client.release(); }
  }
  return handled;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  dispatchPending().then(n => { console.log(`notification dispatch: ${n} handled`); return pool.end(); })
    .catch(async e => { console.error(`notification dispatch failed: ${e.message}`); await pool.end(); process.exit(1); });
}
