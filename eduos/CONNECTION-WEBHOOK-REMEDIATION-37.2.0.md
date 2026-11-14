# EduOS 37.2.0 — Connection and Webhook Remediation Report

## Fixed in this package
1. **District IT administrator access mismatch:** the browser API bridge previously allowed only the superintendent role for webhook list/create/disable/test operations, while the server authorization policy permits both superintendent and district IT administrator. The client guard now matches the server policy.
2. **False-positive webhook delivery:** the HTTP receiver handler previously classified a response as delivered on `close` or `error` using only the status code. A receiver that returned a partial 2xx response and then aborted could therefore be recorded as successful. Delivery now requires a complete response; aborts, truncated responses, and oversized responses are failures.
3. **Retry bounds:** delivery attempt configuration is now validated and clamped to 1–5, with invalid values falling back to the default.
4. **Regression tests:** added tests for IT-admin permission parity and truncated/oversized receiver responses; corrected a stale connection-integrity release-version assertion.

## Verification
- Webhook + connection-integrity tests: **26 passed, 0 failed**.
- `node --check src/webhooks.js`: passed.
- `node --check public/api-bridge.js`: passed.
- Full suite: **511 passed, 35 failed, 1 skipped** (547 total). Remaining failures include historical version assertions, unrelated API/security/role UI checks, and integration tests that require external services or a configured PostgreSQL environment.
- Local HTML asset reference integrity check: passed.

## Not yet fixed / production blockers
- Webhook dispatch is still in-process and best-effort after the event write. A process crash between event persistence and dispatch can lose a delivery. Production-grade delivery needs a transactional outbox and a tenant-safe worker with leases, idempotency, retry scheduling, and dead-letter handling.
- No live PostgreSQL migration/RLS test, external receiver integration, multi-instance concurrency test, DNS rebinding test against real DNS, browser E2E, or production deployment was run.
- Therefore this package does **not** claim all connections are fixed or that webhooks are production reliable/certified.
