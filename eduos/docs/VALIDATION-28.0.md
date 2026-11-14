# Validation — EduOS 28.0

Phase 28 adds PostgreSQL-backed access requests and permission grants.

Automated validation covers:
- Migration registration and schema constraints.
- District RLS for access requests and permission grants.
- Request, approval, denial and revocation route contracts.
- Approval requires a different superintendent (self-approval is rejected).
- Grant expiry is capped at 90 days and school scope is constrained.
- Server authorization checks active, unexpired, non-revoked grants.
- Connected Services Access Requests UI is wired to the authenticated API.
- Existing Phase 26/27 regression tests remain in the suite.

Not completed / not claimed:
- Live PostgreSQL migration/RLS execution was not available in this environment.
- Live OIDC provider sign-in was not performed.
- Full browser end-to-end testing was not performed.
- The legacy Phase 27 local access demo remains separate and is not authoritative.
