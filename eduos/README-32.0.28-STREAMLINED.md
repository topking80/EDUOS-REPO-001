# EduOS 32.0.28 — Streamlined source release

## Changes
- Corrected the release-version assertion so the suite validates the actual package version.
- Hardened tenant transaction cleanup: validates actor context, rolls back only after a successful BEGIN, preserves the original error if rollback also fails, and always releases the client.
- Made database pool shutdown reset its lazy initialization state even when shutdown fails.
- Added `.gitignore` rules for local dependencies, secrets, logs, and generated coverage.
- Removed `node_modules` from the distributable archive. Install reproducibly with `npm ci`.

## Run
- Node.js 22 or later
- `npm ci`
- `npm test`
- `npm start`

## Safety and deployment notes
The test suite validates the repository's automated contracts. It does not by itself certify production readiness, database connectivity, identity-provider configuration, emergency plans, or district policy compliance. Configure secrets outside source control and verify deployment settings in the target environment.
