# EduOS 36.9.0 — District Staff Management Center

## Added
- Staff absence submission with date/time validation and principal/vice-principal review decisions.
- Staff shift creation with active same-district, same-school membership validation.
- Substitute coverage requests with approval, decline, and assignment decisions.
- District/school-scoped staffing summary and upcoming shift/coverage views for authorized roles.
- Audited mutations, authenticated routes, CSRF protection on writes, parameterized SQL, no-store response headers, and forced PostgreSQL row-level security on all three new tables.
- Privacy minimization: absence workflow stores only a broad category; it does not collect free-text medical details.

## API
- `GET /api/staff-management`
- `POST /api/staff-management/absences`
- `POST /api/staff-management/absences/:id/review`
- `POST /api/staff-management/shifts`
- `POST /api/staff-management/coverage`
- `POST /api/staff-management/coverage/:id/decision`

## Deployment
1. Back up PostgreSQL and verify the configured runtime role is non-superuser and has no `BYPASSRLS`.
2. Apply migration `032_district_staff_management.sql` using the existing migration runner.
3. Re-apply the updated `db/runtime_grants.template.sql` through the migration runner.
4. Deploy the server and monitor application errors and database query health.

## Verification performed
- New focused 36.9 tests: 3/3 passed.
- JavaScript syntax checks across all `src/**/*.js`: passed.
- Full repository test run: 509 passed, 36 failed, 1 skipped. Failures include historical release-version assertions that hard-code older package versions, dependency/integration tests requiring installed services/dependencies, and unrelated existing tests. This release is therefore **not certified production-ready** by the full test suite.
- No live PostgreSQL migration/RLS test, browser end-to-end test, load test, external security assessment, or deployment was performed.

## Known limitation
This milestone provides authenticated backend APIs and database workflows. It does not yet add a dedicated staff-management front-end screen or calendar UI. Districts must not enable this as a complete staffing product until UI integration, live database/RLS validation, full CI remediation, and operational acceptance testing are complete.
