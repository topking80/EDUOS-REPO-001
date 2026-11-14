# EduOS 37.3.1 — Webhook Reliability Patch

## Improvements
- Added a bounded DNS resolution timeout to outbound webhook delivery. A stalled resolver now fails with `dns_timeout` rather than holding an outbox worker lease indefinitely.
- Increased the outbox lease from 45 seconds to 2 minutes to reduce premature reclaim while a worker performs bounded outbound operations.
- Added regression coverage for stalled DNS resolution and lease configuration.
- Kept destination validation fail-closed: all DNS answers must still be public and the vetted address remains pinned for the request.

## Validation
- Focused flow/webhook, outbox, and connection-integrity tests: 30 passed, 0 failed.
- Full project test suite and live PostgreSQL/RLS integration were not rerun for this patch.
- This patch does not add the still-required managed per-district scheduler. Restart recovery continues to depend on subsequent authenticated district activity.

## Deployment status
Not deployed. Run migration 033 and the complete staging validation gates before production use.
