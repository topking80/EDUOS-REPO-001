# EduOS 37.1.0 — Staff Management Workspace

## Added
- Mobile Staffing workspace tab for teachers, principals, vice principals, superintendents, counselors, nurses, maintenance and lunch staff.
- Absence request submission with date validation and privacy guidance against entering medical details.
- Leadership review actions for pending absence requests.
- Leadership substitute-coverage request creation, approval and decline actions.
- Upcoming shift and staffing status visibility.
- Version metadata and service-worker shell cache aligned to 37.1.0.

## Security and data handling
- UI uses the existing authenticated API client, which obtains and sends CSRF tokens for mutations.
- Authorization, school/district scoping, database transactions, RLS and audit logging remain enforced by the existing server routes and migration.
- No free-text medical detail field is provided.

## Validation
- Focused staffing and daily-workspace tests: **12 passed, 0 failed**.
- `node --check public/app/app.js`: passed.
- Full `npm test`: **508 passed, 37 failed, 1 skipped**. The failing set includes stale historical release-version assertions and environment-dependent integration/security tests; they remain unresolved and must be triaged in CI.
- ZIP integrity: verified after packaging.

## Not included / not certified
- Mobile shift creation and staff assignment UI.
- Live PostgreSQL migration/RLS execution.
- Browser end-to-end, load, external security, and district user acceptance testing.
- Production deployment or production certification.

This release is a development milestone, not authorization to deploy to production.
