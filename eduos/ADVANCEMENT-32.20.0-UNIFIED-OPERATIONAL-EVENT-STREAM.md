# EduOS 32.20.0 — Unified Operational Event Stream

## Implemented

- Added PostgreSQL `LISTEN/NOTIFY` publication for committed audit inserts.
- Added authenticated Server-Sent Events endpoint: `GET /api/operations/stream`.
- Enforced existing `audit:read` permission, tenant RLS, and principal school scope on every emitted row.
- Notification payload contains only district and event UUIDs. The API re-reads each event in the subscriber's tenant transaction before sending it.
- Stream payload is minimized to timestamp, actor role, action, resource type and outcome. No resource IDs, detail text, student information, prompts or agent output are streamed.
- Added an initial snapshot, `Last-Event-ID` replay support and keep-alive heartbeats.
- Connected the audit workspace to `EventSource`; it connects only while an authorized leader is viewing the audit workspace and closes with the response.
- Added migration `016_operational_event_stream.sql` and registered it with the migration runner.
- Updated package, lockfile, web shell version and mobile service-worker cache version to 32.20.0.

## Validation

- Unified operational stream tests: 5/5 passed.
- Focused connected-workflow, release-integrity and operational regression selection: 53/53 passed.
- JavaScript syntax checks: 63/63 passed across `src/` and `public/`.
- Full suite: 346 passed, 20 failed, 1 skipped (367 tests total). All 20 remaining failures are environment/dependency load failures involving missing local packages (`pg`, `express`, `jose`, `sharp` and `express-rate-limit`), rather than failing product assertions. The package lock declares these dependencies, but they are not installed in this workspace.
- No PostgreSQL test database was available, so migration execution and live LISTEN/NOTIFY delivery could not be exercised here.

## Important distinction

This is a PostgreSQL-backed SSE stream, not polling. It streams committed audit-ledger events from existing workflows. It does not imply every workflow has a richer domain-event payload; domain-specific attendance and transport fields remain in their protected workflow APIs. The event feed deliberately contains metadata only.

## Deployment gate

Run `npm ci` in a network-enabled build environment, then run `npm run db:migrate` using the migration-owner role before starting the new server build. Production clearance remains pending a real PostgreSQL migration/notification test, authenticated multi-role E2E test and dependency-restored full test run.
