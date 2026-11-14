# EduOS 34.4.0 — Arrival Exception Classification

This release adds a deterministic, read-only classifier for two operational exceptions:

- `handoff_awaiting_receipt`: a pending arrival has remained unreceived for at least 10 minutes (high severity at 30 minutes).
- `first_attendance_missing`: a received handoff has no first-attendance record after 15 minutes (high severity at 45 minutes).

Thresholds are configurable by the caller. Results are stable, oldest-first, and include opaque record IDs plus school/student identifiers already present in the authorized input. The classifier does not query the database, create notifications, mutate attendance, or bypass route authorization. It must only receive records already scoped by the server for the requesting actor.

## Verification boundary

Unit tests cover thresholds, severity escalation, invalid/future timestamps, deterministic ordering, and completed records. This release does not yet persist exception acknowledgements or escalation history and does not claim a live district feed integration. Those require a separately authorized API/database migration and browser validation.
