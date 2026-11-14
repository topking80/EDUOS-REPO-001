# EduOS 32.0.50 — Authenticated Workflow Guard Tests

## What changed

This release adds executable guard-level regression coverage for the existing authenticated workflow architecture.

- Rejects requests with no session cookie before protected handlers advance.
- Exercises CSRF rejection for missing, malformed, oversized, and incorrect tokens, plus acceptance of the matching session-bound token.
- Exercises school-scope boundaries for teachers, principals, and district superintendents.
- Expands the least-privilege role matrix across audit export, case approval, attendance acknowledgement/creation, assignment submission, and webhook administration.
- Adds route-chain regression checks to keep session and CSRF middleware ahead of sensitive state-changing family messaging, classroom preferences, SIS import, guardian invitation, access-request, and attendance routes.
- Updates package, lockfile, application title, and release assertions to 32.0.50.

## Scope and limitations

These are unit and source-contract tests against the actual middleware and route declarations. They do **not** constitute a live authenticated browser-to-API end-to-end run. This environment has no configured district database or OIDC provider, so real login, database-backed tenant isolation, live role sessions, and district workflow transactions were not exercised. No production compliance or certification claim is made.

## Run

```bash
npm test
```

The authentication middleware module requires the normal environment configuration at import time. The guard test supplies non-production test-only configuration values; it does not connect to the configured database because the no-cookie session test exits before database access.
