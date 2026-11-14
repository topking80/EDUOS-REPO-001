# EduOS 32.0.47 — Connection Integrity

This release focuses on checking and protecting existing connections after the 32.0.46 district-journey work. It does not pretend that conceptual walkthrough steps are live integrations.

## Checks performed
- Automated application test suite.
- Literal local `href` and `src` references in public HTML resolved against the packaged files.
- JavaScript syntax check across `public/` and `src/`.
- Package, lockfile and application title version consistency.
- ZIP integrity check after packaging.

## Boundaries
Static path checks do not prove runtime route behavior, external services, authentication-provider availability, database connectivity, DNS/TLS, webhook delivery or browser rendering. Template-generated references and runtime-computed routes require runtime/browser coverage. No production deployment or live external integrations were exercised.

## Connection policy
Keep existing role authorization, school scope, API bridge validation, and server-side policy checks intact. Do not use the Vision Studio conceptual journey to bypass a role gate or expose cross-role records.
