# EduOS 32.0.10 Validation Report

## Scope

- Per-attempt OIDC state-cookie naming and callback clearing.
- Bounded, expiry-pruned pending login transaction storage.
- Single-use callback state and maximum state length.
- OIDC authorized-party (`azp`) validation.
- Regression coverage for existing authentication, authorization, workflows,
  agent governance/orchestration, Student 360, and UI behavior.

## Results

- `npm test`: **96 passed, 0 failed** in the prepared test environment.
- `node --check`: all `src/*.js` and `test/*.js` files passed.
- Inline scripts in `public/index.html`: both script blocks passed syntax checks.
- Package version and lockfile root version: 32.0.10.

## Dependency qualification

A clean `npm ci --ignore-scripts --no-audit --no-fund` attempt timed out in this
environment. The test run therefore used temporary local import stubs for
`cookie`, `pg`, `dotenv`, and `jose` so the repository's test suite could execute.
Those stubs were used only for this validation run and are not included in the
release archive. The suite's source-contract and pure helper tests passed, but
this is not equivalent to running against the actual locked dependency builds.
A clean environment must run `npm ci` and `npm test` before deployment.

## Not performed

- Live PostgreSQL migration, RLS, session persistence, or concurrent transaction tests.
- Real OIDC provider login, JWKS signature verification, nonce, PKCE, and `azp` integration tests.
- Multi-instance OIDC callback validation; pending login state is still process-local.
- Browser end-to-end tests, including two-tab sign-in against a real identity provider.
- Production penetration testing or deployment certification.

## Release assessment

The source changes are syntax-checked and covered by repository tests, but the
release is a development hardening candidate. Do not treat the validation as
proof of production readiness. Complete clean dependency installation and live
identity/database/browser validation in the deployment environment.
