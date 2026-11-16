# Release-candidate regression gate

A release candidate is ready only when every check below passes in CI. Each
line names the test that enforces it. The integration tests run against real
PostgreSQL as the non-owner runtime role (`npm run test:integration` with
`EDUOS_TEST_PG_URL` set). The e2e checks run against the full Docker Compose
stack behind Caddy (the CI `e2e` job).

| Gate | Enforced by |
|---|---|
| District A cannot read or modify District B data | `test/integration/postgres.test.js` (H1: RLS isolates districts), `test/integration/release-gate.test.js` (attendance, webhooks, event stream), `test/integration/webhook-outbox.test.js` (a worker only sees its own district's queue) |
| School staff cannot access another school's student records | `postgres.test.js` (M5, M7, H3), `school-operations-authz.test.js`, `release-gate.test.js` (another school's student: 404) |
| A driver cannot confirm a school handoff; the initiator cannot confirm their own | `release-gate.test.js` → arrival handoff |
| A teacher receives only assigned or rostered students | `release-gate.test.js` → arrival handoff, `first-attendance.test.js` |
| A principal override requires a recorded reason | `first-attendance.test.js` (reason in the handoff log and the audit log) |
| Duplicate attendance submissions don't create duplicate records | `release-gate.test.js` (concurrent identical marks → one record; concurrent first attendance → one record), `first-attendance.test.js` |
| Every arrival step is in the audit trail | `release-gate.test.js` (handoff log and audit log for create, receive, first attendance) |
| Emergency notifications stay within the incident's school and district, and only reach active accounts | `release-gate.test.js` → emergency notifications, `safety-pickup.test.js` |
| Queued email/SMS/push is never reported as delivered; failures are visible | `release-gate.test.js` (dry run is "skipped", back-off, give-up as "failed", leads' board counts), `test/role-apps-32400.test.js` (attempt outcomes) |
| Nothing claims emergency services were contacted | `release-gate.test.js` (`emergencyServicesContacted: false`, staff log wording) |
| A revoked, expired or de-scoped session can't keep receiving realtime events | `release-gate.test.js` → operations event stream (sign-out, expiry, membership revoked) |
| Webhook retries and administration don't cross tenants | `webhook-outbox.test.js`, `release-gate.test.js` → webhook subscriptions |
| A migration failure prevents production startup | `postgres.test.js` (the API refuses to start when a migration is missing; migrate refuses unsafe roles) |
| The CSP works for every deployed frontend route | `test/csp-caddy-matches-app.test.js` (the Caddyfile matches `src/csp.js`), `dev/csp-smoke.mjs` in CI e2e (headers through the edge on every static page and script, then every role's screens in Chrome with nothing blocked) |

## What the notification outcomes mean

`notification_outbox.status`:

- `delivered`: an in-app notice (available in the recipient's app as soon as
  the alert commits), or an email/SMS/push a channel adapter confirmed.
  `delivered_at` is set only in this case.
- `pending`: queued for `src/notify-dispatch.js`, or waiting for a retry
  (`next_attempt_at`, back-off from 30 seconds doubling to at most an hour).
- `skipped`: nothing was sent on purpose (the channel is off, or the `log`
  adapter's dry run). It is not a delivery.
- `failed`: the adapter gave up, answered with an unknown status, or five
  attempts failed. `last_error` says why.

EduOS ships no real email/SMS/push sender, so in a default deployment alerts
reach people through the EduOS app only, and the leads' board says so. EduOS
never contacts 911 or other emergency services; a "first responders" entry in
the incident log is a staff member's note.

## Operations event stream sessions

`/api/operations/stream` checks its session when it opens, before every event
and every `STREAM_SESSION_RECHECK_MS` (default 15 seconds) while idle. A
signed-out, expired or idle session, or a disabled account or membership, ends
the stream with an `event: session_ended` frame. The stream doesn't count as
activity, so a dashboard left open with no other requests ends at the session
idle timeout (`SESSION_IDLE_MINUTES`) like any other idle session.

## Not covered by this gate

Restore drills, webhook behaviour across a full restart, edge hardware,
mobile release signing and production infrastructure need their own
procedures; the gate covers the application.
