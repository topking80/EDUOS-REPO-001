# EduOS 36.2.0 — District Library Policies & Overdue Notice Ledger

- Per-school borrowing policy: loan duration, renewal count, renewal duration and overdue grace period.
- Policy is managed by librarian, principal, district IT and superintendent roles, constrained to school/district scope.
- Renewal workflow now reads the school's configured renewal limit and duration.
- Overdue notice preparation creates a deduplicated, auditable in-app notice ledger. It does not send email or SMS; external delivery remains disabled pending district provider configuration and consent controls.
- New migration: `026_library_policy_and_notice_ledger.sql`.

## Verification
JavaScript syntax and focused contract tests are included in release packaging. Live PostgreSQL/RLS, outbound messaging, and browser E2E require deployment environment verification.
