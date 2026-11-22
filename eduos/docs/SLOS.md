# Service level objectives (CMP-05)

EduOS measures three service levels from the Prometheus metrics it already
exports. Each comes with an error budget, burn-rate alerts and a period report.

These are **proposed internal operating targets**, not a contractual SLA or an
uptime guarantee. A district agrees its own targets, support hours and
maintenance windows. Any figure published to families or in a contract needs
the report below as evidence, and review.

| Objective | Target (30 days) | Counts as bad |
| --- | --- | --- |
| Requests succeed | 99.9% | an API request answered with a 5xx server error |
| Requests answered within 1s | 99% | an API request taking longer than 1 second |
| Service reachable | 99.9% | a minute in which Prometheus could scrape no EduOS API instance (about 43 minutes a month) |

Not counted: Prometheus scrapes (`/metrics`), health checks (`/health`) and the
operations event stream, which stays open by design. Requests that wait on an
AI provider (`/api/ai/run`, Christie turns, Edison briefs, Leo drafts) count
for "requests succeed" but not for the 1-second target. 4xx answers
(validation, permission, not found) are the client's error, so they count as
good.

The targets, exclusions and alert thresholds live in one place,
`src/slo.js`. `monitoring/eduos-slo.yml` and its `promtool` tests
(`monitoring/eduos-slo.test.yml`) are generated from it:

```sh
node scripts/generate-slo-rules.mjs          # after changing src/slo.js
node scripts/generate-slo-rules.mjs --check  # CI: fails if the files are stale
```

CI runs `promtool check rules` and `promtool test rules` on them. The tests
cover healthy traffic, a 10% error outage, slow responses, a quiet night with
a few failures (must not page), and 15 minutes unreachable.

## Install

Alongside `monitoring/eduos-alerts.yml` (see
[OPERATIONS-QUEUE-ALERTS.md](OPERATIONS-QUEUE-ALERTS.md) for the scrape
configuration):

```yaml
rule_files:
  - /etc/prometheus/rules/eduos-alerts.yml
  - /etc/prometheus/rules/eduos-slo.yml
```

The scrape job must be named `eduos`. Prometheus needs **at least 30 days of
retention** for the 30-day budget series and the reports.

## Alerts

Multi-window, multi-burn-rate alerts, as in the Google SRE Workbook. A burn
rate of 1 spends exactly the 30-day budget in 30 days. An alert needs both its
long and short window over the threshold: the long window shows it matters,
and the short one shows it is still happening, so alerts clear soon after a
fix.

| Alert | Windows | Burn rate | Severity | Meaning |
| --- | --- | --- | --- | --- |
| `…BudgetBurnFast` | 1h and 5m | 14.4x | critical (page) | 2% of the month's budget gone in an hour |
| `…BudgetBurnSteady` | 6h and 30m | 6x | critical (page) | 5% in six hours |
| `…BudgetBurnSlow` | 1d and 2h | 3x | warning (ticket) | 10% in a day |
| `…BudgetBurnCreeping` | 3d and 6h | 1x | warning (ticket) | on course to miss the month |
| `EduOSUptimeBudgetExhausted` | 30d | — | warning | the month's uptime budget is spent |

Each exists for `Availability` and `Latency`. Outages themselves page through
`EduOSScrapeUnavailable` in `eduos-alerts.yml`. Below 0.01 requests a second
(36 an hour) the burn alerts stay quiet, so a few failures at 3 a.m. don't page
anyone. `EduOSHttpServerErrorRatioHigh` still covers sustained errors.

**When one fires:**
1. Check what changed: recent deploys, configuration, migrations.
2. Find the routes: `sum by (route, status) (rate(eduos_http_requests_total{job="eduos"}[5m]))`,
   or for latency, `histogram_quantile(0.99, sum by (route, le) (rate(eduos_http_request_duration_seconds_bucket{job="eduos"}[5m])))`.
3. Check the database pool (`eduos_db_pool_connections`) and the queue alerts.
4. Use request IDs in the application logs. Don't copy learner data into
   tickets.

## Error budget policy (proposed)

Recorded per objective as `eduos:slo_error_budget_remaining:ratio{slo="…"}`
(1 = untouched, 0 = spent, negative = overspent).

- **Budget left:** ship normally.
- **Under 25% left:** release only fixes and low-risk changes, and review the
  causes of the spend.
- **Spent:** freeze feature releases until the 30-day window recovers, except
  security and data-protection fixes, and write up what used it.

The district decides whether to adopt this policy and who can grant
exceptions.

## Report

```sh
PROMETHEUS_URL=http://prometheus.internal:9090 node src/slo-report.js --month 2026-10
PROMETHEUS_URL=… node src/slo-report.js --days 7 --json
```

The report prints a Markdown table (or JSON) with, for each objective:

- the target;
- the measured result;
- how much of the error budget was used;
- met or missed.

It also gives about how many minutes the service was unreachable. The exit
code is `0` when everything was met, `1` when any objective was missed and `2`
when there was no data or the report failed. That makes it suitable for a
monthly cron job, filed with the district's operations records.

The report only queries the district's own Prometheus. It reads aggregate
counters (no district, school, user or student labels exist), and it sends
nothing anywhere else. Set `PROMETHEUS_TOKEN_FILE` if that Prometheus needs a
bearer token. "No data" is never reported as met.

## Limits

- **Measured from inside.** Prometheus scrapes inside the district network, so
  a failure in front of it (DNS, the edge proxy, the internet link) isn't
  seen. For that, add an external probe (for example the Prometheus
  blackbox exporter on `/health` from outside the network) and treat it as a
  fourth objective.
- **Per-process counters.** Requests in flight when a process dies are lost
  from the counts. Counter resets are handled by `rate`/`increase`.
- **Calendar.** The windows are 30 days around the clock. They don't follow
  school hours or holidays.
