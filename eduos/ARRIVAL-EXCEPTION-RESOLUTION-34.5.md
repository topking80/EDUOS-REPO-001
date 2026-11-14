# EduOS 34.5.0 — Principal Exception Resolution Center

## Delivered
- Authenticated principal/superintendent exception queue backed by current-day arrival records.
- Durable resolution records with open, acknowledged and resolved states.
- School- and district-scoped staff assignment; only active teacher/principal memberships in the same school qualify.
- Acknowledgement and assignment events are appended to an immutable history table.
- Resolution requires a note and is blocked while the underlying issue remains: pending handoffs cannot be closed, and missing attendance cannot be closed until a same-school-day attendance event exists.
- Role-scoped browser tab with assignment, acknowledgement, resolution and history actions.
- Existing arrival detection remains read-only; resolution never edits handoffs or attendance.

## API
- `GET /api/arrival/exceptions`
- `POST /api/arrival/exceptions/:handoffId/:kind/acknowledge`
- `POST /api/arrival/exceptions/:handoffId/:kind/assign` with `{ "assignedTo": "<user UUID>" }` or `null`
- `POST /api/arrival/exceptions/:handoffId/:kind/resolve` with `{ "note": "..." }`
- `GET /api/arrival/exceptions/:handoffId/history`

Supported kinds: `handoff_awaiting_receipt`, `first_attendance_missing`.

## Migration
Apply `db/018_arrival_exception_resolution.sql` after migration 017. Runtime role must have the required table privileges through the district's controlled migration/grant process. Both tables use forced RLS; history is append-only.

## Validation boundaries
Unit/contract tests and JavaScript syntax checks do not prove live PostgreSQL RLS behavior, identity-provider sessions, or browser workflows. Run the database integration suite against a disposable PostgreSQL instance before district deployment.
