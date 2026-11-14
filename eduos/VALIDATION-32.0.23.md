# EduOS 32.0.23 — Deployment Hardening Validation

## Changes applied
- Removed host-published `8080:8080` from the application service.
- Split Compose networking into an internal backend network and a dedicated edge network.
- Restricted trusted proxy configuration to Caddy's fixed edge address (`172.30.0.2/32`).
- Assigned Caddy the fixed edge address `172.30.0.2`.
- Removed `immutable` from cache headers for non-content-hashed assets; set a one-hour revalidation policy.
- Added a dedicated missing-asset handler so missing JS/CSS/SVG/PNG/font requests return 404 rather than the SPA shell.
- Updated package and lockfile release metadata to 32.0.23.
- Added six deployment-hardening regression tests.
- Preserved the source artwork and existing application UI.

## Validation performed
- New deployment-hardening tests: **6 passed, 0 failed**.
- JavaScript syntax checks: **10 passed**.
- SVG XML parsing: **12 passed**.
- Full test suite: **122 passed, 9 failed**.
- ZIP integrity: checked after packaging.

## Remaining blockers / not verified
The nine full-suite failures are test-process failures caused by unavailable installed dependencies in this environment. The observed missing package is `pg`; dependent integration tests cannot load. The package manifest and lockfile declare dependencies, but no successful dependency installation was available here.

Docker and Caddy executables are not installed in this environment. Therefore:
- `docker compose config` was not run.
- `caddy validate` was not run.
- No live HTTP/2 or HTTP/3 handshake was run.
- No container-level network isolation test was run.
- No browser visual regression was run.

## Deployment note
The edge profile is now the intended public ingress. The app has no host-published API port. Start with:
`cp .env.example .env`
Set strong secrets and real OIDC configuration, then:
`docker compose --profile edge up --build`

This is a source/configuration hardening release, not a production-readiness or FERPA/COPPA certification.
