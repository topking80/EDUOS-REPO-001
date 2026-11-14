# EDUOS 37.4.0 — Audit Addendum 3: Full Docker Compose Stack (Item 9, Local Part)

**Branch:** `fix/eduos-37.4.0-audit-findings`
**Date:** November 14, 2026
**Stack:** Docker 29.9.3 and Compose v5.7.0. The project's own `make up` path ran `docker-compose.yml` plus the dev overlay with the Caddy 2.8 edge, PostgreSQL 16 (alpine), a local OIDC provider and a local webhook receiver.

## Sandbox-only change (not committed)

The build sandbox reaches npm only through an egress proxy. For the local image build only, the `deps` stage of a throwaway copy of the Dockerfile trusted that proxy's CA and used the proxy. The `app` and `devtools` images copy only `node_modules` from that stage, so neither the CA nor the proxy settings are in the images that ran. All application code is exactly this branch's.

## New findings

### F-8 — Shell scripts shipped without the execute bit (packaging defect, fixed)
- Every file in the 37.3.1 and 37.4.0 archives is stored as `-rw-r--r--`. This includes all 15 shell scripts.
- `make up`, `make down`, `make smoke` and `make eden-sim` fail with "Permission denied".
- **Fix:** mode 100755 for the 15 `*.sh` files (contents unchanged). The database init script was unaffected, because the postgres image sources non-executable init scripts.

### F-9 — "Send test webhook" returned 500 since 37.3.0 (defect, fixed)
- `POST /api/webhooks/:id/test` calls `deliverToSubscription()`, which was removed when 37.3.0 moved delivery to the outbox. The call site remained, so every test delivery failed with "deliverToSubscription is not defined".
- Unit tests only matched the route's source text. The project's smoke test caught it on the first full-stack run.
- **Fix:** `deliverToSubscription()` is restored. It sends one signed `webhook.test`, records it in the delivery ledger, and never affects auto-disable.
- New integration test through the real API. Without the fix, 2 of its 3 tests fail.

## Results

| Check | Result |
|---|---|
| `make up`: build, 36 migrations as the owner, seed | OK |
| `make smoke` against `https://localhost:8443` through Caddy | **39/39** (17/18 before F-9: the test-delivery step returned 500) |
| API database role | `eduos_app`: not superuser, no BYPASSRLS |
| Edge headers | CSP, HSTS (1 year), `nosniff`, `SAMEORIGIN`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`; HTTP → HTTPS 308 |
| `--profile ops`: `migrate` re-run, `retention`, `notify` | OK (re-run is a no-op; retention reports per-district counts, including `offline_replays`) |
| `--profile ops`: `webhooks` (new dispatcher) | Claimed a requeued job with the API idle. It delivered with the same delivery ID when the job ran where the test receiver is reachable. |
| Unit / integration suites | 584/585 (1 skip) / 98/98 |

**Note on the webhook dispatcher test:** in the dev overlay, the test receiver shares the API container's network namespace and listens on 127.0.0.1, so a separate `webhooks` container can't reach it there. Run in the API container's namespace, the same image delivered successfully. In production, receivers are public HTTPS hosts, which the `webhooks` service reaches through `edge_net`.

## Item 9: still to do in the target environment
- **Real identity provider:** HTTPS issuer and redirect URI.
- **Edge:** public DNS, TLS certificate and network ranges.
- **Secrets:** generation and storage.
- **Schedules:** `retention` nightly, and `webhooks` every minute if webhooks are enabled.
- **Upgrade:** the existing production database, backed up first.

**Disposition:** Continue validation. Not production approval.
