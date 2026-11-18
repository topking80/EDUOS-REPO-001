# Upgrading to EduOS 32.4.0

## 1. Run migration 012
`db/012_role_apps_transport_christie_comms.sql` adds the transport, Christie,
Comms and notification tables (FORCE RLS), the `driver` role, helper
functions, and an updated `eduos_purge_student`. Run it with the owner role:
```sh
DATABASE_URL=<owner url> npm run db:migrate
```
The app refuses to start until the migration is applied ("ready 12").

## 2. New role: `driver`
Provision bus drivers as accounts with role `driver` and a school, then assign
them to routes (`POST /api/transport/routes` as a principal or
superintendent). Drivers sign in through district OIDC and always land in the
mobile app at `/app/`.

## 3. Edge (Caddy)
The shipped `Caddyfile` adds a `/app` handle before the generic one. It serves
the app shell with `Cache-Control: no-cache`, sets `Service-Worker-Allowed`,
and falls back to `/app/index.html`. If you run your own edge, copy that block.
Keep `Permissions-Policy: geolocation=()`.

## 4. Environment variables (all optional)
| Variable | Default | Meaning |
|---|---|---|
| `CHRISTIE_PROVIDER` | `local` | `local` or `openai_compatible` |
| `CHRISTIE_ALLOW_EXTERNAL_PROVIDER` | unset | must be `true` to use an external provider |
| `CHRISTIE_PROVIDER_URL`, `CHRISTIE_PROVIDER_MODEL`, `CHRISTIE_PROVIDER_API_KEY` | empty | external provider settings |
| `CHRISTIE_PROVIDER_TIMEOUT_MS` | `8000` | falls back to the local reply after this |
| `CHRISTIE_RATE_LIMIT_PER_MIN` | `60` | per-client Christie writes |
| `COMMS_RATE_LIMIT_PER_MIN` | `60` | per-client Comms writes |
| `TRANSPORT_CHECKIN_RATE_LIMIT_PER_MIN` | `300` | per-client check-ins |
| `NOTIFY_EMAIL_ADAPTER`, `NOTIFY_SMS_ADAPTER`, `NOTIFY_PUSH_ADAPTER` | `off` | `off` or `log` (dry run). No real sender ships. |

Before you turn on an external Christie provider, confirm that a DPA covers
it. Only redacted text from the current question, plus approved lesson
content, is sent.

## 5. Notification job
If any external adapter is enabled, schedule `node src/notify-dispatch.js`
with the owner role (like `db:retention`). In dev, run `make notify`. With
every adapter `off`, nothing is queued and the job is not needed.

## 6. Known limits
- Transport "today" uses the database `current_date`. Set the database
  timezone to the district's if runs cross midnight UTC.
- `db:retention` does not yet prune the new tables. Plan manual retention if
  your policy requires it.


## 7. Opt-in email and verified SMS (37.7.2)
Migrations 068–070 add district-scoped email consent, verified phone enrollment,
and a terminal provider-accepted state. The current migration runner discovers
numbered migrations after 050 automatically; do not add these to the fixed list.
Existing users remain opted out and unverified.

Users manage their own email/SMS preferences at
`GET/PUT /api/me/notification-preferences`. The update requires CSRF and writes
an audit event. SMS consent is unavailable until the user verifies an E.164
phone number through the Twilio Verify start/check endpoints. Verification and
preference routes are session-protected and rate-limited.

SMTP uses implicit TLS on port 465 only. Twilio sends SMS only after phone
verification and explicit consent. Both channels send generic notification
content without student or incident details. Provider acceptance is recorded
as `accepted`, not `delivered`; final mailbox/carrier delivery is not confirmed.
Keep provider credentials in the deployment secret manager, never source control.
