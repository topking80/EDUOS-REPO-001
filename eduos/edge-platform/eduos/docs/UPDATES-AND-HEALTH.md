# OS updates and device health (Edge Phase 2)

## OS updates

Fedora CoreOS updates itself: **Zincati** asks Fedora's update graph for new
releases and **rpm-ostree** stages each one as a signed (GPG-verified), atomic
deployment, keeping the previous deployment. EduOS no longer turns Zincati off.
`eduos-update` (a small root script on the host, `services/update.*`) adds the
district's rules on top:

| Policy (`/etc/eduos/update-policy.toml`) | What happens |
|---|---|
| `[general] enabled = false` | Zincati takes no update actions. |
| `strategy = "immediate"` | Updates install and reboot as soon as they're ready. |
| `strategy = "maintenance-window-only"` | Reboots only inside `[maintenance_window]` (every day, in `timezone`, which may be `localtime`). |
| `strategy = "canary"` (default) | Same windows. `[canary] percent` of devices, chosen by a hash of `/etc/machine-id` so a device stays in its cohort, ask for each release first (`rollout_wariness = 0.0`); the rest ask to be last (`1.0`). |
| `[rollback]` | After a device boots into a new deployment and has run for `[canary] health_check_minutes`, it must have no failed `eduos-*` units, root disk under `threshold_disk_percent` and 5-minute CPU load under `threshold_cpu_percent`. Healthy: it becomes the known-good deployment. Unhealthy: updates are **held** (so the same release isn't re-applied) and, with `automatic = true`, the device rolls back once (`rpm-ostree rollback --reboot`). |

Until `eduos-update` first runs, a base fragment keeps Zincati to a 02:00–04:00
local window rather than its default "reboot as soon as ready".

`eduos-update` runs from `eduos-update.timer` (5 minutes after boot, then every
15 minutes) and whenever the policy file changes (`eduos-update.path`). It
restarts Zincati only when the generated config changed. A bad policy (bad
time, time zone, percent or strategy) is refused and the last good config
stays.

**Holds.** A held device shows *Updates held* with the reason in EduOS (Nodes >
Edge devices). After investigating, run `sudo eduos-update.sh release-hold` on
the device.

**What isn't automated.** `[approvals] require_district_signoff` can't be
enforced by Zincati; to wait for sign-off, set `[general] enabled = false`
until the district approves. Zincati's canary is a request to the update
graph, not a promotion gate: standard devices aren't held until canaries report
healthy. Neither of these has been tested on physical edge hardware yet.

## Device health

`eduos-health` (bash, as the unprivileged `eduos-health` user, uid 10003; on
the host from `services/health.service` or in the `eduos-health` container)
collects CPU, memory, disk, temperature, uptime, SELinux and Secure Boot state
and `eduos-update`'s OS status every `[agent] interval_seconds`, and sends it to
the district EduOS server. Reports never contain student data.

1. In EduOS, **Nodes > Edge devices > Register a device**. Copy the token
   (shown once).
2. On the device, put it in `/etc/eduos/health-token`. The service makes it
   readable by the `eduos-health` group only.
3. Set `[reporting] endpoint = "https://<your EduOS server>/api/edge/health"`
   in `/etc/eduos/health.toml` (or a district overlay). Only https is used.

Unsent reports wait in `/var/lib/eduos/health/outbox` (at most
`max_cache_entries`, oldest dropped first) and are sent oldest-first with
back-off while the server is unreachable. A revoked token stops reporting;
register the device again for a new one. Report history on the server is kept
for `RETENTION_EDGE_REPORT_DAYS` (default 30) days.
