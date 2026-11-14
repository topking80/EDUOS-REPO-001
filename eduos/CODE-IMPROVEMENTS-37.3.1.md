# EduOS 37.3.1 — Code Improvement Report

This patch follows 37.3.0 and focuses on preventing outbound DNS resolution from indefinitely occupying webhook worker execution.

## Changes
1. `src/webhooks.js`: introduced `WEBHOOK_DNS_TIMEOUT_MS` (3 seconds by default, configurable with a capped `dnsTimeoutMs`). Resolution now races a bounded timeout and returns `dns_timeout` when the resolver stalls.
2. `src/server.js`: extended the outbox lease to two minutes to reduce premature job reclaim during slow but bounded outbound work.
3. Tests: added a never-resolving DNS regression case and an outbox lease assertion.
4. Release metadata: aligned package, lockfile, browser title/footer and service-worker cache version to 37.3.1.

## Focused verification
`node --test test/phase33-flow-webhooks.test.js test/durable-webhook-outbox-37.3.test.js test/connection-integrity.test.js`
Result: 30 passed, 0 failed.

## Known remaining gates
- The managed district worker/scheduler is not implemented.
- Migration 033 still needs live staging PostgreSQL execution and two-district RLS validation.
- Concurrent worker, lease expiry, restart recovery and receiver idempotency need live integration testing.
- Full project suite was not rerun for this patch; 37.3.0's prior full-suite result was 515 passed, 34 failed, 1 skipped.
- No production deployment was performed.
