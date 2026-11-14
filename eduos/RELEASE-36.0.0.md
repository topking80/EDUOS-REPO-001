# EduOS 36.0.0 — Dedicated Librarian Role & Student ID Barcode Lookup

- Adds a school-scoped `librarian` membership role with library-only permissions; no student-record, attendance, grade, discipline, pickup, transport, or safety permissions.
- Principals can provision librarians for their own school; district IT and superintendents retain district administration.
- Librarians can perform circulation and school-scoped library workflows; cross-school and district-wide visibility remains reserved to district roles.
- Adds student card barcode mapping. Stored barcode values are SHA-256 hashed. Mapping requires an active pupil membership and a school-scoped library manager. Lookup returns only the active student's account ID, display name and school ID.
- Adds optional camera scanning via browser BarcodeDetector where supported; USB/Bluetooth HID scanners remain supported.

## Deployment
Apply `024_librarian_role_and_badges.sql` before deploying. Refresh runtime grants from `db/runtime_grants.template.sql`. Existing memberships are unchanged.

## Verification
Focused librarian role tests and syntax checks are included in the package. Live PostgreSQL/RLS and browser camera/device compatibility tests require deployment hardware and were not run here.
