# EduOS 35.3.0 — Dedicated School Resource Officer Workspace

## Delivered
- Adds the school-scoped `sro` role.
- Adds a dedicated SRO application workspace with active incident visibility and status update controls.
- SROs can read incident status for their assigned school and record SRO coordination updates only.
- SRO permissions exclude student records, classroom roll call, attendance, transportation, pickup, guardian records, discipline/case data, and reunification release actions.
- SRO accounts can be provisioned by the school-principal role workflow; district IT role management does not gain SRO provisioning.
- Adds migration `020_sro_role.sql` to constrain membership roles and school scope, update flow-event role/audience checks, and include SROs in generic staff incident notifications.
- SRO status API requires the dedicated `safety:sro_update` permission, validates the assigned school, requires CSRF on writes, rate limits writes, audits reads/updates, and uses no-cache responses.
- Existing SRO coordination UI remains available to principals and superintendents.

## Verification performed
- Focused SRO tests: 11 passed, 0 failed.
- JavaScript syntax: 177 files checked, 0 failures.
- SBOM: 153 locked packages; 0 unknown licenses; 0 restricted-license candidates.
- Release provenance regenerated; source revision unavailable and signing not configured.
- ZIP integrity verified.

## Not verified
- Full repository test suite, live PostgreSQL migration/RLS integration, real membership provisioning, browser end-to-end, and operational emergency drills were not run.

## Deployment note
Apply database migration 020 before deploying the application code. Validate principal provisioning, cross-school denial, notification routing, and SRO restricted UI in a non-production district. SRO status is an internal coordination log only and does not dispatch or contact law enforcement. Follow established district emergency procedures.
