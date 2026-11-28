<!--
EduOS pull request. Fill in every section; write "None" where nothing applies.
A section left blank is a review question, not an answer. Progress is measured
by completed, tested capabilities, not by merged PRs (repository audit, Nov 27).
-->

## What and why

<!-- One or two sentences: the capability, the finding it closes, or the bug it fixes. Link the roadmap item (e.g. SEC-07, LRH-08, Phase 2 nurse). -->

**Roadmap item:**
**Status after merge:** <!-- complete and tested | partial (what's left) | plan or audit only -->

## Applications affected

<!-- Tick each app whose behaviour or data changes, and say how (web, Flutter, both). -->

- [ ] Student
- [ ] Parent / guardian
- [ ] Teacher
- [ ] Principal
- [ ] Vice principal
- [ ] Nurse
- [ ] Superintendent / district
- [ ] Maintenance
- [ ] Bus driver
- [ ] SRO / safety
- [ ] Homeschool / private school
- [ ] Devices, kiosks, EDEN nodes, integrations
- [ ] None (docs, CI or tooling only)

## API endpoints

<!-- New or changed routes, with method and path. Each new route needs a session guard, or an entry in the PUBLIC list of test/route-inventory.test.js (docs/API-ROUTE-INVENTORY.md). -->

## Database migrations

<!-- db/NNN_*.sql files, and whether each one is safe on a populated database and on upgrade (test/integration/upgrade-path.test.js). Grants added to db/runtime_grants.template.sql. -->

## Authorization rules

<!-- Roles, row-level security policies and definer functions added or changed. Who can now read or write what, at which scope (own record, roster, school, district). Confirm nothing widens an existing boundary. -->

## Tests

<!-- What proves it works: unit, integration against real PostgreSQL as the runtime role, e2e/axe, Flutter. Include a negative test for every new permission. Paste local results. -->

- Unit:
- Integration:
- Other:

## Release dependencies

<!-- Config or environment flags, feature switches, external services, data backfills, mobile releases or other PRs this needs or blocks. -->

## Governance checklist

- [ ] No vendor gets unrestricted student-data access.
- [ ] No external grade changes without district authorization.
- [ ] No weakening of existing RLS or school boundaries.
- [ ] No automatic student transfers.
- [ ] No unapproved third-party data sharing.
- [ ] No compliance claims without documented evidence and appropriate review.
- [ ] No GPS tracking of bus drivers; no camera access (getUserMedia); the web app stores nothing in localStorage.
- [ ] No secrets or real credentials in the change; test credentials are generated at runtime.
