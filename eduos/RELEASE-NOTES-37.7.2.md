# EduOS District Edition 37.7.2

**Release type:** Reliability and notification follow-up
**Base:** 37.7.1
**Status:** Proposed; changes are on `fix/37.7.2-notification-release-audit`. Not deployed.

## Notification delivery and monitoring

- Migrations 068–071 add explicit email consent, verified E.164 phone enrollment, provider-accepted notification state, and aggregate queue metrics.
- Migration 072 grants the dedicated `eduos_app` runtime role permission to execute `eduos_queue_backlog()`, which is required by the authenticated `/metrics` endpoint. The grant is also retained in `db/runtime_grants.template.sql` for repeatable least-privilege provisioning.
- Provider acceptance remains distinct from confirmed mailbox or carrier delivery. Existing users remain opted out and phone numbers unverified.
- External email and SMS providers remain disabled unless explicitly configured.

## Release metadata and operations documentation

- Align the package version and README with 37.7.2.
- Correct the upgrade guide to document SMTP/Twilio configuration and migrations 068–072 consistently.
- Extend the release gate to explicitly cover runtime-role execution of the aggregate backlog function.

## Operator action

Run `npm run db:migrate` with the migration-owner credentials before deploying the matching application version. Verify `/metrics` with `METRICS_TOKEN` and confirm `eduos_queue_backlog_up 1`. Do not grant function execution to `PUBLIC`.

CI and production deployment status are pending; this release is not represented as verified or deployed.
