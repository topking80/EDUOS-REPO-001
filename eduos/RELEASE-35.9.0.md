# EduOS 35.9.0 — Librarian Console & Multi-Scanner Support

Adds a first-party librarian console to principal and district operations navigation. The console provides barcode-driven check-in and check-out, active-loan visibility, due-date entry, and a scanner compatibility guide.

## Scanner support
Supports USB HID keyboard-wedge, Bluetooth HID keyboard, and wireless USB-dongle scanners. These devices emulate keyboard input and require no vendor-specific SDK. Configure a scanner to append Enter/Return. This is the broadest cross-vendor approach and works with common 1D/2D barcode readers that support HID keyboard mode.

## Workflow
- Check-in scans the item barcode, resolves the item in the current inventory and locates its active loan before submitting a return.
- Check-out scans the item barcode, validates the borrower account UUID, selects a due date, and uses the existing authenticated circulation API.
- Existing API authorization, CSRF checks, inventory count updates and audit logging remain in force.

## Known limitations
- Borrower badge barcode-to-account resolution is not yet implemented; borrower account UUID is entered manually.
- Camera scanning is not included; scanner input uses keyboard-wedge compatibility.
- The circulation API currently allows principal and district administrators to check books in/out; a dedicated librarian membership role is a separate authorization enhancement.
- Live database and physical scanner hardware tests were not run.

## Verification
- Librarian console + circulation tests: 7 passed.
- JavaScript syntax checks: all repository JavaScript files passed.
- Broader test suite was attempted; some tests could not start because environment dependencies (`sharp`, `pg`, `express-rate-limit`) and `DATABASE_URL` are unavailable in this runtime. No claim of a full-suite pass is made.
