# EduOS 32.0.28 — Streamlining and fix report

## Completed
1. Fixed the stale release-version test: it expected 32.0.26 while the package had advanced.
2. Hardened `withTenantTransaction` in `src/db.js`:
   - rejects missing tenant identity before acquiring a client;
   - tracks whether BEGIN succeeded;
   - attempts rollback only for an open transaction;
   - preserves the original operation error if rollback also fails;
   - always releases the client.
3. Hardened lazy pool shutdown so initialization state is reset after shutdown attempts.
4. Added `.gitignore` and a concise runbook.
5. Excluded installed `node_modules` from the release ZIP; consumers install from the lockfile with `npm ci`.

## Validation
- `npm test`: **148 passed, 0 failed**.
- JavaScript syntax checks: see validation run in this release.
- SVG XML parsing: see validation run in this release.
- ZIP archive integrity: verified.

## Not claimed
No live PostgreSQL, OIDC provider, Docker, Caddy, browser visual, or production deployment test is implied by the automated test result.
