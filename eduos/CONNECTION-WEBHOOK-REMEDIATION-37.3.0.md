# Connection and Webhook Remediation — 37.3.0

This release advances the 37.2.0 remediation by moving webhook work from best-effort in-process dispatch to a tenant-scoped durable outbox.

## Design
1. `recordFlowEvent` writes the flow event and all matching active-subscription jobs inside the same `withTenantTransaction` transaction.
2. The outbox is protected by ENABLE/FORCE ROW LEVEL SECURITY and district `USING`/`WITH CHECK` policies.
3. Workers claim due or expired-lease jobs with `FOR UPDATE SKIP LOCKED`, set a lease token, and deliver outside the claim transaction.
4. A stable delivery ID survives retries and lease recovery. The delivery ledger remains append-only.
5. Failures are scheduled with bounded exponential backoff. Exhausted or blocked jobs enter `dead_letter`; removed/disabled subscriptions cancel queued work.
6. The flow feed triggers a tenant-scoped pump so pending jobs can resume after process restart when that district next accesses the feed.

## Important delivery guarantee
This is at-least-once delivery. A process can crash after the remote endpoint accepts a request but before EduOS commits the acknowledgement. The next worker may resend the same stable delivery ID. Receivers should persist and deduplicate that ID. Exactly-once delivery across independent systems cannot be guaranteed by this HTTP protocol alone.

## Outstanding production gates
- Run migration 033 against a staging PostgreSQL database using the migration-owner role.
- Verify runtime role grants, FORCE RLS and cross-district isolation with two real districts.
- Exercise two concurrent workers, lease expiry, restart recovery, retry exhaustion and dead-letter inspection.
- Add a managed per-district worker trigger/scheduler for recovery independent of user feed activity.
- Validate receiver idempotency and real network/DNS behavior.
- Resolve remaining full-suite failures before production promotion.
