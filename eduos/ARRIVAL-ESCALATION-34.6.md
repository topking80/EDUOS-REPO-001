# EduOS 34.6.0 — Arrival Notifications and Escalation

## Delivered
- Scheduled escalation dispatcher: `npm run arrival:escalations`.
- School-local-day evaluation uses the existing exception classifier.
- Medium alerts: pending handoff at 10 minutes; missing first attendance at 15 minutes.
- High alerts: 30 minutes and 45 minutes respectively.
- Alerts are deduplicated by district, handoff, exception type and severity.
- In-app notifications go to active school principals and the assigned staff member; high-severity alerts also notify active district superintendents.
- Existing notification adapters may enqueue generic external-channel messages when explicitly configured. Email/SMS/push remain `off` or `log` dry-run unless a real provider adapter is separately implemented and configured.
- Authenticated notification inbox with unread count and mark-read actions.

## Migrations
The migration runner now includes both previously introduced `018_arrival_exception_resolution.sql` and new `019_arrival_escalation_alerts.sql`. Run `npm run db:migrate` with the migration-owner connection. Runtime grants are re-applied by the migration process.

## Scheduling
Run `npm run arrival:escalations` every five minutes using a protected migration-owner/service database credential. Do not expose that credential to the web process or browser. The ledger makes repeated runs idempotent per severity. Review scheduler logs and database health as part of operations.

## Privacy and delivery
Notification recipients are derived server-side from active memberships and the assigned staff member. In-app messages may include the student's name and school and are scoped to authorized school leadership/assigned staff. External channel payloads continue to use the generic privacy-preserving text from `src/notify.js`; student-identifying details are not sent externally.

## Validation boundaries
Focused tests and syntax checks do not prove live provider delivery, cron reliability, database RLS behavior or production scheduling. External messages are not claimed as delivered by this release.
