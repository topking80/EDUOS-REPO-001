# EduOS 33.7.0 — Production release security baseline

## Implemented
- Dedicated CI job for Gitleaks repository secret scanning.
- Trivy filesystem scan for HIGH/CRITICAL dependency vulnerabilities, secrets, and IaC misconfiguration.
- Production Docker image build and Trivy image scan.
- Explicit read-only repository permission plus security-events write permission for scanner reporting.
- Security reporting and release requirements documented in `SECURITY.md`.

## Verification and limitations
- Workflow configuration reviewed locally; hosted GitHub Actions execution is not available from this environment.
- Scanner actions are referenced by version tags, not immutable commit SHAs. Pin reviewed action SHAs before treating CI as hardened against action-tag compromise.
- HIGH/CRITICAL findings fail the relevant scan step; `ignore-unfixed` is enabled, so findings without an available fix are reported but do not fail the job.
- The scan does not establish FERPA/COPPA compliance or prove absence of vulnerabilities.
- No dependency versions were upgraded.
