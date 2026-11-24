# EduOS 33.7.0 — Production release security baseline

## Implemented
- Dedicated CI job for Gitleaks repository secret scanning.
- Trivy filesystem scan for HIGH/CRITICAL dependency vulnerabilities, secrets, and IaC misconfiguration.
- Production Docker image build and Trivy image scan.
- Explicit read-only repository permission plus security-events write permission for scanner reporting.
- Security reporting and release requirements documented in `SECURITY.md`.

## Verification and limitations
- Workflow configuration reviewed locally; hosted GitHub Actions execution is not available from this environment.
- At 33.7.0 the scanner actions were referenced by version tags. That has since been fixed: every `uses:` in `.github/workflows/ci.yml`, `codeql.yml` and `dependency-update-validation.yml` is now pinned to a full 40-character commit SHA, with the release tag in a trailing comment (for example `aquasecurity/trivy-action@ed142fd… # v0.36.0`). Keep new actions SHA-pinned and update the SHA and comment together. (Corrected in 37.7.4.)
- HIGH/CRITICAL findings fail the relevant scan step; `ignore-unfixed` is enabled, so findings without an available fix are reported but do not fail the job.
- The scan does not establish FERPA/COPPA compliance or prove absence of vulnerabilities.
- No dependency versions were upgraded.
