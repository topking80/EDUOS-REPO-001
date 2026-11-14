# EduOS 32.25.0 — Arrival Integration Readiness Gate

## Release purpose
This is a release-gate and integration-contract advancement. It does **not** claim that arrival has become a server-backed student supervision workflow. The current arrival screen still uses browser `localStorage` and a selectable demo persona.

## Confirmed current-state findings
- `public/index.html` persists arrival rows and activity under `eduos_arrival_handoff_demo_v2`.
- Teacher assignment, car-rider check-in, bus handoff and first attendance are implemented as browser functions and update the local demo state.
- `activePersona` gates are UI checks only; they are not server authentication or authorization.
- Existing server-backed transport, pickup and attendance APIs are separate workflows. They do not yet form one transactionally linked arrival lifecycle.
- The existing attendance API accepts a standalone attendance event. It does not require a verified arrival or staff handoff.

## Required target contract for 32.26+
1. **Roster and assignment:** principal-authorized, school-scoped teacher/classroom assignment. Validate active student, teacher assignment, and school membership on the server.
2. **Car arrival:** authenticated staff records arrival method and time; no browser persona may authorize it.
3. **Bus arrival and handoff:** driver identity must match the assigned active route. Driver records arrival; receiving staff independently confirms handoff. A driver tapping “hand off” must not imply staff receipt.
4. **Teacher attendance:** teacher must have roster scope and a confirmed arrival/handoff before recording first attendance. Preserve a correction workflow rather than overwriting history.
5. **Idempotency and ordering:** database constraints and transaction locks prevent duplicate arrival, duplicate receipt, and out-of-order attendance. Offline replay must retain the original observed timestamp and enforce bounded replay windows.
6. **Audit and privacy:** append-only audit events; tenant and school isolation at both application and RLS layers; no student names, IDs, notes, or route details in generic operational SSE messages.
7. **Exceptions:** expected-but-missing, unreceived bus riders, unmatched route assignments, duplicate check-ins, and attendance-before-handoff are explicit states requiring authorized resolution.
8. **Tests:** migration tests on PostgreSQL, role matrix tests, cross-tenant and cross-school denial tests, race/idempotency tests, offline replay tests, and browser-to-API tests.

## Release guard added
The existing safety gate is retained and the package/version assertions are synchronized. The next implementation must not remove or weaken the prominent demo-only warning until the UI is actually backed by the authenticated APIs above. No fake API route or mock database was added in this release.

## Validation boundary
This release does not certify production readiness, FERPA/COPPA compliance, or operational suitability. PostgreSQL migration behavior and live role-based arrival flows remain unimplemented and unverified. Run the full suite in an environment with the declared dependencies installed before deployment.

## Verification results
- Focused arrival, release consistency, and connection tests: **20/20 passed**.
- JavaScript syntax checks across `src/` and `public/`: passed.
- Full test suite: **357 passed, 24 failed, 1 skipped** (382 total). The full suite remains red; see the release validation log. Do not deploy on the basis of the focused tests alone.
