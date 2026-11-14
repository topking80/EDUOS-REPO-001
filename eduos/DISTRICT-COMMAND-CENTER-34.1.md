# EduOS 34.1.0 — Operational feed integrity and school-local day

## Changes
- Arrival register date filtering now uses each arrival's school timezone through `eduos_school_today(school_id)` and the school's IANA timezone.
- The interval is half-open `[local midnight, next local midnight)`, preserving correct behavior across daylight-saving transitions.
- The Command Center validates the response shape of arrival, transportation, and staffing feeds before using them.
- Failed or malformed feeds are reported as unavailable (`—`) rather than misleadingly displayed as zero.
- Feed failures remain isolated; healthy workspaces continue to render.

## Security and compatibility
- No new endpoint, permission, write operation, or client-side authority was added.
- Existing authenticated API requests and server authorization remain the trust boundary.
- The school timezone is read from the existing `schools.timezone` field and the existing `eduos_school_today` function introduced in migration 013.

## Validation
- Focused tests cover timezone-aware interval construction, feed-shape validation, and unavailable-vs-zero display behavior.
- Live PostgreSQL, configured OIDC session, and browser end-to-end validation remain required before production deployment.
