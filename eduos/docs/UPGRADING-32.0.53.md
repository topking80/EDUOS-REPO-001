> Upgrading further to 32.0.54? Also follow `docs/UPGRADING-32.0.54.md` (edge build-time credentials, kiosk account, migration check).

# Upgrading to EduOS 32.0.53

## 1. Database roles (required)
The API now **refuses to start** when its database role is a superuser, has
BYPASSRLS, or owns the EduOS tables. In those cases row-level security does not
protect tenant data.

**New compose deployments:** set `POSTGRES_PASSWORD`, `EDUOS_OWNER_PASSWORD` and
`EDUOS_APP_PASSWORD` in `.env`. Use URL-safe values, e.g. `openssl rand -hex 24`.
Compose refuses to start without them. `db/init/00-eduos-roles.sh` creates
`eduos_owner` and `eduos_app` on first boot.

**Existing 32.0.52 compose volumes** (the init script does not re-run). Set
`POSTGRES_SUPERUSER=eduos` and keep your existing `POSTGRES_PASSWORD`. Add
`EDUOS_OWNER_PASSWORD` and `EDUOS_APP_PASSWORD` to `.env`, then split the roles
once as the old superuser and restart (export the two passwords from `.env`
into your shell first):

```sh
docker compose stop app
docker compose exec -T db psql -U eduos -d eduos -v ON_ERROR_STOP=1 \
  -v owner_pw="$EDUOS_OWNER_PASSWORD" -v app_pw="$EDUOS_APP_PASSWORD" \
  -f - < db/upgrade/32.0.53-split-roles.sql
docker compose up -d   # migrate (as eduos_owner) applies 009 + grants; the API starts as eduos_app
```

The script creates both roles and hands the database, schema, tables,
sequences and functions to `eduos_owner`. `REASSIGN OWNED` cannot be used,
because the bootstrap superuser owns system objects. This path was rehearsed on a
32.0.52-migrated database containing data (see the validation report).
Take a backup first.

**Non-compose deployments:** run `npm run db:migrate` with `DATABASE_URL`
pointing at the owner role and `EDUOS_APP_ROLE` naming the runtime role (default
`eduos_app`). The grants are now applied automatically; set
`MIGRATE_APPLY_GRANTS=false` to apply `db/runtime_grants.template.sql` yourself.
Run the API with `DATABASE_URL` set to the runtime role.

Passwords such as `change-this`, `changeme`, `password` or `postgres` in
`DATABASE_URL` are rejected at startup.

## 2. Migration 009 (automatic)
- Adds `district_users` and re-points the foreign keys that used
  `memberships(district_id,user_id)`. Memberships become unique per
  `(user, district, school, role)`, so one account can hold several roles or
  schools.
- Adds `audit_events.school_id` (existing rows stay NULL, meaning district-wide,
  so principals do not see them), `teacher_student_rosters`,
  `flow_events.subject_student_id`, `sessions.last_seen_at`/`verified_email`,
  `oidc_pending_logins`, and the purge/retention functions.

## 3. Behaviour changes that need action
- **Teacher rosters.** Teachers now see only students assigned to them. After
  upgrading, principals or superintendents must populate rosters
  (`POST /api/rosters {teacherUserId, studentId}`). Until then teachers see no
  students. Case owners and case creators keep access to their cases.
- **Guardian invitations** are accepted only when the IdP asserted a verified
  email that matches the invitation. For Microsoft Entra ID, set
  `OIDC_EMAIL_VERIFICATION=entra` and enable the `xms_edov` optional claim. Use
  `trusted` only if every email your IdP issues is administrator-controlled.
  Sign-in itself no longer requires `email_verified`.
- **Demo UI** (persona switcher, guided tour, synthetic data,
  Arrival/Transportation walkthrough) is hidden unless `EDUOS_DEMO_MODE=true`,
  which is refused when `NODE_ENV=production`.
- **Sessions:** the idle timeout is 30 min (`SESSION_IDLE_MINUTES`), with at most
  5 sessions per user (`SESSION_MAX_PER_USER`). Signing in again from the same
  browser revokes the old session. On https origins the cookie is
  `__Host-eduos_session` and Secure, so all users sign in once more after the
  upgrade. Pending OIDC logins are stored in the database, which is safe for
  multiple instances.
- **CSRF:** `GET /api/csrf` is stable for the life of a session. Clients may cache it.
- **Access requests:** only `schools:update` can be requested or granted.
  Pending requests for other permissions can no longer be approved.
- **API errors:** malformed JSON returns 400 `invalid_json`; oversized bodies
  return 413 `payload_too_large`. DATE fields are `YYYY-MM-DD` strings.
- **Production without DB TLS:** allowed only with
  `DATABASE_SSL_ALLOW_PRIVATE_NETWORK=true` and a private/loopback host (compose
  sets this).

## 4. Retention and records requests
- Schedule `docker compose --profile ops run --rm retention` (or
  `npm run db:retention` with the owner `DATABASE_URL`) nightly. The windows come
  from `RETENTION_AUDIT_DAYS` (2555), `RETENTION_CLOSED_CASE_DAYS` (2555),
  `RETENTION_FLOW_EVENT_DAYS` (90), `RETENTION_WEBHOOK_DELIVERY_DAYS` (90) and
  `RETENTION_SESSION_DAYS` (30). Choose values that match district policy and
  state law.
- `POST /api/students/:id/records-export` returns a student's record (audited).
  `POST /api/students/:id/records-delete` (superintendent;
  `{confirmLocalStudentNumber, reason}` with a reason of at least 20 characters)
  purges the student and their dependent rows. Audit rows are kept and the
  deletion itself is audited.

## 5. Edge platform
Run `make ignition` from `edge-platform/eduos` to rebuild Ignition. The
enrollment token is generated on every boot at `/run/eduos/enrollment-token`.
The `boot/*.iso` files are 0-byte placeholders. See
`edge-platform/eduos/docs/BUILD.md`.
