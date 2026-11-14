# EduOS 34.8.0 — Morning Operations Command Center

## Scope

34.8 extends the existing authenticated principal/superintendent Command Center with a unified morning-readiness snapshot. It combines the already-authoritative arrival handoff, transport route, teacher-account, and AM transportation-to-classroom reconciliation feeds.

## New dashboard signals

- AM arrival reconciliation completion percentage.
- Count of assigned AM riders fully reconciled.
- Count of assigned AM riders requiring review.
- A prioritized action row when rider check-in, school handoff, or first attendance is incomplete.
- Direct navigation to the route-by-route reconciliation workspace.

The completion rate is calculated as fully reconciled riders divided by all assigned AM riders returned by the role-scoped reconciliation endpoint. `not_riding` is excluded from completed riders and remains outside the review count. An unavailable reconciliation feed displays an em dash rather than a misleading zero.

## Data and privacy

No new student data endpoint, schema, permission, or external provider integration was introduced. The dashboard reuses `/api/arrival/reconciliation`, which applies the existing authenticated role scope and tenant transaction. Existing UI text states that counts are based on records available to the current account and are not necessarily district-wide.

## Validation

- JavaScript syntax check: `public/api-bridge.js` and `src/server.js`.
- Focused tests: command-center feed, readiness metrics/navigation, package metadata.
- Full suite and live PostgreSQL/RLS/browser E2E must be run in an environment with the project's locked dependencies and configured database before production deployment.
