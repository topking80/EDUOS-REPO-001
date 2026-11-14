# EduOS 33.6.0 — Dependency update governance and provenance

## Added
- Weekly Dependabot updates for npm dependencies, with bounded PR volume and grouped minor/patch updates.
- Dedicated dependency-update PR workflow: lockfile policy, clean `npm ci`, SBOM/license check, npm audit report, and focused authorization/tenant/supply-chain regression tests.
- Hash-based release provenance JSON containing source revision when available, build environment, and SHA-256 hashes for package manifest, lockfile, and SBOM.
- Main CI now generates and retains the provenance record alongside SBOM/license evidence.

## Security boundaries
- Provenance JSON is not signed and is not a SLSA attestation. Configure keyless signing/attestation in a trusted release workflow before treating it as tamper-evident provenance.
- GitHub Actions are referenced by major version tags (for example `@v4`), not immutable commit SHAs; pin them to reviewed SHAs as a separate governance action.
- Dependabot PRs are not auto-merged. Human review and required branch protection remain necessary.
- This environment cannot confirm a hosted GitHub Actions run or live npm audit.
- No dependency package versions were upgraded in this milestone.

## Verification
```sh
npm run verify:dependencies
npm run supply-chain:check
npm run supply-chain:provenance
node --test test/supply-chain-33.5.test.js test/supply-chain-33.6.test.js
```
