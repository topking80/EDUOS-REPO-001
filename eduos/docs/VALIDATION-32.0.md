# EduOS Phase 32.0 — Student 360 and Intervention Cases

## Implemented
- Added an authenticated Student 360 read model combining student identity, attendance, assignment/submission status, visible intervention cases, and a chronological activity timeline.
- Added district-scoped intervention cases with school scope, category, priority, lifecycle status, owner, support plan, family-visibility flag, and follow-up date.
- Added append-only case notes. Case notes cannot be updated or deleted by the runtime database role; visibility is explicitly controlled per note.
- Added create, update, list, and append-note API routes with server-side role permissions, CSRF protection on mutations, district RLS, and audit events.
- Connected Services now includes Student 360 and Intervention Cases views, case creation, status update, and staff note entry.
- Preserved the Phase 31.1 standalone UI and previous server foundation.

## Access boundaries
- Superintendent: district-wide Student 360 and case access.
- Principal and teacher: own-school Student 360 and case access.
- Parent/guardian: only linked students; only cases and timeline notes explicitly marked family-visible.
- Pupil: linked Student 360 profile, attendance, and academics; no intervention-case access.
- Case creation and mutation are staff-only. The current membership model does not include teacher-to-course/roster assignments, so teacher scope remains the existing school-level scope; production deployment should add roster-level authorization before granting teacher access to sensitive cases.

## Validation
- Node syntax checks: `src/server.js`, `src/migrate.js`, and `public/api-bridge.js`.
- Automated test suite: 50 passed, 0 failed. Tests include migration/RLS contracts, Student 360 composition, mutation guards, migration ordering, and UI wiring.
- PostgreSQL migration execution, live OIDC, and browser end-to-end testing were not performed in this environment.

## Important boundaries
- Existing UI persona switching and localStorage data remain a synthetic demonstration, separate from authenticated server records.
- No claim of FERPA/COPPA compliance or production readiness is made by this phase.


## Phase 32.0.1 quality pass
- Removed internal `support_plan` from the Student 360 case response. Family-visible case summaries remain governed by the explicit `family_visible` flag.
- Fixed Student 360 panel rendering so opening a profile from Intervention Cases does not replace the entire workspace or remove navigation. Added a close control.
- Added two regression tests. Full Node test suite: 52 passed, 0 failed.
- Re-ran JavaScript syntax checks for the server and API bridge. Live PostgreSQL, OIDC, and browser E2E remain unverified.
