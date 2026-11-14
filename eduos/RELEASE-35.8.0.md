# EduOS 35.8.0 — Library Circulation Operations

## Added
- Authenticated, school-scoped checkout for active district memberships.
- Due-date tracking and overdue report.
- Return processing with returned, damaged, and lost dispositions. Only a good return restores available-copy count.
- Reservations/holds with duplicate active-hold prevention.
- Audit events for checkout, return, and reservation.
- District RLS and least-privilege runtime grants for circulation tables.

## API
- GET `/api/library/loans`
- POST `/api/library/loans/checkout`
- POST `/api/library/loans/:id/return`
- POST `/api/library/reservations`
- GET `/api/library/overdue`

## Deployment
Apply `023_library_circulation.sql`, refresh runtime grants from `db/runtime_grants.template.sql`, then deploy.

## Limitations
The reservation endpoint records a hold; automated pickup notifications, queue promotion, renewals, fines, barcode hardware integration, and student/guardian self-service are not included. Borrowers must have an active EduOS district membership. Live PostgreSQL/RLS and browser E2E validation were not run.
