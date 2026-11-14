# Validation: EduOS 32.0.53 security and privacy fixes

Environment: Node.js 24.22.1, PostgreSQL 16.4 (local cluster), Butane 0.23.0,
Caddy 2, Python 3. Run on 2026-11-10.

## Results
| Suite | Command | Result |
|-------|---------|--------|
| Unit / contract | `npm test` | **257 passed, 0 failed.** That is 233 pre-existing tests (7 updated where they encoded the old behaviour), 23 new behavioural tests in `test/fixes-32053.test.js`, `test/deploy-32053.test.js` and `test/demo-mode-32053.test.js`, plus the skipped integration file, which counts as one entry. |
| Live PostgreSQL | `EDUOS_TEST_PG_URL=postgres://postgres@127.0.0.1:55432/postgres npm run test:integration` | **24 passed, 0 failed** |
| Edge intake (Python) | `python3 -m unittest tests/test_enrollment.py tests/test_enrollment_token.py` (in `edge-platform/eduos`) | **20 passed** |
| Ignition | `make ignition` (`butane --strict -d .`) | All 6 roles plus base compile; `edge-with-quadlet.bu` also compiles |
| Caddy | `caddy adapt` and a live `caddy run` with `curl -I` | CSP (frame-ancestors 'self'), nosniff, HSTS, X-Frame-Options and Referrer-Policy present on static responses |

Run the unit suite with a clean environment (`env -i PATH=$PATH HOME=$HOME npm test`).
Some pre-existing tests read configuration from the environment or `.env`, so
stray `OIDC_*` variables can change their results.

## How the integration suite works
`test/integration/harness.js` creates a throw-away database plus a fresh
**owner** role and a **runtime** role (NOSUPERUSER NOBYPASSRLS). It runs
`src/migrate.js` as the owner, which applies the grants, and seeds data as
the superuser. It then starts a mock OIDC provider (RS256, jose) and spawns
`node src/server.js` as the runtime role. Every request goes through the real
login flow (`/auth/login` → IdP → `/auth/callback`), the session cookie and
CSRF. The database and roles are dropped afterwards.

Coverage by finding: H1 (role checks, refusal to start as superuser or owner,
migrate refusal, RLS isolation), H2 (each affected route as the runtime role,
plus `has_table_privilege` for every table), H3, H4, M5, M6, M7, M9, M12
(read audit, export, delete, purge permissions, retention CLI), L15, L16, L17,
L18, L19, L21 (DB pending logins, single use, re-login revocation, per-user cap,
idle timeout), L23 and L24.

**Mutation checks:** reverting individual fixes in `src/server.js` makes the
matching integration test fail. This was checked for the H3 school checks, the
H4 regex, the M5 audit filter and the M6 draft filter.

## Additional manual checks
- **Compose-equivalent role flow:** on a fresh cluster whose bootstrap user is
  `eduos_admin`, `db/init/00-eduos-roles.sh` ran, then `migrate` as
  `eduos_owner`. The API started as `eduos_app` with `NODE_ENV=production`,
  https `PUBLIC_ORIGIN` and `DATABASE_SSL_ALLOW_PRIVATE_NETWORK=true`, and
  `/health` returned ok. The same API refused to start as `eduos_admin`
  (superuser), and failed without the private-network opt-out. The retention
  CLI succeeded as the owner and was denied as the runtime role.
- **Upgrade rehearsal:** on a database migrated by the pristine 32.0.52 code as
  superuser `eduos` and seeded with data, the role-split SQL
  (`db/upgrade/32.0.53-split-roles.sql`) ran, then the 32.0.53 migrate as
  owner. The 009 migration re-pointed all 17 memberships-based foreign keys,
  and the API started as `eduos_app`.

## Not validated
- Docker / Docker Compose themselves (no container runtime was available). The
  compose roles were reproduced against a local cluster as described above.
- Real third-party IdPs (Microsoft Entra ID `xms_edov`, Google). Only the mock
  IdP and unit tests of the claim logic were run.
- Browser end-to-end runs of the UI. Demo gating is tested by executing
  `public/eduos-mode.js` against a DOM stand-in.
- Building or booting edge images (the ISOs are 0-byte placeholders).

This is not a production certification.
