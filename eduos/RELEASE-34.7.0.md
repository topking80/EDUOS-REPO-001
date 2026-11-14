# EduOS District Edition 34.7.0

**Release focus:** Transportation-to-Arrival Reconciliation

## Delivered
- New `GET /api/arrival/reconciliation` endpoint for authenticated principals, superintendents, and assigned bus drivers.
- AM route roster reconciliation across active rider assignments, latest driver check-in, run-specific school handoff, and school-local attendance.
- Exception states: missing route check-in, missing school handoff, awaiting school receipt, missing first attendance, duplicate arrival, not riding, and complete.
- New Arrival reconciliation workspace with route/student status summary.
- Alert dispatch retry correction: no dedupe ledger entry is created until at least one eligible active recipient is found.
- Updated release title, sidebar identity, mobile shell cache version, package metadata, and supply-chain provenance.

## Validation results
- Focused arrival/escalation/API-route tests: **14 passed**.
- JavaScript syntax checks: **166 files checked, 0 syntax errors**.
- Full repository test run: **437 passed, 21 failed, 1 skipped**. The 21 failures are blocked by unavailable installed dependencies in this environment (`express`, `sharp`, `jose`, `pg`, etc.); live integration suites cannot run without these packages and a configured PostgreSQL database.
- Dependency registry: **153 locked package entries verified**.
- SBOM: **153 packages; 0 unknown licenses; 0 restricted-license candidates**.
- Release provenance generated; source revision was unavailable and signing is not configured.
- No live PostgreSQL/RLS integration, browser end-to-end, scheduler delivery, or district deployment is claimed.

## Deployment notes
- Apply the existing ordered database migrations through the standard migration process; 34.7.0 introduces no new database migration.
- The escalation scheduler remains a separate protected job, configured as documented in `ARRIVAL-ESCALATION-34.6.md`.
- The reconciliation endpoint reads operational events only. It does not infer GPS location, automatically create missing records, or replace staff confirmation of physical custody.
