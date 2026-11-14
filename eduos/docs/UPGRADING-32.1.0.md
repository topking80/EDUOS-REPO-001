# Upgrading to EduOS 32.1.0

32.1.0 adds the administration API and UI, SIS CSV import, assignment drafts,
metrics, a production bootstrap command and the one-command local evaluation
stack. There are **no new migrations**. The runtime grants changed, so run the
migrate step once.

## Docker Compose deployments
```sh
git pull   # or unpack the release
docker compose --profile edge down          # keeps volumes; recreates the networks (see "Edge network")
docker compose --profile edge up -d --build # migrate re-applies db/runtime_grants.template.sql
```

## Non-compose deployments
1. Deploy the code and run `npm ci`.
2. Run `npm run db:migrate` with `DATABASE_URL` set to the **owner** role.
   This applies the new runtime grants: `INSERT` on schools, users, memberships
   and district_users; column-limited `UPDATE`; explicit `REVOKE DELETE, TRUNCATE`.
   The API's new administration routes need them.
3. Restart the API.

## What changed for operators

| Area | Change | Action |
|---|---|---|
| First account | `npm run db:bootstrap -- --district … --sub … --name … --email …` (compose: `docker compose run --rm migrate node src/bootstrap-district.js …`). It creates a district and its first superintendent as the owner role. It is idempotent, audited, and refuses an identity that belongs to another district. | Fresh installs only. Before 32.1.0 there was no supported way to do this. |
| People | Superintendents manage schools, people and roles under **Administration**. Principals manage teacher, parent and pupil accounts at their own school under **People**. Disabling a role or an account takes effect on the next request. | None |
| Dockerfile | Multi-stage file. The last stage, `app`, is the default and production target and contains no development tooling. `devtools` holds the local OIDC provider, the seed and the webhook sink, and is used only by `docker-compose.dev.yml`. Compose builds `target: app` and tags `eduos-app:local`. | If your CI runs `docker build --target …`, use `app`. |
| Edge network | `EDUOS_EDGE_SUBNET`, `EDUOS_EDGE_IP` and `EDUOS_EDGE_IP_RANGE` are configurable, with defaults that match 32.0.54 (172.30.0.0/24, .2). edge_net now has an `ip_range` (.128/25), so Docker can no longer give .2 to the app before the edge starts. That race caused "Address already in use". `TRUSTED_PROXY_IPS` defaults to `${EDUOS_EDGE_IP}/32`. | Run `docker compose --profile edge down` once before `up`. Compose does not change an existing network's IPAM settings. |
| Ports | `EDUOS_HTTP_PORT` and `EDUOS_HTTPS_PORT` (default 80/443). | None |
| env file | Services read `${EDUOS_ENV_FILE:-.env}`. | None |
| DB healthcheck | `pg_isready -h 127.0.0.1`. On first boot the socket check reported healthy while the init scripts were still running, so migrate failed with "Connection terminated". | None |
| Login rate limit | `LOGIN_RATE_LIMIT_PER_15M` (default 600, range 10–100000). It was a fixed 30 per IP, which locks out a whole school behind one NAT address. | Lower it if you want the old behaviour. |
| Metrics | `GET /metrics` (Prometheus text) on the app port. It is served only when `METRICS_TOKEN` (16+ characters) is set, requires a Bearer token, and is not proxied by the edge. It contains no personal data. | Optional |
| /health | Now returns `{"status":"ok","version":"32.1.0"}` with `Cache-Control: no-store`. | Update monitors that compare the exact body. |
| OIDC | In production `OIDC_ISSUER` must be https. A provider that advertises `eduos_dev_idp` (the bundled local provider) is refused when `NODE_ENV=production`. An unreachable IdP now gives the person a 503 "Sign-in is temporarily unavailable" page instead of a JSON 500. | Check your issuer is https. |
| Assignments | `POST /api/assignments` accepts `status: "draft"`; the default is still `published`. New `PATCH /api/assignments/:id` publishes, closes or reopens an assignment. It cannot go back to draft once there are submissions. The `assignment.created` flow event and webhook fire on publish. | None |
| SIS | `POST /api/integrations/sis/import-csv` takes CSV text with the same semantics as the JSON import (`schools:update`; batch ids are idempotent). Errors cite the CSV line. Impossible dates such as 2026-02-31 are now rejected (400) in all attendance inputs. They used to reach the database. | None |
| Schools | `GET /api/schools` also returns `status`. | None |
| Guardian invitations | `/#guardianInvite=<token>` links now work. The UI keeps the token in sessionStorage, removes it from the address bar, and offers acceptance after the parent signs in. | None |

## Local evaluation (new)
`make up` / `make down`. See `GETTING-STARTED.md`. The development pieces
(`docker-compose.dev.yml`, `dev/`) refuse `NODE_ENV=production` and never ship
in the `app` image. Do not use them for a real deployment.
