# EduOS District Edition 32.0.35 — Guardian Onboarding

## Delivered
- District- and school-scoped guardian invitation records.
- Principal/superintendent invitation creation for a specific learner and email address.
- 256-bit random, one-time invitation token; only its SHA-256 digest is stored.
- Seven-day expiration, duplicate-pending protection, revocation, single-use acceptance, and rate limits.
- Acceptance requires an authenticated, active, pre-provisioned `parent` account whose OIDC-verified email matches the invitation and whose membership is in the learner's school.
- Successful acceptance creates/reactivates only the specific `student_user_links` relationship and writes an audit event.
- Staff list and revoke APIs plus browser API-bridge methods.
- Tenant RLS and least-privilege runtime grants in migration 007.

## Important boundaries
- No email provider is configured. The create endpoint returns a one-time relative invitation URL (token in URL fragment) once, marked `delivery: not_configured`; staff must copy it to the recipient using an approved district channel. The raw token is never persisted or written to audit logs.
- This release does **not** self-provision a new parent account. The recipient must already have a district-provisioned parent membership and sign in through the district OIDC provider. Email identity is verified by the existing OIDC token validation (`email_verified=true`) and then matched to the invitation.
- This workflow does not establish legal custody or consent. District policy and staff review remain responsible for confirming the guardian relationship before issuing an invitation.
- The link is returned in the response body and should be handled as a secret. Use HTTPS in deployed environments; do not paste it into public channels.

## Migration and deployment
1. Back up PostgreSQL.
2. Deploy application code and run `npm run db:migrate` to apply `007_guardian_invitations.sql`.
3. Apply the updated `db/runtime_grants.template.sql` grants as the database owner.
4. Confirm the runtime role is not table owner and does not have `BYPASSRLS`.
5. Configure a district-approved email delivery adapter before automating invitation delivery.

## API
- `GET /api/guardian-invitations` — leadership list, school scoped for principals.
- `POST /api/guardian-invitations` — leadership create; body `{ studentId, email, relationship }`.
- `POST /api/guardian-invitations/accept` — authenticated parent; body `{ token }`.
- `POST /api/guardian-invitations/:invitationId/revoke` — leadership revoke.

All mutation routes require the authenticated session and CSRF token. Creation and acceptance are rate-limited.
