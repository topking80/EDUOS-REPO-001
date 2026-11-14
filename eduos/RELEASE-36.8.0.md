# EduOS 36.8.0 — School Staff Daily Workspace

## Included
- Shared daily workspace API aggregating assigned operational work, current-day checklist completion, handoffs, and active announcements.
- School leadership can create reusable daily/weekly/monthly/one-time checklists; staff can mark checklist items complete with one completion per item per day.
- Staff can create shift handoffs, optionally directed to an active colleague at the same school, and recipients can acknowledge them.
- Principals and vice principals can publish school-wide or operations-staff announcements.
- Workspaces retain district and school scoping; mutations require CSRF and are audited.
- Health-office and counseling handoffs are blocked to avoid storing confidential clinical or counseling content in the generic operations system.

## API
- `GET /api/staff-workspace`
- `POST /api/staff-workspace/checklists`
- `POST /api/staff-workspace/checklists/:itemId/complete`
- `POST /api/staff-workspace/handoffs`
- `POST /api/staff-workspace/handoffs/:id/acknowledge`
- `POST /api/staff-workspace/announcements`

## Deployment
Apply migration `031_staff_daily_workspace.sql`, apply the updated `db/runtime_grants.template.sql` permissions, then deploy application code.

## Verification
Five focused static contract tests and JavaScript syntax checks are included. Live PostgreSQL/RLS integration, browser E2E, load tests, and real staff acceptance tests were not run. The workspace API is implemented; existing app clients need to call these endpoints to render a fully interactive daily workspace screen.
