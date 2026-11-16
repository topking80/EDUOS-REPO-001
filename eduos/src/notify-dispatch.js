// 32.4.0: hand pending external notifications (email/SMS/push) to their
// adapters. Run as the migration OWNER role, like the retention job:
//   DATABASE_URL=<owner url> node src/notify-dispatch.js
//   docker compose --profile ops run --rm notify
// No real sender ships yet: "log" records a dry run, "off" skips.
//
// Outcomes: delivered_at is set only when an adapter confirms delivery;
// "skipped" (dry run, channel off) is not a delivery. A temporary failure waits
// for next_attempt_at (exponential back-off) and becomes "failed" after
// MAX_ATTEMPTS; every attempt sets last_attempt_at.
//
// Leases (no transaction is open while an adapter works):
//   1. claim: a short transaction marks up to `batch` due rows with a fresh
//      lease_token and lease_expires_at, and commits;
//   2. send: each claimed row goes to its adapter with no transaction or row
//      lock held, so a slow sender can't tie up connections or block the rows;
//   3. settle: a short transaction records the outcome only if the row still
//      carries this lease (WHERE lease_token=$token), then clears the lease.
// A dispatcher that dies mid-batch leaves leases that run out after
// `leaseSeconds`; the next run claims those rows again. The adapter is handed
// the row id, which a real sender passes on as its idempotency key, so a row
// sent just before a crash isn't delivered twice by a provider that honours it.
//
// Slow senders: a batch is claimed together but sent one row at a time, so a
// row's claim could run out while earlier rows are still being sent, and a
// second dispatcher could take it. So just before each send the dispatcher
// renews that row's lease (only if it still holds it; otherwise it skips the
// row), and every send is cut off at `sendTimeoutSeconds`, which must be well
// inside the lease: a row is never sent under a lease that can run out mid-send.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";
import { adapterFor, attemptOutcome } from "./notify.js";

export async function dispatchPending({ db = pool, limit = 500, batch = 50, leaseSeconds = 120, sendTimeoutSeconds = Math.floor(leaseSeconds / 2),
  log = console.log, adapters = adapterFor } = {}) {
  if (!(sendTimeoutSeconds > 0 && sendTimeoutSeconds < leaseSeconds)) throw new Error("sendTimeoutSeconds must be above 0 and below leaseSeconds");
  const districts = (await db.query("SELECT id FROM districts WHERE status='active'")).rows;
  const tally = { handled: 0, delivered: 0, skipped: 0, retrying: 0, failed: 0, lostLease: 0 };
  for (const d of districts) {
    for (let done = 0; done < limit;) {
      const token = crypto.randomUUID();
      const claimed = await inTx(db, d.id, c => c.query(
        `UPDATE notification_outbox o SET lease_token=$2, lease_expires_at=now()+make_interval(secs => $3::float8)
          WHERE o.id IN (SELECT id FROM notification_outbox
                          WHERE district_id=$1 AND status='pending' AND channel<>'in_app'
                            AND (next_attempt_at IS NULL OR next_attempt_at<=now())
                            AND (lease_expires_at IS NULL OR lease_expires_at<=now())
                          ORDER BY created_at,id LIMIT $4 FOR UPDATE SKIP LOCKED)
          RETURNING o.id,o.channel,o.recipient_user_id,o.attempts,o.created_at`,
        [d.id, token, leaseSeconds, Math.min(batch, limit - done)]));
      const rows = claimed.rows.sort((a, b) => a.created_at - b.created_at || String(a.id).localeCompare(String(b.id)));
      if (!rows.length) break;
      for (const row of rows) {
        // Renew this row's lease for the length of its send; skip it if another
        // dispatcher took it over while earlier rows were being sent.
        const renewed = await inTx(db, d.id, c => c.query(
          `UPDATE notification_outbox SET lease_expires_at=now()+make_interval(secs => $3::float8)
            WHERE id=$1 AND lease_token=$2 AND lease_expires_at>now() AND status='pending'`, [row.id, token, leaseSeconds]));
        if (!renewed.rowCount) { done++; tally.lostLease++; continue; }
        let result, timer;
        try {
          result = await Promise.race([
            adapters(row.channel).send({ id: row.id, channel: row.channel, recipient_user_id: row.recipient_user_id }, log),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${sendTimeoutSeconds} s`)), sendTimeoutSeconds * 1000); timer.unref?.(); })
          ]);
        } catch (e) { result = { status: "pending", note: String(e?.message || e).slice(0, 300) }; }
        finally { clearTimeout(timer); }
        const out = attemptOutcome(result, row.attempts);
        const settled = await inTx(db, d.id, c => c.query(
          `UPDATE notification_outbox SET status=$2, attempts=$3, last_error=$4, last_attempt_at=now(),
                  delivered_at=CASE WHEN $2='delivered' THEN now() END,
                  next_attempt_at=CASE WHEN $5::int IS NULL THEN NULL ELSE now()+make_interval(secs => $5::int) END,
                  lease_token=NULL, lease_expires_at=NULL
            WHERE id=$1 AND lease_token=$6`,
          [row.id, out.status, out.attempts, out.status === "delivered" ? null : out.note, out.retryInSeconds, token]));
        done++;
        if (!settled.rowCount) { tally.lostLease++; continue; }
        tally.handled++;
        tally[out.status === "pending" ? "retrying" : out.status]++;
      }
    }
  }
  return tally;
}

async function inTx(db, districtId, fn) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.district_id',$1,true)", [districtId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
  finally { client.release(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  dispatchPending().then(t => { console.log(`notification dispatch: ${t.handled} handled (${t.delivered} delivered, ${t.skipped} skipped, ${t.retrying} to retry, ${t.failed} failed${t.lostLease ? `, ${t.lostLease} lease lost` : ""})`); return pool.end(); })
    .catch(async e => { console.error(`notification dispatch failed: ${e.message}`); await pool.end(); process.exit(1); });
}
