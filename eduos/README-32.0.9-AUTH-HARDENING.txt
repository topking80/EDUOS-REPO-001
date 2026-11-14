EduOS District Edition 32.0.9 — Authentication Hardening

This release carries forward the supplied Phase 32.0.8 hardened baseline and refines
the constant-time comparison helper used for OIDC browser-state binding and CSRF
digest validation.

Changes
- safeEqual() now converts both strings to UTF-8 buffers before checking byte lengths.
- crypto.timingSafeEqual() is called only when the byte lengths match, preventing
  a RangeError for strings whose JavaScript character counts match but whose UTF-8
  byte lengths differ.
- OIDC state-cookie and CSRF digest checks continue to use safeEqual().
- Added a behavioral regression test for ASCII equality, unequal values, Unicode
  inputs with different UTF-8 byte lengths, and non-string input.
- Updated package version to 32.0.9.

No changes were made to OIDC flow, session issuance, cookie policy, authorization,
database schema, or application workflows.

Run with Node.js 22 or newer:
  npm ci
  npm test

This is a development security-hardening update, not a production certification.
Live PostgreSQL/RLS, real identity-provider OIDC, and browser end-to-end tests are
not represented by the automated unit/source tests in this package.
