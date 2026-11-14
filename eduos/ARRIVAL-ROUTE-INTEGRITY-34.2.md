# EduOS 34.2.0 — Arrival Route Integrity

## Delivered

- Bus-driver arrival student options are partitioned by the selected active transport run. The initial selection is constrained to the first active run; changing runs updates the available rider list.
- The student selector is disabled with an explanatory notification when the selected run has no assigned riders.
- Arrival UI collection handling now validates feed collection shapes before iterating, so missing or malformed students, teachers, routes, stops, riders, or handoffs do not crash the register renderer.
- Existing server validation remains authoritative: driver identity, school, route-run ownership, and active rider assignment are checked on submission. UI filtering is usability only and is not treated as authorization.
- Regression test confirms school-local date boundaries, tenant/school scoping, independent receipt, and attendance ordering remain in place.

## Verification

- Focused arrival, authorization, and tenant-context tests: 28/28 passed.
- API bridge syntax check passed.
- Dependency registry verification: 153 locked entries passed.
- SBOM check: 153 packages, 0 unknown licenses, 0 restricted-license candidates.

## Not verified

No live PostgreSQL, OIDC, browser automation, district API, or deployment test was performed. Static contract tests do not replace end-to-end validation. UI filtering does not replace server-side route/rider authorization.
