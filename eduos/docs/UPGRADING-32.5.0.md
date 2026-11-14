# Upgrading to EduOS 32.5.0

## 1. Run migration 013
`db/013_safetyos_pickup.sql` adds SafetyOS and car pick-up. Run it with the
owner role:
```sh
DATABASE_URL=<owner url> npm run db:migrate
```
The app refuses to start until the migration is applied ("ready 13").
`runtime_grants.template.sql` is reapplied by the migrator and adds the
column-limited grants for the new tables.

What it adds:
- `schools.timezone` (IANA name, default `America/New_York`) and
  `eduos_school_today(school)`. Bus runs and pick-up use the school's own
  "today" instead of the database server's date.
- `safety_incidents`, `safety_events` (append-only), `safety_rollcall_entries`
  (append-only; the latest entry per learner wins).
- `pickup_adults`, `pickup_tags` (SHA-256 of the code only), `pickup_restrictions`,
  `pickup_early_dismissals`, `pickup_events` (append-only release log).
- FORCE RLS on every new table, with tenant isolation plus restrictive per-role
  policies. Families never read roll call or restrictions, and teachers don't
  read restrictions (the pick-up line sees a flag only).
- `eduos_retention_purge_role_apps()` and an updated `eduos_purge_student`
  (FERPA deletion now also removes pick-up and roll-call rows for the learner).

## 2. Set each school's time zone
```http
PATCH /api/schools/:id   { "timezone": "America/Chicago" }
```
Invalid names are refused. Existing schools default to `America/New_York`.

## 3. New dependency
`qrcode@1.5.4` (MIT) builds the pick-up pass QR on the server. Run `npm ci`.

## 4. Environment variables (all optional)
| Variable | Default | Meaning |
|---|---|---|
| `SAFETY_TEACHERS_MAY_INITIATE` | `true` | `false` lets only principals and superintendents start alerts |
| `SAFETY_RATE_LIMIT_PER_MIN` | `120` | per-user limit for SafetyOS writes |
| `PICKUP_VERIFY_RATE_LIMIT_PER_MIN` | `30` | per-user limit for pass checks, releases and refusals |
| `RETENTION_NOTIFICATION_DAYS` | `180` | in-app notifications |
| `RETENTION_CHRISTIE_DAYS` | `365` | Christie sessions and turns |
| `RETENTION_TRANSPORT_DAYS` | `400` | bus runs and check-ins |
| `RETENTION_COMMS_DAYS` | `730` | messages, threads, announcements |
| `RETENTION_SAFETY_DAYS` | `2555` | closed or cancelled incidents with their logs (7 years) |
| `RETENTION_PICKUP_TAG_DAYS` | `30` | expired or revoked pick-up passes (release log follows `RETENTION_SAFETY_DAYS`) |

`npm run db:retention` (owner role) now also purges these.

## 5. Operating notes
- **Who starts an alert:** principals, superintendents and (by default)
  teachers, in two steps: start, then confirm within 2 minutes repeating the
  type and the drill/real flag. One live incident per school.
- **What families get:** a generic in-app notice for their child's school
  (in effect, reunification, all clear). During reunification they see only
  their own children and whether each was released. Email, SMS and push
  adapters stay off; nothing leaves EduOS.
- **Pick-up during an incident:** releases are paused while an incident is
  active and resume, logged to the incident, during reunification.
- **Pass codes** are shown once; re-issuing revokes the old pass. Guardians'
  passes last up to 30 days, authorized adults' 1 day by default. Staff type
  the code or use a handheld (keyboard-wedge) scanner; the app does not use the
  camera (`Permissions-Policy: camera=()` is unchanged).
- **Do-not-release** always blocks and alerts the school leaders. A custody
  order needs an explicit acknowledgement at release. Restrictions are visible
  to leaders only.
- **Not included by design:** location tracking, facial recognition, cameras,
  threat scoring, and any link to 911 / first-responder systems. Call 911
  first; EduOS is the school's internal coordination tool.
