# FED-09 — Federation observability

Status: built. Master Control and each district's EduOS expose Prometheus metrics for the federation layer. Alert rules and their tests ship in `eduos/monitoring/`.

Code:
- Master Control:
  - `eduos/src/master-control/metrics.js` (state gauges);
  - `/mc/metrics` (needs `MC_METRICS_TOKEN`) and `/mc/readyz` in `eduos/src/master-control/app.js`.
- EduOS:
  - `eduos/src/federation-metrics.js`, on the existing `/metrics`;
  - migration `eduos/db/158_federation_status_metrics.sql`: the `eduos_federation_status()` function, which returns per-district rows without naming the district.
- Shared: `eduos/src/federation/prometheus.js` (moved from `src/metrics.js`, which re-exports it) takes a metric prefix and extra lines.
- Rules: `eduos/monitoring/federation-alerts.yml`, with tests in `federation-alerts.test.yml`. Both are checked in CI with promtool.

Runbook: `eduos/docs/OPERATIONS-FEDERATION.md`.

Labels are bounded: decision, severity, status, bundle state. Nothing names an operator, node, district, agreement or person. Every per-district fact is a count.

Tests:
- `eduos/test/federation-metrics.test.js`;
- the FED-09 case in `eduos/test/integration/master-control.test.js`;
- the FED-09 case in `eduos/test/integration/key-rotation.test.js`;
- the promtool rule tests.

## Not in this slice

- Dashboards.
- Tracing.
- Sending alerts anywhere: routing is the deployment's Alertmanager.
- Per-district panels, which would need district labels.
