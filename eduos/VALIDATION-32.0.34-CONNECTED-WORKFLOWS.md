# EduOS 32.0.34 — Connected Workflows Validation

## Scope
Source baseline: EduOS 32.0.33 Feature & Artwork Alignment.
Release adds authenticated family messaging, teacher account-owned classroom preferences, a controlled SIS batch-import adapter, and server-role-aligned workspace landing.

## Implemented
- PostgreSQL migration `006_connected_workflows.sql`.
- Family messages with district and learner foreign keys, participant identity, read state and RLS.
- Family contacts resolved from active guardian-to-student links or school-scoped staff membership.
- Parent-to-staff and staff-to-guardian recipient validation on message send.
- Message retrieval restricted to sender or recipient, with learner scope revalidated.
- Recipient-only, CSRF-protected read acknowledgments.
- Append-only audit events for message sends.
- Teacher classroom preference storage keyed by district, authenticated user, school and room.
- Teacher writes constrained to assigned school; principal access constrained to their school for listing and can save school preferences.
- Frontend uses authenticated API bridge to save and restore teacher preferences.
- Superintendent-only SIS import endpoint with roster/attendance validation, batch idempotency, attendance source-event idempotency, payload hash and audit event.
- SIS run listing scoped to district/school permissions.
- OIDC bootstrap aligns the visible workspace with the server actor role.
- Parent family summary excludes unpublished assignment drafts.

## Validation results
- Automated Node tests: **175 passed, 0 failed**.
- `node --check`: `src/server.js`, `src/migrate.js`, `public/api-bridge.js` passed.
- Inline `public/index.html` JavaScript syntax passed.
- All 22 SVG assets parsed as XML.
- `package.json`, `package-lock.json` and app title agree on version 32.0.34.
- ZIP integrity checked after packaging.

## Not performed
- PostgreSQL server was not available for executing migration 006 or exercising RLS/foreign keys at runtime.
- No OIDC provider login was run in a deployed browser.
- No district SIS vendor endpoint or credentials were provided; the new endpoint is a controlled import adapter, not a live connector.
- No email/SMS/push transport is configured.
- No browser end-to-end or multi-user conversation test was performed.

## Required deployment sequence
1. Back up the district database.
2. Review migration 006 against the target PostgreSQL version and the district's database-role/RLS setup.
3. Deploy the code and run `npm run db:migrate`.
4. Confirm the runtime database role is not table owner and does not have `BYPASSRLS`.
5. Provision OIDC memberships and verify teacher, parent, principal and superintendent claims/roles.
6. Run two-account tests for parent ↔ teacher messaging and verify cross-school/cross-district denial.
7. Map the district SIS fields and source event identifiers; then run an import in a test district before production.

## Important limitations
- Guardian invitation and identity activation remain outstanding.
- SIS vendor-specific transport, scheduled synchronization, reconciliation, and conflict resolution remain outstanding.
- Messaging has no external delivery channel; it is an authenticated in-app inbox.
- Classroom preferences do not represent official building plans or approved emergency procedures.
