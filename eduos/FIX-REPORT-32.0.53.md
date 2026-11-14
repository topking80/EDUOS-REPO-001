# EduOS District Edition 32.0.53: Security and Privacy Fixes

32.0.53 fixes the 24 findings from the 32.0.52 security and privacy review.
Every fix has a regression test. The high findings, and most of the others, are
also covered by end-to-end tests that run against a real PostgreSQL server (see
`VALIDATION-32.0.53-SECURITY-PRIVACY.md`). Operator-facing changes and upgrade
steps are in `docs/UPGRADING-32.0.53.md`.

| # | Sev | Finding | Status | Fix |
|---|-----|---------|--------|-----|
| 1 | High | Compose ran the API as a PostgreSQL superuser, so RLS never applied | Fixed | Compose creates `eduos_owner` (schema owner, used by migrate/retention) and `eduos_app` (NOSUPERUSER NOBYPASSRLS). The API runs as `eduos_app`. `migrate` applies grants to `EDUOS_APP_ROLE` and refuses unsafe roles. The API refuses to start as a superuser, a BYPASSRLS role or the table owner. Placeholder passwords are rejected, and compose has no default passwords. |
| 2 | High | Runtime grants template incomplete | Fixed | Grants added for family_messages, teacher_classroom_preferences, sis_sync_runs, sis_attendance_imports, INSERT/UPDATE on students and student_user_links, and the new 32.0.53 tables. `migrate` applies them automatically. Integration tests exercise every affected route as the runtime role and check `has_table_privilege` for every table. |
| 3 | High | SIS import: a school-scoped `schools:update` grant could write to another school | Fixed | Non-superintendents can import only into their own school. A grant-based import must match the grant's school (`req.permissionSource`). |
| 4 | High | Guardian email regex rejected every real address (over-escaped) | Fixed | `GUARDIAN_EMAIL_RE` is exported and behaviour-tested. A live invitation is created in the integration test. |
| 5 | Med | Principals saw district-wide audit events | Fixed | `audit_events.school_id` is stamped from `app.school_id` by a trigger. Principals see only their own school's rows. |
| 6 | Med | Parents/pupils saw draft assignments | Fixed | Family and pupil assignment queries require `status='published'`. |
| 7 | Med | Teachers saw every student in their school | Fixed | New `teacher_student_rosters` table and roster API (principal/superintendent). Teacher access to students, Student 360, attendance, submissions, cases and family messaging is limited to rostered students. Case owners and creators keep access to their cases. |
| 8 | Med | OIDC discovery cached unvalidated metadata | Fixed | Metadata is validated into locals first and cached only after the issuer check passes. Discovery and JWKS have timeouts. |
| 9 | Med | `email_verified` requirement blocked Microsoft Entra ID sign-in; invitations matched an unverified directory email | Fixed | Sign-in no longer needs `email_verified`. Guardian invitations match only an IdP-verified email captured at sign-in. `OIDC_EMAIL_VERIFICATION=claim\|entra\|trusted` (`entra` accepts `xms_edov`) is documented. |
| 10 | Med | Caddy edge served static assets without security headers | Fixed | Caddy sets CSP (in step with helmet, `frame-ancestors 'self'`), nosniff, HSTS, X-Frame-Options, Referrer-Policy, COOP and Permissions-Policy. Checked against a running Caddy. |
| 11 | Med | Compose could not start in production mode (TLS required to the internal DB) | Fixed | `DATABASE_SSL_ALLOW_PRIVATE_NETWORK=true` allows plain TCP only to loopback, private or single-label hosts. Compose sets it. Remote hosts still need TLS. |
| 12 | Med | FERPA: reads not audited; no export/delete; no retention path for append-only tables | Fixed | Read auditing covers the student directory, profile, Student 360, cases and family summary. Added `POST /api/students/:id/records-export` (principal/superintendent) and `POST /api/students/:id/records-delete` (superintendent; requires the student-number confirmation and a reason). The SECURITY DEFINER purge functions are the only way to delete append-only rows. `npm run db:retention` (owner role) is configured with `RETENTION_*` settings. |
| 13 | Med | Edge: token path mismatch, `.py` not installed, stale/uncompilable Ignition, placeholder token accepted, 0-byte ISOs | Fixed (ISOs documented) | Single token path `/run/eduos/enrollment-token`, generated per boot by bootstrap. Butane installs the `.py` and the units it enables. Paths are files-dir relative and merge the compiled base. `ignition/*.ign` was regenerated with `--strict`. Placeholder tokens are refused (Python test). The 0-byte ISOs are documented as placeholders. |
| 14 | Med | Demo persona UI and Arrival/Transportation walkthrough always shown | Fixed | `EDUOS_DEMO_MODE` (refused in production). `public/eduos-mode.js` fails closed to production mode, which hides the persona workspace, tour and walkthrough and shows the authenticated server workspace. Demo mode shows a banner. |
| 15 | Low | Flow feed leaked other children's events to families; superintendent attendance events had no school | Fixed | Events carry `subject_student_id`. Parents and pupils see student events only for linked learners. Attendance events use the learner's school. |
| 16 | Low | `GET /api/csrf` rotated the token, breaking other tabs | Fixed | The token is HMAC-derived from the session token, so it is stable and the GET has no side effects. |
| 17 | Low | Bad JSON → 500; oversized body → 500 | Fixed | 400 `invalid_json`, 413 `payload_too_large`. |
| 18 | Low | Principals could write classroom preferences for other schools; any user could be a case owner | Fixed | Preferences are limited to the caller's school. A case owner must be a superintendent, or a teacher/principal at the case's school. |
| 19 | Low | DATE columns serialized as UTC timestamps (off-by-one) | Fixed | The `pg` DATE parser returns `YYYY-MM-DD`. |
| 20 | Low | Webhook SSRF guard missed IPv6 transition and deprecated ranges | Fixed | Blocks `2002::/16`, `64:ff9b:1::/48`, `::/96`, `::ffff:0:0:0/96` and `fec0::/10`. `::ffff:0:0/96` is handled by unwrapping, because adding it to Node's BlockList makes every IPv4 address match. |
| 21 | Low | Sessions: no idle timeout, no `__Host-`/Secure on https, old sessions not revoked, unbounded sessions, in-memory OIDC state, no IdP timeout | Fixed | `SESSION_IDLE_MINUTES` (default 30). `__Host-eduos_session` plus Secure when `PUBLIC_ORIGIN` is https. The previous browser session is revoked at login. `SESSION_MAX_PER_USER` (default 5). Pending logins live in `oidc_pending_logins` and are single-use. `OIDC_HTTP_TIMEOUT_MS`. |
| 22 | Low | `.env.example` had a duplicate `TRUSTED_PROXY_IPS` with the wrong subnet | Fixed | There is a single entry, documented against compose's `172.30.0.2/32` (`edge_net` 172.30.0.0/24). |
| 23 | Low | Grantable permissions with no enforcing route | Fixed | Only `schools:update` is grantable. The UI offers only that option, and approval re-checks it. |
| 24 | Low | One role/school per account | Fixed | `UNIQUE NULLS NOT DISTINCT (user_id, district_id, school_id, role)`, with `district_users` as the FK anchor. Added `GET /api/memberships` and `POST /api/session/membership` (rotates the session) and a UI switcher. Invitations accept any parent membership at the invitation's school. |

## Not changed (observed, out of scope)
- Edge Butane role configs still contain placeholder `password_hash`/SSH key
  values, and `student` is in `wheel`. These are documented in
  `edge-platform/eduos/docs/BUILD.md`; replace them in a district overlay.
- `platform/edge-runtime-reference/` is an older duplicate of the edge tree and
  was left as shipped. Use `edge-platform/eduos/`.
- Demo gating is presentational. The demo workspace is browser-local synthetic
  data with no server access, and every server API is enforced independently
  of the UI.
- The API still starts against an empty (unmigrated) database. The role check
  passes when the `students` table does not exist yet.
