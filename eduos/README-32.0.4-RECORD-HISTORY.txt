EduOS District Edition 32.0.4 — Record History Consistency Update

This is a focused quality update to the Phase 32.0.3 integrated source. It does not add a new product module.

CHANGES
1. Student 360 now presents a normalized chronological history for attendance entries, family attendance acknowledgments, assignment publication, pupil submissions, grading, and intervention case notes.
2. Timeline entries identify the responsible user when the underlying source record supports attribution. Attendance recorder attribution is resolved through its corresponding audit event.
3. Attendance dates are normalized at UTC midnight for consistent timeline ordering and display across server time zones.
4. Family-facing intervention history now requires BOTH the case and the individual note to be explicitly marked family-visible. Existing linked-student authorization remains the outer access boundary.
5. Case updates append readable change summaries instead of serializing raw request fields and internal owner UUIDs into notes.
6. Student 360 renders a clearer, escaped, accessible chronological history list.

PRESERVED
- Phase 31.1 standalone district UI and performance optimizations.
- Authenticated server API, OIDC/PKCE session handling, CSRF, district RLS, access requests and permission grants.
- Student 360, attendance, assignments, intervention cases, Connected Services and existing role model.

VALIDATION
- 65 automated tests passed; 0 failed.
- Node syntax checks passed for src/*.js, test/*.js, and public/api-bridge.js.
- Both inline scripts in public/index.html passed Node syntax checking.
- ZIP integrity checked after packaging.

LIMITATIONS
- These are automated source/contract checks, not live PostgreSQL integration tests or browser end-to-end tests.
- OIDC sign-in was not exercised against a live district identity provider.
- Teacher access remains school-scoped in the existing authorization model, not course/roster-scoped. Do not treat this release as production-ready for sensitive student records until that boundary is tightened and independently tested.
- No FERPA/COPPA compliance claim is made.
