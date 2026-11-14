# EduOS 33.5.0 — SBOM and License Inventory

## Added
- SPDX 2.3 JSON SBOM generated from `package-lock.json`.
- License inventory with explicit unknown-license and restricted-license candidate reporting.
- CI artifact retention for SBOM and license evidence (90 days).
- `npm run supply-chain:sbom` generates evidence; `npm run supply-chain:check` also fails on restricted-license candidates.

## Scope and limitations
- Inventory reflects the locked npm dependency tree only.
- The generator does not infer missing license metadata and does not make legal determinations.
- Unknown licenses are surfaced for human review and do not automatically fail CI.
- Restricted-license matching is a conservative name-pattern screen, not a substitute for SPDX expression parsing or counsel review.
- SBOM namespace uses a generated timestamp; regenerate for each build.
- No package versions were upgraded in this milestone.
- A live registry vulnerability audit and a full hosted CI run remain outstanding where network access is unavailable.

## Verification
Run:
```sh
npm ci
npm run supply-chain:check
npm test
```
