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
| `NOTIFY_EMAIL_ADAPTER` | `off` | `off`, `log` (dry run), or `smtp` (implicit TLS, port 465). SMTP requires the variables below. |
| `NOTIFY_SMS_ADAPTER`, `NOTIFY_PUSH_ADAPTER` | `off` | `off` or `log`; Twilio and FCM are not enabled yet. |
| `NOTIFY_SMTP_HOST`, `NOTIFY_SMTP_USERNAME`, `NOTIFY_SMTP_PASSWORD`, `NOTIFY_SMTP_FROM` | empty | Required when email adapter is `smtp`. |
| `NOTIFY_SMTP_PORT` | `465` | Only implicit TLS on port 465 is supported. |
| `NOTIFY_SMTP_EHLO`, `NOTIFY_SMTP_TIMEOUT_MS` | `eduos.local`, `15000` | SMTP greeting identity and connection timeout. |

Before you turn on an external Christie provider, confirm that a DPA covers
it. Only redacted text from the current question, plus approved lesson
content, is sent.

## 5. Notification job and email consent
Run `051_notification_email_consent.sql` through the normal migration runner.
All existing users are opted out. Users can review and change their own setting
through `GET/PUT /api/me/notification-preferences`; the PUT requires the normal
CSRF token and writes an audit event. Email outbox rows are skipped unless the
recipient has explicitly enabled email notifications.

To enable SMTP, configure the SMTP variables above and set
`NOTIFY_EMAIL_ADAPTER=smtp`. EduOS connects using implicit TLS only (port 465),
uses SMTP AUTH PLAIN, and sends a generic message with no student or incident
details. The SMTP server's acceptance is recorded as accepted by the relay; it
does not prove final mailbox delivery. Never place credentials in source control.

Schedule `node src/notify-dispatch.js` with the owner role (like `db:retention`).
SMS and push remain disabled pending their separate phone-consent and device
registration work.

## 6. Known limits
- Transport "today" uses the database `current_date`. Set the database
  timezone to the district's if runs cross midnight UTC.
- `db:retention` does not yet prune the new tables. Plan manual retention if
  your policy requires it.
