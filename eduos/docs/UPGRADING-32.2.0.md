# Upgrading to EduOS 32.2.0

32.2.0 removes the product limits, adds the district app catalog and resource
mesh, adds the IT admin role and gives every role a Home screen. It has **one
new migration** (`db/010_district_resource_mesh.sql`), new runtime grants, a
Caddyfile change and new optional environment variables.

## Docker Compose deployments
```sh
git pull   # or unpack the release
docker compose --profile edge up -d --build   # migrate applies 010 and the new grants; edge reloads the Caddyfile
```
The Caddyfile is bind-mounted. If your edge container predates this release,
recreate it so it reads the new file:
`docker compose --profile edge up -d --force-recreate --no-deps edge`.
Check that `curl -s https://<host>/.well-known/jwks.json` returns JSON and not
the HTML page.

## Non-compose deployments
1. Deploy the code and run `npm ci`.
2. Run `npm run db:migrate` as the **owner** role. Migration 010 replaces the
   role CHECK constraints on `memberships` and `flow_events`, creates the
   mesh tables with RLS and FORCE, and adds `eduos_claim_seat()` and
   `eduos_app_usage()`. The grants give the runtime role `INSERT`/`SELECT` on the
   new tables. `app_launches` is append-only, and seats can be changed only
   through `eduos_claim_seat()`.
3. If you run your own reverse proxy, forward `/lti/*` and
   `/.well-known/jwks.json` to the API, in addition to `/api/*`, `/auth/*` and `/health`.
4. Restart the API.

## What changed for operators

| Area | Change | Action |
|---|---|---|
| Lists | Every list endpoint is paged. Responses are `{ data, page: { limit, offset, nextOffset } }`, with a default of 200 and a maximum of 1000 (`PAGE_SIZE_DEFAULT`, `PAGE_SIZE_MAX`). `/api/students` adds `?q=` and `page.total`. **`/api/users` used to return up to 2,000 rows and now returns pages of users.** | API clients that read more than one page must follow `page.nextOffset`. |
| Audit export | Contains **every** event (it was the newest 5,000), streamed. Dates are ISO 8601 and lines end in CRLF. | Update parsers that relied on the old date format. |
| SIS import | No row cap. The body limit is `SIS_IMPORT_MAX_MB` (default 50). A batch that would exceed the district's `max_students` cap rolls back with `409 district_limit_reached`. | None |
| Webhooks | No 10-webhook cap. Every matching subscription receives each event, and deliveries are queued (`WEBHOOK_MAX_IN_FLIGHT`). New event types: `app.*`. | Consider `WEBHOOK_ALLOWED_HOSTS`. |
| District caps | `max_schools`, `max_students`, `max_users`, `max_active_webhooks` and `max_apps`. All are NULL (unlimited); set them under **District settings**. | Optional |
| Rate limits | Guardian invitations 1,000 per hour (was 20) and webhook admin 200 per 15 minutes (was 40), both configurable. The accept limit stays at 10 per 15 minutes. See `docs/LIMITS.md`. | Lower them if you preferred the old values. |
| New role `it_admin` | District-wide systems role with no student-record access. Superintendents grant it under Administration. It cannot manage superintendents or other IT admins. | Optional |
| Apps | Catalog, licenses, assignments, sharing between schools, requests and the launcher. Students and families cannot open apps that share student data without a current signed DPA. Students in grade 7 or below need apps flagged COPPA-compliant. | Review the DPA status and COPPA flag of each app you add. |
| LTI 1.3 | Set `LTI_PLATFORM_PRIVATE_KEY` (RSA PEM; `\n` escapes allowed) to enable LTI launches. Give vendors `https://<host>/.well-known/jwks.json`, issuer `PUBLIC_ORIGIN` and auth URL `https://<host>/lti/authorize`. Tool URLs must be https. | Generate the key: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`. Keep it out of git. |
| LTI with several API instances | Login hints are single-use per process. | Use one instance or sticky sessions for `/lti/authorize` until a shared store is added. |
| UI | Home is the first tab for every role. Tab names are plain language ("Support cases", "Schoolwork", "Link a child"). | Update any staff training screenshots. |
| `/health` | Returns version `32.2.0`. | None |

## Local evaluation
`make up` now:
- adds an LTI key to an existing `.env.dev`;
- seeds four demo apps, a pending app request, an IT admin (Jamie Rivera) and a grade-1 learner (Leo Park).

Run `node dev/lti-tool.js` to try the LTI app, and `node dev/seed-large.mjs` for the
50-school / 50k-student load check. Both are development-only.

## Rollback
Migration 010 is additive, except that it widens the role CHECK constraints.
Rolling back to 32.1.0 was **not tested**. Restore from the backup you took
before migrating.
