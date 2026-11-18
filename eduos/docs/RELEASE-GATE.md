# Release-candidate regression gate

A release candidate is ready only when every check below passes in CI. Each
line names the test that enforces it. The integration tests run against real
PostgreSQL as the non-owner runtime role (`npm run test:integration` with
`EDUOS_TEST_PG_URL` set). The e2e checks run against the full Docker Compose
stack behind Caddy (the CI `e2e` job).

| Gate | Enforced by |
|---|---|
| Every route the app registers (read from the Express router at runtime, so template-string and variable registrations count): every GET, as every role at one school (principal, vice principal, teacher, parent, pupil, counselor, nurse, librarian, SRO, driver, IT admin) and as another district's superintendent, shows no other school's learner, safety instructions or bus route and nothing of another district; every POST/PUT/PATCH/DELETE, with a body naming the other school's records, changes none of that school's rows (or, for the other district, none of this district's); no call answers with a server error | `test/integration/role-scope-matrix.test.js` (about 4,000 calls) |
| Each role gets the expected status from the student-facing routes (allowed and scoped, or refused) | `role-scope-matrix.test.js` |
| A user with two memberships gets each one's scope after switching; the previous session ends | `role-scope-matrix.test.js` |
| The permission registry (`src/policy.js`) lists only what the routes let a role do | `role-scope-matrix.test.js` (expected statuses for vice principals and counselors) |
| Student-record reads use one fail-closed rule (`studentVisibleSql` in `src/server.js`): a role not named there sees no student | `role-scope-matrix.test.js` (vice principal directory and profiles, roles without student access) |
| Parents see a safety incident only at a school where they have an active child link, without staff instructions | `role-scope-matrix.test.js` |
| No database role other than the runtime role can call the SECURITY DEFINER functions | `role-scope-matrix.test.js` (a separate login role is refused; no definer function is executable by PUBLIC) |
| A school morning end to end: bus check-in, the driver's handoff, receipt, first attendance, a correction, an offline replay delivered twice and a late offline mark | `test/integration/morning-sequence.test.js` |
| The notification dispatcher holds no transaction or row lock while a channel adapter works; a crashed dispatcher's rows are sent by the next run, once; with two dispatchers and a sender slower than the lease, every row is sent exactly once (each row's lease is renewed just before its send and each send is cut off inside the lease) | `release-gate.test.js` → notification dispatch leases |
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
| Upgrading a populated database from an older release works with the production roles: the migrator runs as the non-superuser owner and applies only the newer migrations; data backfills reach existing rows in every district; the runtime role still owns nothing, every district table except the four sign-in tables has forced RLS, no SECURITY DEFINER function is executable by PUBLIC; a second run changes nothing; the API starts and serves only the caller's district | `test/integration/upgrade-path.test.js` (older release = through migration 040) |
| A backup of a populated database restores into a new database (nothing fails), and the API runs on the copy as the runtime role with districts isolated; backups need a superuser or BYPASSRLS role | `test/integration/backup-restore.test.js`, procedure in `docs/MIGRATIONS.md` |
| Every helper function a row-level security policy calls is executable by the runtime role; no EduOS function is executable by PUBLIC | `upgrade-path.test.js` |
| Text sent to an external AI provider (Christie questions, staff assistant input, lesson fields) loses student names and numbers, the learner's linked family and rostered teachers, names after a title, street addresses, labelled birth dates, phone numbers, email and web addresses | `test/redact-names.test.js`, `test/integration/ai-external-privacy.test.js` |
| No edge container runs as root; bootstrap runs as a host unit with systemd limits | `test/edge-no-root-containers.test.js` |
| Webhook and notification backlog is visible to monitoring without exposing any district, recipient or message: jobs due, being sent, waiting to retry and dead-lettered/failed, and the age of the oldest due job; the non-owner runtime role can execute the backlog function after upgrade | `test/metrics.test.js`, `upgrade-path.test.js` (`/metrics` against the upgraded database and runtime-role function grants) |
| The CSP works for every deployed frontend route | `test/csp-caddy-matches-app.test.js` (the Caddyfile matches `src/csp.js`), `dev/csp-smoke.mjs` in CI e2e (headers through the edge on every static page and script, then every role's screens in Chrome with nothing blocked) |

## What the notification outcomes mean

`notification_outbox.status`:

- `delivered`: an in-app notice (available in the recipient's app as soon as
  the alert commits), or an email/SMS/push a channel adapter confirmed.
  `delivered_at` is set only in this case.
- `accepted`: an SMTP/Twilio provider accepted the message for processing. This is
  terminal (not retried), but is not confirmed mailbox/carrier delivery; `delivered_at`
  remains null.
- `pending`: queued for `src/notify-dispatch.js`, or waiting for a retry
  (`next_attempt_at`, back-off from 30 seconds doubling to at most an hour).
- `skipped`: nothing was sent on purpose (the channel is off, or the `log`
  adapter's dry run). It is not a delivery.
- `failed`: the adapter gave up, answered with an unknown status, or five
  attempts failed. `last_error` says why.

External adapters are off by default. SMTP email requires explicit recipient
consent; Twilio SMS requires a verified phone and explicit SMS consent. Both
send generic notification content only. Provider acceptance is not delivery
confirmation. EduOS never contacts 911 or other emergency services; a "first
responders" entry in the incident log is a staff member's note.

## Operations event stream sessions

`/api/operations/stream` checks its session when it opens, before every event
and every `STREAM_SESSION_RECHECK_MS` (default 15 seconds) while idle. A
signed-out, expired or idle session, or a disabled account or membership, ends
the stream with an `event: session_ended` frame. The stream doesn't count as
activity, so a dashboard left open with no other requests ends at the session
idle timeout (`SESSION_IDLE_MINUTES`) like any other idle session.

## Queue backlog metrics

`GET /metrics` (when `METRICS_TOKEN` is set) includes, read at most every 15
seconds from `eduos_queue_backlog()` (totals across all districts):

- `eduos_queue_jobs{queue="webhook"|"notification",state=...}`: `ready` (due
  and not being sent), `leased` (being sent), `delayed` (waiting to retry),
  and `dead_letter` (webhooks) or `failed` (email/SMS/push given up).
- `eduos_queue_oldest_ready_seconds{queue=...}`: how long the oldest due job
  has waited. Suggested alerts: above 300 for webhooks or 120 for
  notifications for 10 minutes (the dispatcher is down or too slow), or any
  increase in `dead_letter` / `failed`; review `accepted` separately as provider handoff, not delivery confirmation.
- `eduos_queue_backlog_up`: 0 when the backlog could not be read; alert on it
  rather than reading a missing series as an empty queue.

## Writing migrations

See `docs/MIGRATIONS.md` (changing existing rows under forced RLS, functions
behind generated columns, grants), along with backup, rollback and recovery.

## Not covered by this gate

Restore drills on production-sized data, webhook behaviour across a full restart, edge hardware,
mobile release signing and production infrastructure need their own
procedures; the gate covers the application.


## 37.7.2 notification metrics permission

Migration `072_notification_backlog_metrics_grant.sql` grants the dedicated non-owner runtime role `EXECUTE` on `eduos_queue_backlog()`. The same explicit grant is retained in `db/runtime_grants.template.sql`; the function is not executable by `PUBLIC`. This keeps the authenticated `/metrics` handler able to read aggregate queue health while preserving the database's least-privilege policy.
