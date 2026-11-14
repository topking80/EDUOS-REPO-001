# EduOS 33.4.0 — Dependency Audit Evidence & CI Gate

## Changes
- Added `npm run audit:dependencies:report`, which runs the native `npm audit --json` command and preserves the complete raw result plus a concise severity/advisory summary.
- CI now uploads the audit report even when the audit command fails, then enforces the existing high/critical severity release gate.
- The audit report distinguishes a clean audit, vulnerability findings, and an unavailable/invalid audit response. Network failures are not misreported as a clean result.
- Updated package and lockfile release metadata to `33.4.0`; dependency versions were not changed.

## Local usage
```sh
npm ci
npm run verify:dependencies
npm run audit:dependencies:report
```
The report is written to `artifacts/dependency-audit/npm-audit.json` and is intended for CI artifact retention, not source control.

## Verification and limitations
- The report generator is syntax-checked and tested against simulated clean (exit 0), high-severity (exit 1), and network-failure (exit 2) npm responses.
- Registry policy verifier passes for all 153 locked package entries.
- A live registry audit is required to determine current vulnerability status. This build environment previously could not resolve `registry.npmjs.org`; therefore no current clean-audit claim is made.
- No dependency versions were upgraded in this milestone.
