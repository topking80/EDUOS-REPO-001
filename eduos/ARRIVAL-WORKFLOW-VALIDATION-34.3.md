# EduOS 34.3.0 — Morning Arrival End-to-End Validation

## Scope

This release extracts the arrival lifecycle's role/state decisions into a side-effect-free policy module and uses that module in the authoritative API handlers. This makes the critical transitions directly testable without a live database while preserving the existing tenant transaction, SQL scope predicates, RLS, and audit/event writes.

## Lifecycle contract

1. Principal initiates car-rider or walk-in arrivals; a driver initiates bus arrivals only with an assigned transport run.
2. A different authorized school staff member confirms physical receipt. Teacher receipt requires the assigned teacher or a roster relationship. Repeated receipt is idempotent; cancelled/non-pending records are rejected.
3. First attendance is limited to teacher/principal, requires a received handoff, and requires teacher assignment or roster membership.
4. Attendance creation retains school-local date selection, transaction advisory locking, and existing-record protection.
5. Database tenant scope, row-level security, and append-only event history remain in force.

## Validation

`test/arrival-workflow-e2e-34.3.test.js` exercises the policy transition matrix and verifies API/UI/schema integration contracts. These are deterministic policy and contract tests, not a live HTTP/PostgreSQL/browser E2E run.

## Not claimed

No live district database, OIDC provider, real transport feed, browser automation, or production deployment was exercised in this environment. Those remain release-gate tasks before production rollout.
