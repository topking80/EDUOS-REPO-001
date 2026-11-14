# EduOS 32.1.0 — working platform

Goal: an operator can bring EduOS up, sign in and use every core flow end to end.
This release started from 32.0.54 and fixed or built everything that blocked
that. Operator actions are in `docs/UPGRADING-32.1.0.md`. Quick start is
`GETTING-STARTED.md`.

## How to start it
```sh
make up        # generates .env.dev secrets, builds, starts, migrates, seeds; prints URL + logins
               # https://localhost:8443/  ->  "District sign-in"  ->  pick a demo account
make smoke     # 25-step HTTP end-to-end test
make down      # stop (make down-volumes also deletes the data)
```

## Blockers found by bringing the stack up as an operator

| # | Problem | Fix |
|---|---|---|
| 1 | A fresh install had no supported way to create the district or the first account, so nobody could ever sign in. | `npm run db:bootstrap` (`src/bootstrap-district.js`): owner role, idempotent, audited, refuses identities from another district. Documented in the README "Deploy" section. |
| 2 | On first boot `migrate` failed with "Connection terminated". The db healthcheck used the Unix socket, which reports healthy during the image's init-script phase. | `pg_isready -h 127.0.0.1`. |
| 3 | The edge sometimes failed with "Address already in use". Docker could hand 172.30.0.2 to the app before the edge claimed it. | `ip_range` on edge_net (.128/25). The edge IP stays outside it. |
| 4 | Fixed 172.30.0.0/24 collides with hosts and VPNs that already use it, so compose cannot create the network. | `EDUOS_EDGE_SUBNET`, `EDUOS_EDGE_IP` and `EDUOS_EDGE_IP_RANGE`; `TRUSTED_PROXY_IPS` follows them. `make up` picks a free subnet. |
| 5 | Ports 80/443 were hard-coded. | `EDUOS_HTTP_PORT` and `EDUOS_HTTPS_PORT`. |
| 6 | Login was limited to 30 per IP per 15 minutes. A school behind one NAT address locked itself out. Testing hit it at once. | `LOGIN_RATE_LIMIT_PER_15M`, default 600. |
| 7 | There was no sign-in without a real IdP, so the product could not be evaluated or tested end to end. | Local OIDC provider (`dev/dev-idp.js`): PKCE S256, RS256 ID tokens, account picker. It is gated so it can never run in production (see below). |
| 8 | Concurrent `client.query()` on one transaction client (family summary, Student 360) logged a pg deprecation warning. It breaks in pg 9. | The queries now run in sequence (`inSequence`). |
| 9 | Impossible dates (2026-02-31) passed validation and reached PostgreSQL in the attendance API and the SIS import. | `isCalendarDate()` round-trip check, which returns 400. |
| 10 | Guardian invitation links (`/#guardianInvite=…`) went nowhere: nothing in the UI read them. | The bridge captures the token into sessionStorage, strips it from the URL and offers acceptance after the parent signs in. |
| 11 | Parents were shown "Submit work". Their role cannot submit, so the button only produced errors. | Only pupils see it. |
| 12 | An unreachable IdP turned `/auth/login` into a JSON 500. | 503 "Sign-in is temporarily unavailable" page, with a request reference. |
| 13 | Signing in switched the hidden demo workspace's persona, which flashed its hand-off toast over the real UI outside demo mode. Notifications also stacked on top of each other. | Persona alignment runs only in demo mode. One notification at a time. |
| 14 | The README quickstart had no compose deploy path and no bootstrap step. It also said "use district sign-in" on a database with no users. | Rewritten Run section: local evaluation, deploy with Compose, and without Docker. |

## Built (the backend existed, or was needed, and there was no way to use it)

**Administration API** (`src/admin-routes.js`, all audited):
- Create and update schools.
- List people and create users and memberships.
- Enable or disable a membership or an account. Disabling takes effect on the next request.
- Principals are limited to teacher, parent and pupil accounts at their own school, and do not see sign-in subjects.

Runtime grants were extended (`INSERT`, column-limited `UPDATE`, explicit `REVOKE DELETE`).

