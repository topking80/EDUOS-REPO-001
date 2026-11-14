# EduOS 32.0.9 Validation Report — Authentication Hardening

## Scope
Refine the Phase 32.0.8 constant-time comparison helper and add a Unicode regression
test without changing the authentication protocol or application authorization.

## Changes
- `src/auth.js`: `safeEqual()` now compares UTF-8 buffer byte lengths before calling
  `crypto.timingSafeEqual()`. This avoids a length-mismatch exception for equal
  JavaScript string lengths with different UTF-8 byte lengths.
- `test/phase32-hardening.test.js`: added behavioral coverage for equal and unequal
  values, Unicode byte-length mismatch, equal-byte-length Unicode mismatch, and
  non-string input. Existing CSRF allow/deny tests remain.
- `package.json`: version updated to `32.0.9`.

## Automated results
- `npm test`: 89 passed, 0 failed.
- `node --check src/auth.js`: passed.
- `node --check test/phase32-hardening.test.js`: passed.
- ZIP integrity: passed.

## Test environment qualification
The package dependency installation could not complete in the available environment.
The test run used temporary local stubs for import-time-only `cookie`, `dotenv`, `pg`,
and `jose` module loading. No live database or identity provider was contacted. The
89 passing tests therefore establish application test-suite behavior under that
limited test harness, not compatibility with a live PostgreSQL/OIDC deployment.
A clean `npm ci && npm test` with the real locked dependencies is still required.

## Not tested
- Live PostgreSQL and row-level security
- Live OIDC provider, PKCE exchange, and session lifecycle
- Browser end-to-end behavior
- Multi-instance OIDC state storage

## Release classification
Development security-hardening update. Not production-certified.
