EduOS District Edition 32.0.11 — Connected Services UI Refresh

This release carries the visual improvements from the supplied 32.0.9 UI
package onto the newer 32.0.10 session-security baseline.

Integrated UI changes
- Refined Connected Services bar, authenticated status indicator, actor label,
  and responsive layout.
- Improved record tabs, KPI tiles, cards, tables, forms, focus rings, notices,
  and Student 360 profile presentation.
- Shows a "Loading records…" state while authenticated records are fetched.
- Preserves the existing API bridge behavior, API paths, role checks, data
  rendering/escaping, and server request handling.

Baseline preservation
- Retains 32.0.10 OIDC per-attempt browser-binding cookies.
- Retains bounded/pruned pending login transactions and single-use callback
  state handling.
- Retains OIDC authorized-party validation and constant-time CSRF/state
  comparisons.
- Retains the existing backend, database migrations, policies, audit, and
  session lifecycle behavior. The uploaded older backend was not copied over
  the newer security baseline.

Validation
- JavaScript syntax checks and ZIP integrity are recorded in
  docs/VALIDATION-32.0.11.md.
- UI source-contract tests were added.
- Full npm test could not complete in this environment because dependencies
  could not be installed (registry request timed out; offline cache lacked
  xtend). Eight tests that dynamically import auth/oidc modules therefore
  report missing cookie/jose packages; this is an environment limitation,
  not a passing test result. Run npm ci and npm test in a network-enabled
  environment before deployment.
- No live browser, PostgreSQL/RLS, OIDC provider, or multi-instance tests were
  performed for this package.

This is a development UI integration release, not production certification.
