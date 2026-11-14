# EduOS 34.9.0 — District Attendance Accountability

## Changes
- Adds school identity to the tenant-scoped AM transportation reconciliation feed.
- Adds a school-by-school accountability table to the Morning Operations Command Center.
- Reports assigned AM bus riders, fully reconciled riders, riders needing review, missing first attendance, and completion percentage.
- Explicitly labels the denominator: active assigned AM bus riders returned by reconciliation. Car riders, walk-ins, and students not assigned to an active AM route are not represented; this is not a whole-school attendance census.
- Preserves school/district tenant predicates on the schools join; no schema migration is introduced.

## Verification
- Focused tests: 10 passed, 0 failed.
- JavaScript syntax: 173 files checked, 0 failures.
- ZIP integrity: verified.

## Not verified
- Full repository test suite, live PostgreSQL/RLS integration, real district data, browser end-to-end tests, and production deployment were not run as part of this release.

## Deployment
Run the normal CI, database integration, tenant-isolation, and browser E2E gates before production rollout. No database migration is required.
