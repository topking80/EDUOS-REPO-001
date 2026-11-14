# EduOS 32.0.11 — Validation Report

## Scope
UI-only integration of the supplied 32.0.9 Connected Services presentation
onto the 32.0.10 security baseline.

## Passed
- `node --check`: 27 JavaScript files passed.
- Embedded application script extracted from `public/index.html`: syntax check passed.
- Dependency-independent automated tests: 86 passed, 0 failed.
- Added UI refresh contract tests: 5 included in the passing dependency-independent run.
- ZIP archive integrity: checked after packaging.
- Baseline preservation: `src/auth.js`, `src/oidc.js`, server, migrations, policy,
  and database source retained from 32.0.10.
- Integration review: `public/api-bridge.js` presentation changes were limited
  to stylesheet refinements, actor label/title presentation, and a loading
  status. API routes, escaping helper, and request/role workflow code were
  preserved.

## Blocked / not verified
- Full `npm test`: 101 total; 93 passed and 8 failed because the environment
  lacked installed `cookie` and `jose` packages required by tests that dynamically
  import `src/auth.js` and `src/oidc.js`.
- `npm ci` attempted but timed out while accessing the npm registry.
- `npm ci --offline` could not complete because `xtend@4.0.2` was not cached.
- No live browser E2E test was run for this package.
- No live PostgreSQL/RLS, OIDC provider, or multi-instance test was run.

## Required before deployment
In a network-enabled environment, run:
1. `npm ci`
2. `npm test`
3. `node --check public/api-bridge.js`
4. Browser sign-in and workspace smoke tests against a configured OIDC provider
   and PostgreSQL database.

This is a development UI integration release, not production certification.
