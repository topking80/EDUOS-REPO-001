# Federation monitoring runbook (FED-09)

This runbook goes with `monitoring/federation-alerts.yml`. The rules use only counts and ages:
- Master Control's `/mc/metrics` names no operator, node, agreement or student;
- the `eduos_federation_*` gauges on each EduOS's `/metrics` name no district.

## Install

1. **Scrape Master Control.** Set `MC_METRICS_TOKEN` on Master Control (without it, `/mc/metrics` answers 404). Scrape `/mc/metrics` over the internal network with that token as a bearer credential, under the job name `master-control`:

   ```yaml
   scrape_configs:
     - job_name: master-control
       metrics_path: /mc/metrics
       scheme: https
       authorization:
         type: Bearer
         credentials_file: /etc/prometheus/secrets/mc-metrics-token
       static_configs:
         - targets: ["master-control.internal:3100"]
   ```

2. **EduOS.** Keep scraping each EduOS under `eduos` as before (`docs/OPERATIONS-QUEUE-ALERTS.md`). The federation gauges arrive on the same `/metrics`.
3. **Load the rules.** Add `monitoring/federation-alerts.yml` to `rule_files`, then validate it (`promtool check rules`) and reload.
4. **Route alerts.** Send `severity="critical"` to the security on-call, and `warning` to platform operations.
5. **Probes.** Use `GET /mc/readyz` for readiness: it answers 503 when the database doesn't. `GET /mc/healthz` is liveness only.
6. **Scheduled check.** Run `npm run mc:security-check` every few minutes as well (FED-08). It works when Prometheus is down.

## Metrics

**Master Control** (`mc_` prefix):
- the same HTTP request, latency, pool and process metrics EduOS has, with the `mc_` prefix;
- `mc_federation_up`;
- `mc_audit_chain_ok` and `mc_audit_entries`;
- `mc_audit_decisions_last_hour{decision}` and `mc_audit_max_denials_per_operator_last_hour`;
- `mc_incidents_open{severity}` and `mc_incidents_freezing_exchange`;
- `mc_signing_key_status{status}`;
- `mc_policy_bundles_unacknowledged` and `mc_policy_bundle_oldest_unacknowledged_seconds`;
- `mc_exchange_agreements{status}` and `mc_exchange_deliveries_last_day`;
- `mc_sessions_active`;
- `mc_identity_providers{status}`.

The state gauges are read at most every 30 seconds.

**EduOS** (`eduos_federation_` prefix):
- `trusted_keys` and `revoked_keys`;
- `status_up`;
- `districts{bundle}`;
- `legal_hold_districts` and `consent_required_districts`;
- `residency_districts{status}`;
- `newest_bundle_revoked_key_districts`;
- `oldest_newest_bundle_seconds`.

## Alerts

### Master Control unavailable
`MasterControlScrapeUnavailable` or `MasterControlStateUnavailable`. Check that the service is running, its network path, the token file, the database and the `mc_app` grants (`npm run mc:migrate` reapplies them). While Master Control is down, districts keep following the bundles they already hold. No new releases, terms or deliveries can be made. If the database is lost, restore it as in `docs/architecture/federation/fed-10-resilience.md`.

### Audit chain broken
`MasterControlAuditChainBroken` (critical). An audit entry was changed or removed.
1. Treat this as a security incident. `GET /mc/api/audit/verify` gives the first broken entry.
2. Preserve a database snapshot.
3. Find out who had owner or superuser access to the `master_control` schema: the runtime role can't change the log.
4. Open an incident at the platform node.

### Revoked signing key
`MasterControlRevokedSigningKeyConfigured` (critical), `EduOSNoTrustedMasterControlKey` or `EduOSBundleUnderRevokedKey`. Follow the revocation steps in `docs/architecture/federation/fed-08-security-operations.md`:
1. Configure a new secret in Master Control.
2. Add its public key to every EduOS.
3. List the revoked fingerprint in `MC_POLICY_REVOKED_KEYS`.
4. Issue a new release.
5. Have each district receive it.

### Repeated denials
`MasterControlRepeatedDenials`. `GET /mc/api/security/alerts` names the operator.
- If a role is misconfigured, fix it.
- If not, consider the account compromised: disable the operator or sign them out everywhere (FED-04), and open an incident.

### Open incident
`MasterControlHighSeverityIncidentOpen`. Work through the incident in Master Control. Close it with a note when done; this lifts any exchange freeze.

### Unanswered bundle
`MasterControlPolicyBundleUnanswered`. A district's newest bundle has had no answer for a week. The release's page shows which district. Contact the superintendent: the file may not have been uploaded to EduOS.

### EduOS federation status
`EduOSFederationStatusUnavailable`. `eduos_federation_status()` failed. Run migrations: `db/158` and the runtime grants.

### Residency not met
`EduOSResidencyNotMet`. A district's residency rule (FED-07) doesn't allow the hosting location declared in `EDUOS_DATA_LOCATION`. Review it with the district and the state. EduOS doesn't move data, and the declaration is the operator's.
