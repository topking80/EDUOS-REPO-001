// Durable webhook outbox worker (37.3.0), extracted from server.js in the
// 37.4.0 audit so its lifecycle can be tested against real PostgreSQL with an
// injected delivery function.
//
// Process durable work only inside the requesting district's RLS context.
// A stable delivery_id is reused after lease expiry, allowing receivers to
// deduplicate the unavoidable at-least-once crash window.
import { deliverWebhook, deriveWebhookSecret, WEBHOOK_DISABLE_AFTER_FAILURES } from "./webhooks.js";

/** Attempts allowed when the receiver's domain doesn't exist (NXDOMAIN). */
export const DNS_NOT_FOUND_MAX_ATTEMPTS = 2;

/** How long a claim, or a renewal just before one job's delivery, holds a job. */
export const JOB_LEASE_SECONDS = 120;
/** A delivery is cut off after this (DNS up to 15 s + HTTP 5 s fit well inside; the lease is longer still). */
export const JOB_DEADLINE_MS = 45_000;

/**
 * At most `max` deliveries at once in this process (WEBHOOK_MAX_IN_FLIGHT).
 * Request-triggered dispatch can start many workers at once; they all share
 * one limiter, so a burst of events can't open hundreds of outbound
 * connections.
 */
export function createLimiter(max) {
  let active = 0;
  const waiting = [];
  const limit = Math.max(1, Number(max) || 1);
  return {
    get active() { return active; },
    get waiting() { return waiting.length; },
    async run(fn) {
      if (active >= limit) await new Promise(resolve => waiting.push(resolve));
      else active++;
      try { return await fn(); }
      finally { const next = waiting.shift(); if (next) next(); else active--; }
    }
  };
}
const unlimited = { run: fn => fn() };

export const tenantActor = actor => ({ districtId: actor.districtId, userId: actor.userId, role: actor.role, schoolId: actor.schoolId || null });

/**
 * Claim up to `limit` due jobs for the actor's district and attempt each once.
 * deps: { withTenantTransaction, signingKey, deliveryOptions, deliver?, disableAfterFailures?, log? }
 * Returns the number of jobs claimed.
 */
