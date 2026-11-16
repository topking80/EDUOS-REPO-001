# EduOS District Edition 37.5.0

**Release type:** Monitoring and operational-readiness increment  
**Base:** 37.4.0  
**Status:** Pull request / CI validation; not yet merged or deployed

## Added

- Prometheus alert rules for unavailable queue telemetry, webhook and notification backlog age, webhook dead letters, failed notifications, PostgreSQL pool waiters, and elevated HTTP 5xx ratio.
- An operations runbook for secure authenticated metrics scraping, alert triage, safe recovery, and escalation.
- Regression tests that verify alert expressions reference metrics actually exported by EduOS, preserve documented thresholds, and avoid learner/district identifiers in metric labels.

## Existing behavior preserved

- No runtime application behavior or database schema changes in this increment.
- Existing webhook delivery, retry, lease, idempotency, destination-validation, tenant-isolation and CSP behavior are unchanged.
- Existing bus check-in, driver handoff, teacher receipt, first-attendance and offline replay flows are unchanged.
- No real email, SMS or push sender is introduced. The shipped `off` and `log` adapters remain non-delivery modes; `skipped` is not a successful external delivery.

## Deployment requirements

1. Configure Prometheus to scrape the internal `/metrics` endpoint using the bearer token from a secret manager.
2. Add `monitoring/eduos-alerts.yml` to Prometheus `rule_files`.
3. Run `promtool check rules monitoring/eduos-alerts.yml`, reload Prometheus and confirm rules are active.
4. Route EduOS warning alerts to the responsible operations team.
5. Keep `/metrics` private; do not commit metrics credentials.

See `docs/OPERATIONS-QUEUE-ALERTS.md`.

## Validation gates

- GitHub Actions unit, PostgreSQL integration, security, edge, mobile and end-to-end checks.
- Prometheus rule syntax validation with `promtool`.
- Operator verification of authenticated scrape and alert routing.

No production deployment or live district validation is claimed by this release note.
