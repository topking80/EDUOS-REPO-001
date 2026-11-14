# EduOS 35.0.0 — Student Safety & Release Accountability

## Delivered
- Adds authenticated `GET /api/pickup/accountability` for school/district pickup leaders.
- Returns the selected school's current service-day release totals: released events, verified events, denied events, blocked events, and distinct learners released.
- Returns the latest 100 event records with learner, approved adult, relationship, event time, reason, and recording staff.
- Requires `pickup:manage`; principal scope is locked to the principal's own school. District-level managers must provide a valid school ID.
- Applies district and school predicates to all ledger reads, uses the school's service date, sets `Cache-Control: no-store`, and audits access.
- Does not add permissions for teachers, parents, drivers, or students.
- Updates application title, service-worker cache namespace, package metadata, SBOM, license inventory, and release provenance.

## Verification performed
- Focused tests: 11 passed, 0 failed.
- JavaScript syntax checks: 174 files, 0 failures.
- SBOM: 153 locked packages; 0 unknown licenses; 0 restricted-license candidates.
- Release provenance regenerated; source revision unavailable and signing not configured.
- ZIP integrity verified.

## Not verified
- Full repository suite, live PostgreSQL/RLS integration, production data behavior, browser end-to-end flows, and external notification delivery were not executed. Some tests require packages that are not installed in this build environment.

## Operational note
This endpoint is a read-only accountability ledger; it does not authorize a release. Staff must continue using the existing pass verification, photo-ID confirmation, custody-order acknowledgement, and release workflow. Run district CI, database/RLS integration, and browser E2E gates before production rollout. No new migration is required.
