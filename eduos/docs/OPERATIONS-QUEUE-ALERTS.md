# EduOS queue and API alert runbook

This runbook accompanies `monitoring/eduos-alerts.yml`. The rules use only
bounded aggregate metrics already exposed by the authenticated `/metrics`
endpoint. They do not label samples by district, school, student, recipient,
message, webhook URL or raw request path.

## Install

1. Configure Prometheus to scrape the EduOS `/metrics` endpoint over the
   internal network. Supply `METRICS_TOKEN` as a bearer credential using your
   secret manager or Prometheus `credentials_file`; do not put the token in
   this repository or a dashboard URL.
2. Add `monitoring/eduos-alerts.yml` to Prometheus `rule_files`.
3. Validate and reload the Prometheus configuration, then confirm the rule
   group is loaded and the scrape is healthy.
4. Route `severity="warning"` alerts to the district platform operations
   on-call. Tune notification routing to the deployment's support hours and
   escalation policy.

Example Prometheus configuration fragments (merge with the deployment's
existing configuration):

```yaml
scrape_configs:
  - job_name: eduos
    metrics_path: /metrics
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /run/secrets/eduos-metrics-token
    static_configs:
      - targets: ["eduos.internal:8080"]

rule_files:
  - /etc/prometheus/rules/eduos-alerts.yml
```

Use the actual internal service address and TLS termination used by the
deployment. Never publish `/metrics` to the public internet.

## Alert response

### Queue backlog metrics unavailable

- Confirm Prometheus can reach the authenticated endpoint and the token has
  not expired or been rotated.
- Check API health and PostgreSQL connectivity.
- Verify the runtime role can execute `eduos_queue_backlog()`.
- Treat missing backlog data as unknown, not as an empty queue.

### Webhook queue age or dead letters

- Check API health and whether the every-district webhook sweep is enabled
  (`WEBHOOK_DISPATCH_INTERVAL_SECONDS`; default 60 seconds).
- Confirm `WEBHOOK_SIGNING_KEY` is configured and production destination
  allowlist policy is intentional.
- Inspect sanitized outcomes for DNS failure, destination rejection,
  timeout, receiver throttling (429/503), and permanent HTTP errors.
- Correct the receiver or policy issue before retrying a dead-lettered event.
  Preserve its stable delivery ID and assume at-least-once delivery: receivers
  must deduplicate by that ID.
- Do not bypass destination validation, enable redirects, or weaken DNS/IP
  checks to clear an alert.

### Notification queue age or failed notifications

- Check the deployment's configured notification dispatch job and its last
  successful run, database role, and logs.
- Confirm the selected adapter is actually implemented and configured.
  EduOS currently ships `off` and `log` dry-run adapters only; neither sends
  email, SMS or push notifications.
- A `skipped` notification is not delivered. Do not report it as sent.
- Before introducing a real provider, require provider-side idempotency using
  the notification row ID and test lease expiry, retries and permanent errors.

### Database pool waiting

- Check PostgreSQL connection saturation and the combined connection budget
  across every API replica and background worker.
- Inspect slow queries, long transactions and worker concurrency.
- Do not raise `DATABASE_POOL_MAX` without confirming PostgreSQL capacity;
  increasing every replica's pool can worsen saturation.

### HTTP server error ratio

- Use the route-template, method and status-class metrics to identify the
  affected route family.
- Correlate with application logs using `X-Request-Id`.
- Check recent deployments, database health and dependent service errors.
- Keep raw URLs, student identifiers, request bodies and notification content
  out of telemetry and alert labels.

## Recovery and closure

1. Record the alert, affected service, start time and sanitized evidence.
2. Restore the dependency or configuration that caused the failure.
3. Verify queue age is falling and retries are progressing; confirm dead-letter
   and failed counts have been reviewed rather than silently discarded.
4. For replay, use the application's supported administrative workflow and
   preserve idempotency keys. Never edit queue rows directly in production
   unless following an approved database recovery procedure.
5. Close the alert only after the metric returns to normal and the relevant
   end-to-end workflow has been verified.

## Thresholds

The defaults follow `docs/RELEASE-GATE.md`: webhook oldest-ready age above
300 seconds and notification oldest-ready age above 120 seconds, each for
10 minutes. The dead-letter/failed and backlog-read alerts are warning-level
signals for operator review. Tune thresholds from measured district workload;
these are operational starting points, not measured service-level objectives.
