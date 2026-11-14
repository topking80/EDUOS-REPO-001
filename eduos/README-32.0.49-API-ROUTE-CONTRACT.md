# EduOS 32.0.49 — API Route Contract

This release adds a source-level contract check between the browser API bridge and Express routes. It verifies that every literal API endpoint referenced by the bridge resolves to a declared server route, and checks that critical routes retain session, role/permission, and CSRF middleware.

## Scope
- Browser-to-server API route presence.
- Same-origin request credentials.
- CSRF header behavior for state-changing requests.
- Critical student, guardian and webhook route middleware.

This is a contract/static integration test. It does not execute authenticated API requests against PostgreSQL or an OIDC provider.
