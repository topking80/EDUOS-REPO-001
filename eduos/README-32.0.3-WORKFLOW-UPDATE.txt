EduOS District Edition 32.0.3 — Workflow Consistency Update

This release improves the existing authenticated Connected Services workspace. It does not add a new product module.

Changes
- Server workspace refresh now loads independent data sections with Promise.allSettled rather than failing the entire workspace when one endpoint is unavailable.
- Successfully loaded sections remain available when another endpoint fails.
- Failed sections are identified by name with an actionable retry control.
- Refresh preserves the currently selected workspace tab instead of always returning users to Student 360.
- A loading guard prevents overlapping refresh operations from racing one another.
- The active tab is tracked centrally so form submissions, retry actions, and refreshes return users to the correct workflow.

Preserved
- Phase 32.0.2 navigation and accessibility refinements.
- Student 360 and intervention case workflows.
- Existing OIDC, session, CSRF, authorization, audit, and database migration boundaries.
- The standalone Phase 31.1 reference UI in demo/.

Validation
- Automated test suite: 59 passed, 0 failed.
- API bridge JavaScript syntax checked with Node.js.
- All server JavaScript files syntax checked with Node.js.
- Integrated HTML inline scripts syntax checked with Node.js.
- ZIP archive integrity checked.

Limitations
- These are automated source/contract checks, not a live browser end-to-end test.
- PostgreSQL migrations and row-level security have not been executed against a live database in this validation run.
- Live OIDC sign-in requires a configured identity provider and credentials and was not tested.
- Existing teacher visibility remains school-scoped, not course/roster-scoped; production deployment with sensitive student records requires roster-level authorization.
