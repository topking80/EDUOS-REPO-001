# EduOS District Edition 37.7.3

**Release type:** Broken-connections audit fix
**Base:** 37.7.2 (main at 7cd466a, after #125 DEV-03 classroom controls)
**Status:** Proposed; changes are on `fix/37.7.3-broken-connections`. Not deployed.

## Fixed

- **School operations command center, recurring schedules and reminder settings were unreachable.**
  `GET/POST /api/school-operations/:domain` was registered before the fixed paths
  `/api/school-operations/command-center`, `/schedules` and `/notification-preferences`.
  Express matched the parameter route first and treated `command-center`, `schedules` and
  `notification-preferences` as work-queue domain names, so every principal, vice principal,
  superintendent, IT admin and operations team member got `403 operations_access_denied`
  from the web and mobile Operations screens. `src/server.js` now registers the unified,
  automation and notification route sets before the per-domain work-queue routes. No route,
  permission or SQL changed.

## Tests

- `test/integration/school-operations-authz.test.js`: new case. The command center returns 200
  for principal, vice principal, superintendent, nurse and maintenance; a principal can list and
  create a recurring schedule and read reminder settings; teachers are still refused. It failed on
  37.7.2 (`p1 command center: {"error":"operations_access_denied"}`) and passes on 37.7.3, against PostgreSQL 16.
- `test/route-order-37.7.3.test.js`: new unit guard. It reads the register order in `server.js` and
  each route file in source order, and fails if any fixed path is preceded by a parameter route of the
  same method that would answer it. On 37.7.2 it reports the four swallowed routes.

## Not changed (audit findings left for review)

See `/workspace/repo-pr/AUDIT-BROKEN-CONNECTIONS-37.7.2.md` (outside the repo) for the full list. These
include the duplicate migration numbers 083 and 086 and the gap at 084. File names are the migration keys,
so renaming them would make deployed databases re-run them. Also listed: room-display and device clients for
`/api/classroom-agent/*` that are not in the repo, and the arrival-escalation job that has no compose service.

## Operator action

None beyond deploying the application. There are no migrations in this release.
