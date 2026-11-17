# EduOS District Edition 37.7.0

**Release type:** Feature and hardening increment
**Base:** 37.5.0
**Status:** Features merged to `main` through PR #60 (`546d2da`); the audit
hardening below is on `fix/37.7-audit-hardening`. Not deployed.

`package.json` said 37.5.0 while main carried the 37.6 and 37.7.0 work (the
2026-11-17 third-party audit flagged the drift). The package, lockfile, web
title, sidebar label, service-worker cache and this README now say 37.7.0,
and `test/release-version.test.js` fails if a release-candidate note is ever
newer than the package version.

## Merged since 37.5.0

Details are in `docs/release-candidates/`.

- 37.6.0 app marketplace (#55), Leo & Edison (#56), credentials wallet (#57),
  enrollment funnel (#58), well-being check-ins (#59). Migrations 059, 061–064.
- 37.7.0 commerce, sandbox only (#60). Migration 065.
- Clubs and sports backend and hub (#46, #47), district AI privacy controls
  (#48), sports eligibility and permission slips (060), and the 37.5 CI and
  monitoring follow-ups (#40–#45, #50).

## Audit hardening (2026-11-17 audit of `546d2da`)

Migration `067_webhook_hardening.sql` (066 is reserved by the open district
payment providers branch; the migrator applies files by name).

1. **Webhook deadline cancels the request.** Each attempt's timeout is now an
   absolute deadline, and the outbox's job deadline aborts the request through
   an `AbortSignal`. The socket is destroyed before the delivery slot is given
   back, so a receiver that trickles bytes can't hold connections open.
2. **Reading `GET /api/flow-events` no longer sends webhooks.** Pending jobs are
   recovered by the scheduled sweep (`WEBHOOK_DISPATCH_INTERVAL_SECONDS`,
   default 60) or `src/webhook-dispatch.js`. Keep one of them running.
3. **Webhook registration is race-free.** The API takes a per-district
   advisory lock, and PostgreSQL enforces one active subscription per
   (district, URL) and `max_active_webhooks` (unique index and trigger).
   Existing duplicate active subscriptions are disabled by the migration
   (the oldest is kept).
4. **Flow events commit with their business change.** Assignments,
   attendance, app mesh and branding events (and their outbox jobs) are now
   written in the same transaction as the change; delivery starts after the
   response.
5. **Deployment-wide delivery ceiling.** `WEBHOOK_GLOBAL_MAX_IN_FLIGHT`
   (default 64, `0` = per-process only) caps deliveries across every API
   replica and the dispatcher, using leased slot rows reached only through
   SECURITY DEFINER functions. A job that finds no slot goes back to the queue
   without using an attempt; "Send test" answers 503 `webhook_capacity_busy`.
6. **Zero free slots, zero claims.** A worker no longer claims a job it can't
   start.
7. **Runtime-role guard.** Start-up refuses a database role that owns, or is
   a member of the owner of, any table, view, sequence or function in the
   schema, not just `students`.

## Deployment requirements

1. Run migrations (`node src/migrate.js` as the owner), which re-applies
   `db/runtime_grants.template.sql`.
2. Keep the webhook sweep on (`WEBHOOK_DISPATCH_INTERVAL_SECONDS` > 0) or run
   `src/webhook-dispatch.js` on a schedule: feed reads no longer deliver.
3. Size `WEBHOOK_GLOBAL_MAX_IN_FLIGHT` for the whole deployment (it should be
   at least `WEBHOOK_MAX_IN_FLIGHT`).

## Validation status

- Unit and PostgreSQL 16 integration tests pass locally, including
  `test/webhooks-deadline.test.js` and `test/integration/audit-hardening.test.js`
  (runtime role); each new test fails on `546d2da`.
- The recovery drill (restart with leased jobs, DNS failure, receiver outage
  across replicas) needs a real deployment and remains outstanding.

No production deployment or live district validation is claimed.
