# EduOS 33.3.0 — Dependency Registry & Supply-Chain Controls

## Changes
- Set the application and lockfile release metadata to `33.3.0` without changing dependency versions.
- Added a project `.npmrc` that selects `https://registry.npmjs.org/`, enforces TLS certificate validation, and enables lockfile-backed installs.
- Added `npm run verify:dependencies` to check package/lockfile identity and dependency parity, lockfile v3, registry policy, HTTPS npm registry resolution, and integrity hashes.
- Added `npm run audit:dependencies` (`npm audit --audit-level=high`).
- Added weekly Dependabot npm update configuration with a limited PR queue and review labels.
- Added a CI job to verify the registry policy, install with `npm ci`, and run the npm vulnerability audit.

## Inventory snapshot
- Direct runtime dependencies: 10.
- Locked package entries: 153.
- Lockfile format: v3.
- Resolved package source hosts: `registry.npmjs.org` only.
- Resolved entries missing integrity hashes: 0.
- Dependency versions were intentionally not advanced because the npm registry audit endpoint was unreachable in this build environment. A version bump without current advisory and compatibility data would be unsafe.

## Verification
- `node scripts/verify-dependency-registry.js`: PASS (153 entries).
- `node --check scripts/verify-dependency-registry.js`: PASS.
- Authorization and tenant-context regression tests: PASS (12/12), using the documented dummy environment configuration for the tenant-context test.
- `npm audit --json`: NOT VERIFIED; registry request failed with DNS `EAI_AGAIN` for `registry.npmjs.org`.
- `npm outdated`: NOT VERIFIED; registry query timed out.
- Full `npm ci`, complete application test suite, and CI workflow execution were not run in this offline environment.

## Required release follow-up
Run `npm ci`, `npm run verify:dependencies`, and `npm run audit:dependencies` in network-enabled CI. Review and merge Dependabot updates individually with regression tests. Do not treat this release as a clean vulnerability certification until the live audit completes.
