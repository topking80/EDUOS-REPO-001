# EduOS 32.24.0 — Replay-to-Live Continuity

## Change
The authenticated operational SSE endpoint now subscribes to PostgreSQL notifications before running its initial snapshot or `Last-Event-ID` replay. Notifications arriving during that query window are held in a bounded backlog (500 notices), then re-read through the same tenant/school-scoped audit query after replay completes. This closes a race where an event committed between the replay query and listener registration could otherwise be missed until a later refresh.

## Resource and privacy controls
- The notification backlog is bounded; overflow closes the stream and lets EventSource reconnect.
- Buffered notifications contain only the existing PostgreSQL notification payload (district ID and audit-event UUID); the server still re-reads the event in the subscriber's tenant/school context.
- The event sender continues to emit only the allowlisted event taxonomy and scoped operational metadata.
- Backlog memory is cleared on connection close.

## Validation
Focused source-contract tests verify listener registration precedes replay, backlog bounds, replay-to-live drain, and cleanup. JavaScript syntax checks and focused tests are recorded in the release summary. Live PostgreSQL race/load tests remain an environment-dependent deployment gate.

## Release verification
- JavaScript syntax validation: passed for all JavaScript files under `src/` and `public/`.
- Focused regression suite: 26/26 passed.
- Full test suite: 352 passed, 25 failed, 1 skipped (378 total). The failing tests are environment-blocked integration/server tests that cannot load packages absent from this extracted workspace (`express`, `express-rate-limit`, `jose`, `pg`, and `sharp`); this is not recorded as a clean full-suite pass.
- PostgreSQL integration, concurrent commit/replay race, and multi-replica load testing were not run; verify in a provisioned staging environment before production rollout.
