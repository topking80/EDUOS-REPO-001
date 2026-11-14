# EduOS 36.3.0 — District Library Intelligence

## Included
- District/school inventory overview: title records, physical copies, available copies, unavailable copies, out-of-stock and high-demand title counts.
- Overdue and lost loan indicators.
- Exact-ISBN cross-school transfer candidates where one school has available copies and another has none.
- Subject-level out-of-stock collection gap report.
- Replacement/purchase review candidates based on active overdue/lost loans.
- Read-only recommendations; no automatic stock movement, purchasing, or student-level analytics.

## Access and privacy
Superintendent and district IT roles see district scope. Principals and librarians are restricted to their own school. Routes require an authenticated session, use tenant transactions, return no-store responses, and audit reads. Recommendations avoid borrower names and identifiers.

## API
- `GET /api/library/intelligence/overview`
- `GET /api/library/intelligence/recommendations`

## Deployment
No schema migration is required. Deploy application code and restart services normally.

## Verification
Four focused static contract tests and JavaScript syntax checks are included. Live PostgreSQL query execution, RLS integration, performance/load testing, and browser E2E were not run. Recommendations are decision support only; verify physical stock and local collection policy before transfers or purchases.
