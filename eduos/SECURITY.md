# EduOS Security Policy

## Reporting a vulnerability
Do not report suspected vulnerabilities in public issues or discussions. Contact the project security owner through the organization's approved private security reporting channel. Do not include student education records, credentials, tokens, or other sensitive data in a report.

## Supported security checks
Pull requests and CI runs should execute:
- Secret scanning (Gitleaks).
- Filesystem scanning for dependency vulnerabilities, secrets, and IaC misconfiguration (Trivy).
- Production container image scanning (Trivy).
- Dependency lockfile verification, npm audit evidence, SBOM/license inventory, and security regression tests.

## Release requirements
- Resolve or explicitly risk-accept HIGH and CRITICAL findings before production release.
- Rotate any credential that may have been exposed; deleting it from the current tree is not sufficient.
- Keep runtime containers non-root and use the production `app` target, never `devtools`.
- Keep production secrets in the approved secret manager or deployment secret store; do not commit `.env` files.
- Require human review of dependency update PRs.
- Verify signed build provenance and immutable workflow/action references before claiming a release is cryptographically verified.

## Scope limitations
CI scan jobs are configured in this repository, but their results are not known until run in GitHub Actions. Scanner results depend on the vulnerability databases and rules available at execution time. A clean scan is not proof that the application is secure or FERPA/COPPA compliant.
