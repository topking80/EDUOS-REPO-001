# EduOS 34.8.0 Release Notes

**Release:** Morning Operations Command Center

## Included
- Principal/superintendent Command Center now loads the authenticated AM arrival reconciliation feed.
- Adds AM reconciliation completion percentage, completed rider count, and riders requiring review.
- Adds an actionable priority-queue item for incomplete rider journeys.
- Adds direct navigation to route-by-route reconciliation.
- Displays unavailable metrics as unavailable rather than treating a failed feed as zero.

## Validation performed
- Focused tests: 3 passed, 0 failed.
- JavaScript syntax checks: performed across the repository's JavaScript files.
- ZIP integrity: verified after packaging.

## Not verified
- Full repository tests: not run because `node_modules` is absent in this build environment.
- Live PostgreSQL migrations/RLS, production scheduler, browser E2E, and external notification delivery were not tested by this release task.

## Deployment note
Deploy only after the district's normal CI, database integration, tenant-isolation, and browser E2E gates pass. No new database migration is required for 34.8.0.
