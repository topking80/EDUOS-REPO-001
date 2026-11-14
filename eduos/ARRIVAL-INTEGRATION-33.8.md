# EduOS 33.8.0 — Authoritative arrival handoff API

## Delivered
- Migration `017_arrival_handoff.sql` creates tenant-scoped `arrival_handoffs` and append-only `arrival_handoff_events`.
- `src/arrival-routes.js` registers:
  - `GET /api/arrival/today`
  - `POST /api/arrival/handoffs`
  - `POST /api/arrival/handoffs/:handoffId/receive`
  - `POST /api/arrival/handoffs/:handoffId/first-attendance`
- Bus arrivals require a run assigned to the signed-in driver and an active rider assignment.
- Car-rider and walk-in arrival creation is restricted to principals at their school.
- A different staff member must independently receive the student.
- First attendance cannot be created before receipt; repeated submissions return the existing daily attendance record.
- Tenant RLS, school/role row policies, composite tenant foreign keys, restricted update columns, and append-only event records are included.

## Important boundaries
- The existing browser arrival screen remains labeled demo-only and still uses local storage. This release adds authoritative backend endpoints but does not yet wire that screen to them.
- The migration and routes have static/source regression coverage, but no live PostgreSQL migration or end-to-end HTTP workflow was run in this environment.
- The daily query uses the UTC day boundary for listing handoffs; district-specific school-time display should be aligned in the next UI integration step.
- Attendance creation checks for an existing event under a transaction advisory lock; existing attendance rows are not overwritten.
- The handoff event log is append-only; attendance remains in the existing `attendance_events` table.