export async function processWebhookOutbox(actorInput, { limit = 10 } = {}, deps) {
  const { withTenantTransaction, signingKey, previousSigningKey = null, deliveryOptions = {}, deliver = deliverWebhook,
    disableAfterFailures = WEBHOOK_DISABLE_AFTER_FAILURES, log = console, limiter = unlimited,
    leaseSeconds = JOB_LEASE_SECONDS, jobDeadlineMs = JOB_DEADLINE_MS } = deps;
  if (!(jobDeadlineMs > 0 && jobDeadlineMs < leaseSeconds * 1000)) throw new Error("jobDeadlineMs must be above 0 and below the lease");
  if (!signingKey) return 0;
  const actor = tenantActor(actorInput); const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
  const claimed = await withTenantTransaction(actor, async client => {
    const rows = await client.query(
      `WITH candidates AS (
         SELECT id FROM webhook_outbox
          WHERE ((status='pending' AND available_at<=now()) OR (status='processing' AND lease_until<now()))
          ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE webhook_outbox o SET status='processing',lease_until=now()+make_interval(secs => $2::float8),lease_token=gen_random_uuid(),updated_at=now()
       FROM candidates c WHERE o.id=c.id
       RETURNING o.id,o.subscription_id,o.event_id,o.event_type,o.payload,o.delivery_id,o.attempts,o.max_attempts,o.lease_token,o.available_at,o.created_at`, [safeLimit, leaseSeconds]);
    return rows.rows.sort((a, b) => a.available_at - b.available_at || a.created_at - b.created_at);
  });
  for (const job of claimed) {
    try {
      // The batch was claimed together but is delivered one job at a time, so
      // a later job's claim could run out while earlier ones are being sent and
      // another worker could take it (2026-11-16 audit). Renew this job's lease
      // just before its delivery; if another worker has it, leave it alone.
      const renewed = await withTenantTransaction(actor, client => client.query(
        `UPDATE webhook_outbox SET lease_until=now()+make_interval(secs => $3::float8),updated_at=now()
          WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>now()`, [job.id, job.lease_token, leaseSeconds]));
      if (!renewed.rowCount) { log.warn?.('Webhook outbox lease lost before delivery', { jobId: job.id }); continue; }
      const subscription = await withTenantTransaction(actor, client => client.query(
        `SELECT id,url FROM webhook_subscriptions WHERE id=$1 AND status='active'`, [job.subscription_id]));
      if (!subscription.rowCount) {
        await withTenantTransaction(actor, client => client.query(
          `UPDATE webhook_outbox SET status='cancelled',lease_until=NULL,lease_token=NULL,completed_at=now(),updated_at=now() WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token]));
        continue;
      }
      const attemptNo = Number(job.attempts) + 1;
      const secrets = [deriveWebhookSecret(signingKey, job.subscription_id), ...(previousSigningKey ? [deriveWebhookSecret(previousSigningKey, job.subscription_id)] : [])];
      let timer;
      const attempts = await limiter.run(() => Promise.race([
        deliver({ subscription: subscription.rows[0], secret: secrets[0], secrets,
          eventType: job.event_type, deliveryId: job.delivery_id, body: JSON.stringify(job.payload), options: { ...deliveryOptions, maxAttempts: 1 } }),
        new Promise(resolve => { timer = setTimeout(() => resolve([{ attempt: 1, outcome: "timeout", statusCode: null, durationMs: jobDeadlineMs, reason: "job_deadline" }]), jobDeadlineMs); timer.unref?.(); })
      ]).finally(() => clearTimeout(timer)));
      const result = attempts[attempts.length - 1];
      await withTenantTransaction(actor, async client => {
        await client.query(
          `INSERT INTO webhook_deliveries(district_id,subscription_id,delivery_id,event_id,event_type,attempt,outcome,status_code,duration_ms)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
          [actor.districtId, job.subscription_id, job.delivery_id, job.event_id, job.event_type, attemptNo, result.outcome, result.statusCode, result.durationMs]);
        const done = result.outcome === 'delivered';
        // A domain that doesn't exist gets one retry (after the 15 s backoff, in
        // case the resolver blipped) and is then dead-lettered instead of using
        // the whole attempt budget.
        const exhausted = !done && (attemptNo >= Number(job.max_attempts) || result.outcome === 'blocked'
          || (result.reason === 'dns_not_found' && attemptNo >= DNS_NOT_FOUND_MAX_ATTEMPTS));
        // Back off 15 s, 30 s, 60 s ... at most an hour, or longer if the
        // receiver said so (Retry-After on a 429 or 503, also capped at an hour).
        const delaySeconds = Math.min(3600, Math.max(Math.pow(2, Math.max(0, attemptNo - 1)) * 15, Number(result.retryAfterSeconds) || 0));
        const settled = await client.query(
          `UPDATE webhook_outbox SET status=$3,attempts=$4,available_at=CASE WHEN $3='pending' THEN now()+($5::text||' seconds')::interval ELSE available_at END,
             lease_until=NULL,lease_token=NULL,last_outcome=$6,last_status_code=$7,last_error=$8,
             completed_at=CASE WHEN $3 IN ('delivered','dead_letter') THEN now() ELSE NULL END,updated_at=now()
           WHERE id=$1 AND lease_token=$2`,
          [job.id, job.lease_token, done ? 'delivered' : exhausted ? 'dead_letter' : 'pending', attemptNo, delaySeconds, result.outcome, result.statusCode, result.reason || null]);
        // Lease lost (this worker stalled past lease_until and another worker
        // reclaimed the job): the attempt stays in the ledger above, but only the
        // current lease holder may change the subscription's failure state.
        if (settled.rowCount === 0) return;
        if (done) await client.query(`UPDATE webhook_subscriptions SET failure_count=0,last_delivery_at=now(),last_outcome='delivered' WHERE id=$1`, [job.subscription_id]);
        else await client.query(`UPDATE webhook_subscriptions SET failure_count=failure_count+1,last_delivery_at=now(),last_outcome=$2,
          status=CASE WHEN failure_count+1 >= $3 THEN 'disabled' ELSE status END,
          disabled_at=CASE WHEN failure_count+1 >= $3 THEN now() ELSE disabled_at END WHERE id=$1`,
          [job.subscription_id, result.outcome, disableAfterFailures]);
      });
    } catch (error) {
      log.error('Webhook outbox job failed', { jobId: job.id, message: error.message });
      await withTenantTransaction(actor, client => client.query(
        `UPDATE webhook_outbox SET status='pending',available_at=now()+interval '30 seconds',lease_until=NULL,lease_token=NULL,
         last_error='worker_error',updated_at=now() WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token])).catch(() => {});
    }
  }
  return claimed.length;
}
