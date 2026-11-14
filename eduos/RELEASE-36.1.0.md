# EduOS 36.1.0 — Library Renewals and Family Loan Visibility

## Delivered
- Student-facing library page lists only the signed-in pupil's own loans.
- Parent-facing library page lists loans for students linked through active parent/guardian relationships.
- Student and parent pages expose title, due date, return state and overdue indicator only; no barcode, student number, grades, attendance or unrelated student records.
- Renewal endpoint permits a pupil to renew only their own active, not-yet-overdue loan; authorized library managers may renew within their school/district scope.
- Renewal is limited to two times, extends the due date by 14 days, and is blocked when an active queued/ready reservation exists. Overdue renewals require librarian intervention.
- All mutations require authenticated session and CSRF and are audit logged.

## API
- `GET /api/library/my-loans` — signed-in pupil's history.
- `GET /api/library/family-loans` — parent/guardian-linked student loan summaries.
- `POST /api/library/loans/:id/renew` — renewal request/action.

## Database
Apply `025_library_renewals_family.sql` through the migration runner. Adds a bounded renewal counter and renewal timestamp.

## Verification
- Focused library tests: 13 passed.
- JavaScript syntax checks: see package validation.
- ZIP integrity: checked.
- Live PostgreSQL/RLS, actual parent-link data, and browser end-to-end testing were not run.

## Policy note
Automated outbound overdue notifications are not enabled in this release. This release provides family-visible overdue status in the portal; notification delivery requires district-approved communication preferences and delivery-provider configuration.
