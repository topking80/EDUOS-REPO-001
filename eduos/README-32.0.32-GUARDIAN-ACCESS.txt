EduOS District Edition 32.0.32 — Guardian Access API

Adds authenticated, server-side family data endpoints:

GET /api/family/children
- Requires a valid EduOS session.
- Requires the parent role and students:read permission.
- Returns only students linked to the current user through an active parent/guardian relationship in the current district.

GET /api/family/children/:studentId/summary
- Requires a valid EduOS session, parent role and students:read permission.
- Validates the UUID.
- Confirms the active parent/guardian relationship before reading child records.
- Returns a limited attendance history and assignment status/grade/feedback summary.
- Does not return assignment response text or local student numbers.

Security notes:
- Tenant transaction context and district filters are applied.
- Client-supplied student IDs are not authorization.
- Unlinked child requests return 404.
- This API layer is not a complete parent account onboarding system.
- No new guardian invitations, identity proofing, custody/consent workflows, real-time message delivery, or production IdP configuration are included.
- Database-backed integration tests against a real PostgreSQL instance were not run in this environment.
