# EduOS 37.0.0 — Production Readiness Gate

## Scope
This release advances the 36.9.0 district staff-management baseline with a repeatable, fail-closed production configuration preflight and a deployment architecture decision record.

## Added
- `npm run release:preflight` validates the actual runtime configuration in production mode before a release is promoted.
- The preflight refuses missing required settings and inherits runtime checks for HTTPS public origin and OIDC issuer, PostgreSQL TLS policy, placeholder database passwords, disabled demo mode, session-cookie policy, and bounded operational settings.
- Additional checks cover insecure webhook loopback, optional webhook signing-key strength, optional metrics-token strength, and HTTPS for configured school-node hub URLs.
- The preflight prints only pass/fail and the public host; it never prints environment values or credentials.

## Deployment architecture decision
EduOS is currently a Dockerized Express application with PostgreSQL, a one-shot migration service, and separate operational jobs. The repository does not contain a Vercel adapter or a linked Vercel Git project. A direct Vercel serverless conversion is not approved by this release because it would require explicit design and validation for database pooling, migrations, scheduled/worker processes, persistent node identity, and runtime health checks.

Use the existing production container (`Dockerfile` target `app`) on a container-capable host with managed PostgreSQL. Vercel may be used for a separately designed static frontend or preview surface after that boundary is implemented; do not deploy the complete backend as a serverless function by guessing at compatibility.

## Release sequence
1. Run `npm ci` and `npm test` in CI.
2. Run dependency, secret, filesystem/IaC, and container scans from `.github/workflows/ci.yml`.
3. Run PostgreSQL integration tests and the Docker/browser smoke tests.
4. Build and scan `Dockerfile` target `app`.
5. In the protected deployment environment, set the approved production variables and run `npm run release:preflight`.
6. Back up PostgreSQL, apply migrations using the owner role, verify the runtime role is non-superuser/non-BYPASSRLS, and confirm forced RLS policies.
7. Deploy the immutable container image to staging; validate health, OIDC login, tenant isolation, audit trails, and critical workflows.
8. Promote only after district operational acceptance and rollback readiness.

## Verification status
- Production preflight script syntax: pending local execution.
- Full test suite: inherited baseline from 36.9.0 was 509 passed, 36 failed, 1 skipped. The known failures remain release blockers until reproduced, triaged, and resolved in CI.
- No Vercel project was created and no deployment was made. Vercel authorization is available, but the connected team currently has no linked projects or source repositories.
- No live database migration/RLS validation, external penetration test, load test, browser acceptance run, or district operational sign-off is claimed.

## Explicit release limitation
37.0.0 is a production-readiness tooling milestone, **not a production certification**. The staff-management UI/calendar remains an outstanding integration item from 36.9.0. Do not enable district-wide staffing workflows until the UI, full CI, live database controls, and acceptance tests are complete.


Follow-on development: see `RELEASE-37.1.0.md` for the mobile staff-management workspace milestone.
