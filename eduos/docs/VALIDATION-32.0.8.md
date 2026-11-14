# EduOS 32.0.8 Validation Report — Security Hardening

## Scope
Integrates the constant-time secret-comparison hardening into src/auth.js and
adds a permanent audit test.

## Changes
- src/auth.js: added safeEqual() (crypto.timingSafeEqual + length guard); used
  in requireCsrf and the OIDC state (browser-binding) check. Removes the two
  timing-unsafe `!==` secret comparisons.
- test/phase32-hardening.test.js: new audit test (source assertions that the
  constant-time helper is used in both sites and the old compares are gone, plus
  functional requireCsrf tests: correct token -> next; wrong/missing/null -> 403).
- test/integration-phase26.test.js: the state-binding assertion updated to the
  hardened form.

## Automated results
- `npm test`: 88 passed, 0 failed (81 prior + 7 new), runs with no external env.
- `node --check src/auth.js`, `test/phase32-hardening.test.js`: passed.

## Independent runtime re-validation (unchanged behavior)
- Live OIDC end-to-end (mock IdP + live PostgreSQL): 16/16 — valid CSRF -> 201,
  missing CSRF -> 403, tampered state -> 400, full login/logout intact.

## Not changed (by design)
- OIDC pending-state store remains in-memory (bounded by login rate limiting);
  Redis recommended only for multi-instance.
- email_verified enforcement already present in verifyIdToken.

## Release classification
Development quality/hardening update. Not certified or production-ready.
