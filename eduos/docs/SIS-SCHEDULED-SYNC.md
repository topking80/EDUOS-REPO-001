# SIS-02: Scheduled roster synchronization

Scheduled sync is opt-in per connector. It is disabled until a district manager configures an interval and a different district manager approves that schedule. Connector approval remains a separate prerequisite.

## Controls

- Configure: `PUT /api/integrations/connectors/:id/schedule` with `{"intervalMinutes":1440}` (15 minutes through 7 days).
- Approve: `POST /api/integrations/connectors/:id/schedule/approve`.
- Inspect: `GET /api/integrations/connectors/:id/schedule`.
- Pause one connector: `POST /api/integrations/connectors/:id/schedule/pause`.
- Pause every enabled schedule in a district: `POST /api/integrations/schedules/pause-all`.
- Resume one approved schedule: `POST /api/integrations/connectors/:id/schedule/resume`.

A connector URL, credential, scope, or school-map change returns the connector to pending approval and increments its config version. Scheduled work is cancelled unless the connector and schedule still have matching approved versions at the final import transaction.

## Worker

The API runs a guarded scheduler sweep every 60 seconds when `INTEGRATIONS_KEY` is configured. A one-shot dispatch can also be run with:

```sh
npm run sis:sync
```

The worker uses database row locks with `SKIP LOCKED`, per-job lease tokens, and a maximum of five attempts with exponential backoff. It processes each job within its district RLS context and imports through the same planner and SIS batch writer as manual connector sync.

## Attribution and data scope

Scheduled runs use the fixed `sis_scheduler` service principal. They do not create or impersonate a user. The human who approved the connector and the human who approved the schedule remain recorded separately. Service-initiated runs appear in connector run history and SIS import history.

This feature imports roster data only. It does not write grades, attendance, staff, course enrollments, or other data back to the external SIS. Live district-tenant validation is required before production enablement.
