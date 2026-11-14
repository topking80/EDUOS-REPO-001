# EduOS 32.21.0 — Unified Workflow Event Categories

## Scope

Extends the authenticated PostgreSQL LISTEN/NOTIFY + Server-Sent Events operations stream introduced in 32.20.0. It does not replace authoritative workflow writes or introduce client-authored operational facts.

## Changes

- Added a fixed, allow-listed event taxonomy for attendance records, transportation run starts/completions, rider check-ins, pick-up release/denial, pick-up authorization changes, and AI orchestration records.
- Server classifies events from the already tenant-scoped audit row when sending the SSE message.
- SSE payload adds `eventType`, a fixed human-readable `label`, and a bounded `severity` (`info`, `success`, `warning`).
- No student names, student IDs, resource IDs, audit detail, prompts, free text, or GPS/location information are added to the SSE payload.
- The audit workspace announces the latest safe event label and refreshes its existing server-backed audit list.
- Bumped application and PWA shell cache version to 32.21.0.

## Security properties retained

- Stream requires an authenticated session and `audit:read` permission.
- PostgreSQL notifications still carry only district ID and audit event UUID.
- Each event is re-read under the subscriber's tenant/school transaction scope.
- Role authorization and RLS remain the source of truth; event labels are presentation metadata only.
- No client endpoint was added for fabricating attendance, transport, or dismissal events.

## Verification

Run `npm test` and `npm run test:integration` in an environment with the declared Node.js version and configured PostgreSQL database. Database migration 016 remains required for the underlying event stream.

The source-level focused tests cover classification and privacy-safe payload metadata. A live end-to-end test of actual PostgreSQL notifications, browser EventSource delivery, and role scoping must still be run against a configured database before production deployment.

## Test results in the extracted workspace

- Focused event taxonomy + stream + arrival + release-consistency checks: **31/31 passed**.
- JavaScript syntax checks across `src/` and `public/`: **passed**.
- Full `npm test`: **352 passed, 20 failed, 1 skipped** out of 373 discovered tests.
- The 20 remaining failures are environment/dependency failures in this extracted workspace: required packages including `express`, `express-rate-limit`, `jose`, `pg`, and `sharp` are not installed. No npm registry access was available to restore them.
- PostgreSQL migration 016 and live database-backed EventSource tests were not executed in this environment.

## Scope note

This release classifies server-audited attendance API writes, transportation run/check-in writes, pick-up release/denial writes, and recorded agent orchestration. The separate browser-local arrival/teacher-handoff demonstration is not silently promoted to a server-confirmed event source; it needs its own authenticated persistence endpoint before it can appear as authoritative district telemetry.
