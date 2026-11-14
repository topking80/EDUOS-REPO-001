# EduOS 36.7.0 — School Operations Notifications

## Included
- Per-user in-app notification preferences for due-soon, overdue, and escalation notices.
- Leadership-triggered dispatch of notices for assigned school operations work due within 24 hours or overdue.
- Unassigned work notices route to active principal/vice-principal memberships at that school.
- Idempotent delivery ledger prevents repeat notices for the same work item, recipient, and notice type.
- Reuses the existing EduOS in-app notification inbox.
- Notification text is generic and contains no student, patient, or counseling details.

## API
- `GET /api/school-operations/notification-preferences`
- `PUT /api/school-operations/notification-preferences`
- `POST /api/school-operations/notifications/dispatch-due`

## Delivery limits
This release sends in-app notifications only. Email, SMS, and push delivery are not enabled by this workflow. Dispatch requires an authorized school/district leader or a protected scheduled caller using an authorized session.

## Deployment
Apply migration `030_school_operations_notifications.sql` and refresh runtime database grants before deploying.

## Verification
Six focused contract tests and JavaScript syntax checks are included. Live PostgreSQL/RLS, multi-user concurrency, browser end-to-end, and external delivery-provider tests were not run.
