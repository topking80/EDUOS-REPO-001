# EduOS 35.6.0 — District-Controlled SRO Permissions

## Change
SRO account authority is now reserved to district administrators:
- Superintendents retain district-wide authority to create, assign, enable, and disable SRO memberships.
- District IT administrators can create, assign, enable, and disable school-scoped SRO memberships.
- Principals can no longer grant or revoke SRO memberships.
- Principals retain their existing school-level teacher, parent, pupil, and driver account workflows.
- SRO operational permissions remain unchanged and school-scoped; this release does not expand SRO access to student records.

The control is enforced in the shared server-side `canManage` authorization function used by account creation, membership creation, and membership status changes. Changes continue to be written to the existing audit log.

## Deployment
No database migration is required. Deploy the application release and restart services using the district's normal release procedure.

## Verification
- Focused SRO tests: 11 passed.
- Full repository tests and JavaScript syntax checks: see release verification results.
- Live PostgreSQL, browser end-to-end, and district identity-provider integration were not exercised in this packaging run.

## Security note
District IT administrators should provision SRO memberships only after validating the officer's district-approved identity and school assignment. Disabling the membership blocks subsequent authenticated requests after the existing session membership re-check.
