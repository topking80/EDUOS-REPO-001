# EduOS 34.7.0 — Transportation-to-Arrival Reconciliation

## What changed
- Added authenticated `GET /api/arrival/reconciliation` for principals, superintendents, and drivers.
- Reconciles active AM route assignments against the latest append-only transport check-in, matching run-specific school handoff, and school-local first attendance.
- Classifies missing route check-ins, missing school handoffs, pending physical receipt, missing first attendance, duplicate handoffs, not-riding reports, and complete records.
- Added an Arrival reconciliation workspace for route-by-route operational review.
- Hardened 34.6 escalation dispatch: the immutable alert dedupe key is not consumed when there are no eligible recipients, allowing a later scheduler run to retry.

## Security and data handling
- API requires an authenticated session and allows only principal, superintendent, and driver roles.
- Query remains within the district transaction/RLS context. Principals are school-scoped; drivers are limited to routes assigned to their user; superintendents are district-scoped.
- Read requests are audited and responses are `Cache-Control: no-store`.
- No student location is inferred from GPS. This feature reconciles recorded operational events only.

## Validation
- Unit tests cover reconciliation states and contract checks for the authenticated SQL/API/UI wiring.
- Syntax checks and package integrity are run for this release.

## Operational limits
- This release does not generate missing check-ins, handoffs, or attendance records; it identifies mismatches for staff review.
- It does not prove physical custody or bus arrival location.
- Live PostgreSQL/RLS integration, production scheduler execution, and browser end-to-end tests require a configured district environment and are not claimed by static/unit validation.
