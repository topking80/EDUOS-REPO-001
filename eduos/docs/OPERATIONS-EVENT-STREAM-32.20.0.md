# EduOS 32.20.0 — Unified Operational Event Stream

## Architecture

EduOS now exposes `GET /api/operations/stream` as an authenticated Server-Sent Events (SSE) endpoint. PostgreSQL publishes an `eduos_operational_events` notification after each committed `audit_events` insert. The notification payload contains only the district UUID and audit-event UUID. The API then re-reads the row under the requesting actor's transaction-local tenant context and applies the same district/school visibility boundary used by the audit workspace.

The stream emits only timestamp, actor role, action, resource type and outcome. It never emits resource identifiers, free-text detail, original prompts, agent output, student names or student records. The audit workspace opens the stream only while an authorized superintendent, IT administrator or principal is viewing that workspace. Leaving the workspace closes the connection.

## Operational coverage

Because attendance, transport, pickup, classroom and orchestration workflows write to the append-only audit ledger, committed records from those workflows can appear in the same stream. This release does not invent domain events or infer operational state from animation; it reflects server-recorded audit writes.

## Deployment

1. Deploy the application files.
2. Run `npm run db:migrate` with the migration-owner database credentials. This applies `016_operational_event_stream.sql` and installs the PostgreSQL notification trigger.
3. Start the API with the normal restricted runtime database role.
4. Sign in as a superintendent, IT administrator or principal and open the Audit / Operations workspace.
5. Verify the live connection indicator and generate a permitted audit event in a second session.

The stream uses the existing session cookie and `audit:read` permission. It does not require a CSRF token because it is a read-only GET. PostgreSQL notifications are sent only after transaction commit.

## Limits and verification

- SSE connections consume one PostgreSQL listener connection each; size the pool for expected concurrent operators.
- The browser receives a small initial snapshot and uses the SSE `Last-Event-ID` cursor for reconnect replay.
- No WebSocket dependency or third-party streaming service is introduced.
- This package has static and unit coverage. A live PostgreSQL migration/notification test and multi-browser end-to-end test still require a configured database environment.
