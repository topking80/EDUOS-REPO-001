# EduOS 36.5.0 — Unified School Operations Command Center

## Included
- Unified command-center summary for facilities, health-office, counseling and meal-service queues.
- Work queue ordered by urgency and due date.
- School leadership assignment of work to active, same-school domain staff.
- Due-date support and escalation levels capped at three.
- Escalation raises priority and records an audit event.
- District roles see district-wide queues; school roles remain school-scoped; domain staff see their own queue.

## Privacy
Health-office and counseling queues remain operational routing only. This release does not add clinical records or confidential counseling notes.

## API
- `GET /api/school-operations/command-center`
- `POST /api/school-operations/:domain/:id/assign`
- `POST /api/school-operations/:domain/:id/escalate`

## Deployment
Apply migration `028_unified_school_operations.sql`, then deploy and restart. Ensure runtime grants are refreshed by the migration runner.

## Verification
Five focused static contract tests and JavaScript syntax checks. Live PostgreSQL/RLS, role provisioning, browser E2E, and school-user acceptance testing were not run.
