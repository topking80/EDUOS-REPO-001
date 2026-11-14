EduOS District Edition 32.0.34 — Connected Workflows

This release moves three workflows from browser-only / disconnected presentation into authenticated server-backed services.

1) Family messaging
- Parent / Guardian portal displays school contacts for a verified linked learner.
- Teacher and Principal workspaces include a Family Messages center.
- Messages are stored in PostgreSQL and scoped to the district and learner.
- A parent can message only active school staff associated with the learner's school (or a district superintendent).
- Staff can message only active parent/guardian accounts linked to that learner.
- Only sender and recipient can read a conversation message.
- Message read state is recipient-only and CSRF protected.
- Message sends create audit events.
- No email/SMS delivery or push notification is claimed.

2) Teacher classroom preferences
- Authenticated teacher/principal can save room, floor, layout, seat position and validated preference JSON to their account.
- Teacher writes are restricted to the account's assigned school.
- Preferences are restored from the server when the classroom planner is opened.
- Local browser storage remains only as a demonstration fallback when no authenticated teacher/principal session exists.
- These are teacher preferences, not surveyed floor plans or emergency routes.

3) SIS batch import adapter
- Superintendent-only, session-authenticated and CSRF-protected import endpoint.
- Imports validated student roster fields and attendance events for one district school.
- Student upsert keys use district + local student number.
- School changes are rejected rather than silently moving a student.
- Attendance source event IDs are idempotent across batches.
- Batch ID and payload SHA-256 are recorded.
- Every completed batch writes an audit event; sync runs are queryable by authorized school/district leaders.
- This is a controlled batch-import adapter, NOT a live vendor-specific SIS connector. A vendor adapter, service credentials, field mapping and scheduled synchronization still need to be configured for a district.

4) Authenticated role alignment
- After OIDC login, the visible workspace switches to the role returned by the server.
- Parent accounts land in Parent & Guardian Portal; teacher/principal accounts land in their respective workspaces.
- Persona switching in the demonstration interface is not an authorization control; server-side checks remain authoritative.

Database migration:
  npm run db:migrate

Run:
  npm ci
  npm test
  npm start

Migration 006_connected_workflows.sql creates:
- family_messages
- teacher_classroom_preferences
- sis_sync_runs
- sis_attendance_imports

Validation:
- Automated tests: 175 passed, 0 failed.
- Server, migration runner, API bridge and inline app JavaScript syntax checks passed.
- All 22 SVG files parsed successfully.

Not yet implemented / not verified:
- Guardian invitation email delivery, identity proofing and account activation.
- Secure notification delivery (email/SMS/push).
- Live SIS vendor APIs, scheduled sync workers, credentials and reconciliation dashboard.
- Live PostgreSQL migration execution and integration tests.
- End-to-end browser testing with a real OIDC provider.
- SIS field mapping and source-of-truth conflict policies approved by a district.
