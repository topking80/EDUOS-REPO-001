# EduOS 36.6.0 — Automated School Operations

## Features
- Recurring school operations schedules for facilities, health-office operations, counseling follow-up queues, and meal-service workflows.
- Daily, weekly, and monthly cadence.
- Schedule list, create, pause/resume, and due-run endpoints.
- Due-run creates operational work items and advances the schedule to the next future occurrence.
- Uses row locks with SKIP LOCKED to reduce duplicate work when multiple authorized operators trigger due processing concurrently.
- Health and counseling summaries reject sensitive free text; this is task routing only, not clinical or counseling documentation.

## API
- `GET /api/school-operations/schedules`
- `POST /api/school-operations/schedules`
- `POST /api/school-operations/schedules/run-due`
- `POST /api/school-operations/schedules/:id/active`

A school leader must trigger due processing. For unattended operation, schedule the run-due endpoint through a protected internal job runner using a properly authenticated district/school service identity. No external notices are sent.

## Deployment
Apply migration `029_school_operations_automation.sql` and refresh runtime grants before deploying.

## Verification
Five focused contract tests and JavaScript syntax checks included. Live PostgreSQL/RLS concurrency, scheduler integration, browser E2E, and operational acceptance tests were not run.
