# EduOS 33.1.0 — Authorization Regression Baseline

## Scope
This increment adds executable regression coverage around the existing centralized authorization policy. It does not claim to replace a full route-by-route authorization audit or a live PostgreSQL tenant-isolation assessment.

## Controls tested
- Deny-by-default behavior for missing, malformed, unknown-role, unknown-resource, and unknown-action identities.
- Permission-map structure and absence of wildcard/admin shortcuts.
- IT administrator separation from student, attendance, assignment, and case records.
- Teacher/parent/pupil restrictions on district integration management and audit export.
- Explicit allowlisting of delegable permissions.
- Cross-school scope rejection for school-bound users and district-role scope behavior.

## Existing architecture observations
- `src/policy.js` centralizes role permissions and middleware.
- `requirePermission` checks role permissions before consulting time-bounded permission grants.
- `requireSchoolScope` rejects explicit school IDs outside a school-bound actor's scope.
- `src/db.js` provides `withTenantTransaction`, which sets district/user/role/school transaction-local context.

## Important limitations
- These tests exercise pure authorization policy and middleware behavior; they do not prove every route invokes the correct middleware.
- No live PostgreSQL/RLS integration or cross-tenant penetration test was run in this environment.
- The next gate should enumerate every Express route, map it to required permissions and scope checks, then exercise each route with multiple district/school identities against a disposable PostgreSQL database.
- No certification or production-security claim is made.

## Verification
Run:
`node --test test/security-authorization-baseline-33.1.test.js`
