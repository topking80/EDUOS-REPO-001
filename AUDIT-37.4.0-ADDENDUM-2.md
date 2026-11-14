# EDUOS 37.4.0 — Audit Addendum 2: Outstanding Items 3–8

**Branch:** `fix/eduos-37.4.0-audit-findings`
**Date:** November 14, 2026
**Database:** PostgreSQL 16.15 (disposable). Migrations run as a non-superuser owner; the API and tests run as a non-owner runtime role (NOSUPERUSER, NOBYPASSRLS).
**Runtime:** Node.js v22.23.4

## Results after this addendum

| Suite | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| Unit (`node --test`, no environment) | 585 | 584 | 0 | 1 |
| Integration (`npm run test:integration`, real PostgreSQL) | 95 | 95 | 0 | 0 |
| Integration with `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC` added (not committed) | 93 | 93 | 0 | 0 |

- **1 skip:** needs the `butane` tool, which isn't installed in this environment.

Before this addendum, the integration suite had never been run in full against this release. Its first run here gave 79/81, revealing F-6.

## New findings

### F-6 — Runtime role denied three tables (production defect, fixed)
- The runtime grants template never granted `library_borrowing_policies` or `library_notice_ledger` (migration 026), or `school_operation_schedules` (migration 029).
- Under the runtime role, PostgreSQL denies these tables, so the library borrowing-policy, overdue-notice and school-operations schedule endpoints would fail in a compose deployment.
- Caught by the existing integration test H2.
- **Fix:** least-privilege grants, with DELETE and TRUNCATE revoked; H2 now asserts the write privileges those endpoints need.

### F-7 — Stale webhook worker could change subscription state (defect, fixed)
- A worker that stalled past its 2-minute lease could still change the subscription's failure count after another worker had reclaimed and delivered the job. A late failure could therefore disable a healthy subscription.
- Found by the new lease tests.
- **Fix:** only the current lease holder updates subscription state. The ledger still records the attempt.

### Observations (not changed)
- `webhook_deliveries` had no unique key on `(delivery_id, attempt)`, so its `ON CONFLICT DO NOTHING` never fired and a stale worker could log a duplicate attempt. **Fixed:** migration 036 adds the unique index. On a database that already holds duplicates, it applies only to rows from the migration on.
- Every DNS lookup error, including a non-existent domain, was retried for the full 5 attempts. **Fixed:** NXDOMAIN (`dns_not_found`) gets one retry and is then dead-lettered; outages keep the full budget.
- The outbox was only processed on authenticated activity in the district, so a district with no traffic didn't drain its queue. **Fixed:** `src/webhook-dispatch.js` (`npm run webhooks:dispatch`, compose `--profile ops run --rm webhooks`) drains every district. Schedule it every minute.
- 37.3.1 → 37.4.0 comparison: the only code change is in `src/webhooks.js` (DNS retry classification), plus one new test and version bumps. It matches `CODE-IMPROVEMENTS-37.4.0.md`. The 37.3.1 archive SHA-256 is `be13328314b75c7fc27c25e33208fdddaea570ee6976f3f244ea76a8e25cc648`.

## Outstanding items

| # | Item | Status | Change |
|---|---|---|---|
| 3 | RLS helper EXECUTE privileges | **Done** | 38 functions are referenced by policies, directly or through `eduos_owner_session()`. The 36 that relied on PUBLIC are now explicitly granted to the runtime role. New test H2b fails if any policy-referenced function lacks an explicit grant. PUBLIC EXECUTE is **not** revoked; the full integration suite passes with it revoked, so revoking it is now a safe, separate decision. |
| 4 | Transport check-in DB defense in depth | **Done** | Migration 034: a RESTRICTIVE INSERT policy requires run status/timing, active rider, stop on the route and matching school. Direct runtime-role inserts are tested (6 rejected, 2 accepted). Without 034 the test fails. |
| 5 | Offline replay boundary and idempotency tests | **Done** | Unit: 24 h edge inclusive, 2 min skew, ISO-only, key 16–80 chars. Integration: duplicate delivery writes once, stale/future refused with no receipt, a failed write releases its key. |
| 6 | Offline replay receipt retention | **Done** | Migration 035 plus `src/retention.js`: `RETENTION_OFFLINE_REPLAY_DAYS` (default 7, minimum 2, enforced in JS and SQL). District-scoped, owner-only, tested. |
| 7 | Webhook outbox lifecycle and leases | **Done** | Worker moved to `src/webhook-outbox.js` with no behaviour change. 8 integration tests cover DNS outage then success, backoff and exhaustion, unsafe DNS, auto-disable and cancellation, lease expiry, competing workers, tenant isolation and stale workers (F-7). |
| 8 | Non-superuser migrations and runtime permissions | **Done** | Clean migration as a non-superuser owner: 35/35. Upgrade from a 33-migration database: 034 and 035 applied; a re-run is a no-op. Runtime role: no superuser, BYPASSRLS, CREATEROLE or CREATEDB. |
| 9 | Production edge, scheduler, secrets, connectivity | Partly open | Webhook dispatcher added (code side of the scheduler). Cron setup, edge, secrets and connectivity need the target environment. |
| 2 | Camera-policy conflict | **Done** | The camera barcode scanner (36.0.0) was removed. It broke the documented no-camera policy (FIX-REPORT-32.5.0), and Caddy's `camera=()` blocked it in production anyway. Typed entry and USB/Bluetooth scanners are unchanged. A second stale version check behind it in `learning-32600` was also fixed. |

## New migrations

- `034_transport_checkin_integrity.sql`
- `035_offline_replay_retention.sql`
- `036_webhook_delivery_attempt_unique.sql`

All three are additive and listed in `src/migrate.js`. Deployments must run `npm run db:migrate` (compose: the `migrate` service) before starting the new API. The API already refuses to start with unapplied migrations.

**Disposition:** Continue validation. Not production approval.
