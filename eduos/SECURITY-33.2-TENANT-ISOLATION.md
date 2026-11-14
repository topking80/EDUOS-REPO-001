# EduOS 33.2.0 — Tenant Isolation Regression

## Scope
This increment tests the PostgreSQL transaction-context boundary and runtime-role guard used by the application. It does not substitute for live PostgreSQL RLS integration testing.

## Verified behaviors
- District, user, role, and school context are set using transaction-local `set_config(..., true)`.
- District-level actors receive an empty school context rather than inheriting a pooled connection's prior school.
- Successful tenant work commits.
- Failed tenant work rolls back and releases its connection.
- Incomplete actor identity is rejected before acquiring a database connection.
- Startup refuses superuser, BYPASSRLS, and `students` table-owner runtime roles.

## Critical remaining validation
Run a disposable PostgreSQL environment with separate migration-owner and runtime roles. Seed two districts and schools, then prove SELECT/INSERT/UPDATE isolation across every RLS-protected table, under pooled connection reuse and rollback. The current tests use a deterministic fake client and do not claim live database isolation or penetration-test results.

## Run
`node --test test/security-tenant-context-33.2.test.js`
