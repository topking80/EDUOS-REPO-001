# EduOS 37.3.0 — Durable Webhook Outbox and Reliability Improvements

## Included
- Added tenant-RLS-protected `webhook_outbox` with stable delivery IDs, unique district/subscription/event jobs, leases, scheduled retries, bounded attempts, dead-letter and cancellation states.
- Flow event persistence and matching outbox insertion now occur in one tenant transaction.
- Added tenant-scoped `FOR UPDATE SKIP LOCKED` worker claims; no cross-district scheduler query or RLS bypass is introduced.
- Delivery attempt history remains append-only. Retries reuse the same delivery ID so receivers can deduplicate at-least-once delivery after a crash between remote acceptance and local acknowledgement.
- Authenticated flow-feed activity pumps pending jobs to recover queued work after an application restart.
- Preserved HTTPS validation, DNS pinning, redirect refusal, signed payloads, bounded response handling, and request-side asynchronous dispatch.

## Operational semantics and limits
- Delivery is **at least once**, not exactly once. Receiver-side idempotency on `X-EduOS-Delivery` is required to avoid duplicate side effects in the remote crash window.
- Processing is tenant-scoped to the active authenticated district. Pending jobs are recovered when that district next generates an event or loads its flow feed; this release does not include an always-running cross-district scheduler.
- A remote receiver that takes longer than the 45-second lease can overlap with a reclaimed attempt. Current outbound timeout is 5 seconds; still validate with production network conditions.
- Migration `033_durable_webhook_outbox.sql` must be applied by the migration-owner role before deploying this version. Runtime grants are reapplied by the migration runner.

## Verification
- Focused webhook and outbox tests: 29 passed, 0 failed.
- JavaScript syntax checks: passed for `src/server.js` and `src/migrate.js`.
- Full-suite status from this working tree: 547 tests; 510 passed, 36 failed, 1 skipped. Remaining failures include legacy release-version expectations and unrelated pre-existing integration/authorization/UI assertions. Do not treat this as a green full-suite release gate.
- No live PostgreSQL migration, runtime-role/RLS exercise, multi-process contention test, remote receiver test, browser E2E, load test, or production deployment was performed.