**SIS CSV import** (`src/csv.js`, `POST /api/integrations/sis/import-csv`): RFC 4180 parsing, idempotent batches, line-numbered errors.

**Assignment drafts**: draft, published or closed. Drafts stay hidden from pupils and families. The flow event and webhook fire on publish.

**Metrics**: `GET /metrics` (Prometheus text, Bearer `METRICS_TOKEN`, internal only, no personal data). `/health` reports the version.

**UI** (`public/api-bridge.js`) — new workspaces in the authenticated server workspace:
- Administration / People
- Rosters
- Guardian invitations, with a one-time copyable link and revoke
- Link a child, for parents
- SIS import, with file upload and a run history
- Webhooks: secret shown once, send test, deliveries, disable
- Assignment visibility, with Publish, Close and Reopen
- FERPA export (JSON download) and superintendent-only delete in Student 360
- A real landing page

**One-command stack**:
- `make up` / `scripts/dev-up.sh` and `make down` / `down-volumes`.
- Plus `make smoke`, `smoke-browser`, `seed`, `retention`, `metrics`, `trust-ca`, `logs` and `ps`.
- `docker-compose.dev.yml` adds the dev IdP, the seed and a loopback webhook sink.

**Demo data**: the Riverside Unified demo district. Two schools, nine accounts across every role, eight students, rosters, a linked guardian, an unlinked invitee, published and draft assignments, attendance, a submission and an intervention case.

**Automated E2E**:
- `dev/smoke.mjs`: 25 HTTP steps through the real edge and OIDC flow.
- `dev/browser-smoke.mjs`: 16 headless-Chrome steps, with screenshots.
- `.github/workflows/ci.yml`: unit, PostgreSQL integration, edge, and an e2e job that runs `make up`, both smoke tests and uploads the screenshots.

## Production gates for the development pieces
- The `devtools` Dockerfile target is the only image with `dev/`. The default `app` target has no dev code. `docker-compose.yml` has no development services.
- The dev IdP, the seed and the webhook sink refuse `NODE_ENV=production`. The seed also requires `EDUOS_ALLOW_DEMO_SEED=true`.
- The API refuses any provider that advertises `eduos_dev_idp` in production, and production requires an https `OIDC_ISSUER`. The dev IdP is plain http, so it is refused twice.
- The dev IdP is published on 127.0.0.1 only. Plain-http webhooks are allowed only to loopback and only outside production (`WEBHOOK_ALLOW_INSECURE_LOOPBACK`).

## Results (Tuesday Nov 10, 2026, EST, on the box)

| Suite | Result |
|---|---|
| Unit (`npm test`) | 286/286 pass (15 new in `test/platform-32100.test.js`) |
| PostgreSQL 16 integration (`npm run test:integration`) | 33/33 pass (7 new in `test/integration/platform.test.js`) |
| Full-stack HTTP smoke (`make smoke`, fresh `make up`) | 25/25 |
| Headless-browser smoke (`dev/browser-smoke.mjs`, Chrome) | 16/16, no page errors |
| Edge Python unit tests | 30/30 |
| `make -C edge-platform/eduos check` (butane --strict) | pass |
| Production compose path (`.env.example` → `NODE_ENV=production`, https issuer, `--profile edge up -d --build`) | stack healthy; `/health` 200; unreachable IdP → 503 page; `db:bootstrap` created the district and re-ran idempotently; retention ran |

Screenshots of the key screens are in `/workspace/eduos-screens/` (01–15).

## Not verified
- Sign-in with a real Entra ID or Google tenant: only the local provider and the test mock were used.
- Real edge hardware and OS images: only the lint and butane checks ran.
- Public hosting with a real domain and ACME certificates: only Caddy's local CA was used.
- The GitHub Actions workflow has not run on GitHub.
- Upgrading an existing 32.0.54 compose deployment in place, including network recreation after the `ip_range` change: documented, not exercised.
- The non-Docker path: only through the integration tests, which run migrate and the API natively.
- Docker on the box was installed by hand (no apt). Results come from that engine (27.3.1, Compose 2.30.3).
