# EduOS 32.0.51 — Tenant Isolation Contract

## Release focus

This release strengthens regression coverage around district and school data boundaries. It builds on 32.0.50 and preserves the existing application, API, visual identity, and workflows.

## Added

- A tenant-isolation contract test covering all 19 tenant-owned tables declared across database migrations.
- Checks that tenant-owned tables have row-level security enabled and forced, with district-scoped `USING` and `WITH CHECK` policies.
- Checks the initial migration's dynamic RLS policy loop for schools, students, student-user links, attendance events, and audit events.
- Checks the tenant transaction helper sets district, user, and role context with transaction-local `set_config`, commits successful callbacks, rolls back failures, and releases its connection.
- Checks representative school-scoped SQL and role-sensitive school boundaries.
- Updates package, lockfile, app title, and release expectations to 32.0.51.

## Validation

Run `npm test` from this directory. The complete Node test suite passes: 228 passed, 0 failed.

The added checks are migration/source contract tests. They do not connect to PostgreSQL and do not simulate two actual tenants against a running database. The release therefore does not claim runtime tenant-isolation certification.
