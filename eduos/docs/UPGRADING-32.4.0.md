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
| `NOTIFY_EMAIL_ADAPTER` | `off` | `off`, `log` (dry run), or `smtp` (SMTP over implicit TLS, port 465). |

Before you turn on an external Christie provider, confirm that a DPA covers
it. Only redacted text from the current question, plus approved lesson
content, is sent.

## 5. Notification job and providers
Email uses `NOTIFY_EMAIL_ADAPTER=off|log|smtp`; SMS uses
`NOTIFY_SMS_ADAPTER=off|log|twilio`; push remains `off|log` only. SMTP uses
implicit TLS on port 465. Twilio requires Verify and Messaging credentials and
an approved sender or Messaging Service SID. Keep credentials in the deployment
secret manager. Both external channels send generic notification content only.

If an external adapter is enabled, schedule `node src/notify-dispatch.js`
with the documented worker database role. In development, run `make notify`.
With all adapters `off`, nothing is sent externally.

## 6. Known limits
- Transport "today" uses the database `current_date`. Set the database
  timezone to the district's if runs cross midnight UTC.
- `db:retention` does not yet prune the new tables. Plan manual retention if
  your policy requires it.
