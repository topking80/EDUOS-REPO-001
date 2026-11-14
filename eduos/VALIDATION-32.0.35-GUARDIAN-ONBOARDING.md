# EduOS 32.0.35 — Guardian Onboarding Validation

## Automated checks
- Node syntax checks: `src/server.js`, `src/migrate.js`, and `public/api-bridge.js`.
- Inline application JavaScript syntax check.
- SVG asset XML parse.
- Full Node test suite, including new guardian invitation contract tests.
- ZIP integrity check.

## Scope of tests
The new tests verify route contract, token hashing/single-use logic, OIDC verified-email prerequisite, school matching, staff scoping, rate limiting, audit wiring, RLS declarations, and runtime grants. They are source-contract tests, not live database integration tests.

## Not verified in this environment
- PostgreSQL migration 007 has not been applied to a live database.
- RLS behavior and transaction/locking behavior have not been exercised against PostgreSQL.
- OIDC login, real guardian accounts, browser end-to-end acceptance, email delivery, and production HTTPS have not been tested.
- No independent custody/consent verification is performed by the software.

Do not describe this release as production-certified or as establishing FERPA/COPPA compliance. Complete district security, privacy, legal, database, and operational review before production use.

- Full suite result: 180 passed, 0 failed.
