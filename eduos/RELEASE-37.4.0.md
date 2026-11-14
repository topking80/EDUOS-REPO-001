# EduOS 37.4.0 — DNS Retry Classification

## Change
Webhook delivery now distinguishes temporary DNS infrastructure failures (`dns_failure`, `dns_timeout`) from security-policy blocks. Temporary DNS failures are classified as `network_error` and retried within the configured bounded attempt budget with backoff. Unsafe DNS answers, including private or mixed public/private results, remain permanently blocked and are never sent to.

## Why
Previously, DNS outages were classified as `blocked`. The outbox treats blocked results as terminal, so a temporary resolver outage could dead-letter a valid webhook before its retry budget was used.

## Validation
- Focused webhook, durable-outbox and connection-integrity tests: 31 passed, 0 failed.
- Tests cover transient DNS failure followed by successful resolution and permanent rejection of private IP answers.
- Full project suite not rerun.
- Live PostgreSQL/RLS, multi-worker, managed scheduler and production deployment validation remain outstanding.

## Delivery semantics
At-least-once delivery. Receivers should deduplicate using `X-EduOS-Delivery`.
