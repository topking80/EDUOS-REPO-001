# EduOS 35.1.0 — Emergency Reunification Manifest

## Delivered
- Adds lead-only `GET /api/safety/incidents/:id/reunification-manifest`.
- Endpoint is available only while the incident is in `reunification` state.
- Returns a school-scoped manifest of enrolled learners, latest roll-call status, count of active parent/guardian relationships, and any recorded incident-linked release event.
- Summary includes enrolled, accounted-for, missing, injured, awaiting roll-call, released, and awaiting guardian release counts.
- Does not expose guardian email addresses, phone numbers, or account identifiers.
- Enforces district/school predicates, emits an audit record, and sets `Cache-Control: no-store`.
- Existing staff verification, photo-ID review, custody restrictions, and pickup release authorization remain authoritative; the manifest itself cannot release a student.
- Updates package metadata, SBOM, and release provenance.

## Verification performed
- Focused tests: 5 passed, 0 failed.
- JavaScript syntax: 175 files checked, 0 failures.
- SBOM: 153 locked packages; 0 unknown licenses; 0 restricted-license candidates.
- Release provenance regenerated; source revision unavailable and signing not configured.
- ZIP integrity verified.

## Not verified
- Full repository suite, live PostgreSQL/RLS integration, real district data, browser end-to-end testing, and operational emergency drills were not executed. Some repository tests require dependencies not installed in this build environment.

## Deployment note
Do not use as the sole source of truth during an emergency until district CI, PostgreSQL/RLS integration, browser E2E, and a supervised tabletop/operational drill have validated the complete workflow. No database migration is required.
