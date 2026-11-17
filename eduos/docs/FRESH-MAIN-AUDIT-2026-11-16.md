# Fresh Main-Branch Code, Security and Release Audit

- Audit date: 2026-11-16
- Repository: `topking80/EDUOS-REPO-001`
- Branch reviewed: `main`
- Exact audited commit: `d156944dfb3c91894992814c9069d6dd640582b2`
- Application version: `37.4.0`
- Tracked repository files at audit: 796 (tree response not truncated)
- Method: fresh remote tree/commit pull; targeted source review of API configuration, authentication/authorization and RLS release gates, migrations and runtime grants, webhook dispatch/delivery, AI provider/privacy path, metrics/backlog, Docker/edge/mobile CI, upgrade/restore tests and operations documentation.
- Limitation: source-level review and GitHub CI evidence. This is not a manual line-by-line review of all 796 files, a production penetration test, a live-district test, or a production certification. No production database, district secrets, live AI provider, webhook receiver, email/SMS/push sender, or physical device was accessed.

## Executive result

The current main branch is materially stronger than the 13971c6 baseline used by the earlier audit. PR #38 (webhook reliability) and PR #39 (release gates and audit backlog) are merged. The latest main commit's CI run, `43904960020`, completed successfully across all seven jobs.

No confirmed cross-district data leak, unauthenticated remote-code execution, or webhook SSRF bypass was established in this targeted review. Important controls are now tested against real PostgreSQL and the full local Docker Compose/browser stack.

**Disposition: strong CI-validated candidate; not production-certified.** The remaining work is primarily external-provider egress hardening, privacy governance, scale/observability validation, and real deployment/device/sender verification.

## Fresh pull and change reconciliation

- Current main: `d156944dfb3c91894992814c9069d6dd640582b2`.
- PR #38 merged as `3067e60a7c8befbc0990803e8ff16be9c21fbba6`. It includes lease renewal after acquiring delivery capacity, stale-worker protection for the delivery ledger and subscription state, IPv6 special-purpose address cases, Retry-After handling, and regression tests.
- PR #39 merged at the current main commit. It adds populated-database upgrade and backup/restore release gates, queue backlog metrics, migration documentation, broader AI redaction, RLS helper grant checks, and removal of the nonfunctional root edge bootstrap container.
- Main contains 50 numbered SQL migrations (001–050) plus the runtime grants template.
- The repository currently reports no open pull requests.

## CI evidence at the audited commit

Workflow run: `43904960020` — completed, success.

| Job / check | Result |
|---|---|
| Unit | Pass: 668 / 668 |
| PostgreSQL integration | Pass: 214 / 214 |
| Docker Compose HTTP smoke | Pass: 39 / 39 |
| Browser smoke | Pass: 35 / 35 |
| Live CSP browser checks | Pass: 19 / 19 |
| Edge Python, ShellCheck, Butane, image builds/scans | Pass |
| Flutter analyze, tests and Android debug APK build | Pass |
| Dependency registry, audit, SBOM and provenance | Pass |
| Gitleaks, Trivy source/container security | Pass |

The integration log contains an expected negative-test PostgreSQL error for a duplicate open failover constraint; the job completed successfully. Passing CI establishes reproducible test evidence on the CI fixtures, not production traffic or production configuration.

## Controls verified in source and tests

### Tenant isolation, authorization and database

- Runtime DB role is required to be non-superuser, NOBYPASSRLS and not table owner.
- Runtime grants revoke PUBLIC function execution and grant the required RLS helper functions explicitly.
- The release gate exercises routes across roles, schools and districts, including cross-school writes and expected status codes.
- Upgrade-path integration test starts from a populated older schema (through migration 040), applies later migrations as the non-superuser owner, checks backfills, RLS/ownership/grants, idempotent second run, and runtime API district isolation.
- Migration 049 repairs earlier backfills district by district under forced RLS.
- Migration 050 qualifies the generated-column helper so pg_restore's empty search_path can restore it.
- Backup/restore test performs a populated PostgreSQL dump and restore, reapplies grants, then runs the API as the runtime role and verifies district isolation.

### Webhooks

- HTTPS destinations, credentials rejection, public-address validation, DNS answer vetting/pinning, redirect refusal, bounded response size and HMAC signatures are present.
- Production requires an explicit host allowlist unless the operator explicitly enables any public HTTPS host.
- Per-process concurrency limiter is wired to request dispatch, test delivery and scheduled sweep.
- A job renews its lease only after obtaining a delivery slot; stale lease holders cannot settle the job, write the attempt ledger, or alter subscription failure counts.
- Retry-After is persisted for 429/503; DNS NXDOMAIN has a shorter retry policy; attempts dead-letter and subscriptions auto-disable after repeated failures.
- API background sweep defaults to 60 seconds; an optional scheduler is also provided. Queue backlog/age/dead-letter totals are exported without district or recipient labels.

### AI and privacy

- Local AI is the default; external provider requires explicit configuration and enablement.
- Use cases are role-gated and superintendent-enabled; district/user token budgets are reserved atomically; prompts and answers are not stored in usage rows.
- External staff text and Christie fields are redacted for indexed student identifiers, numbers, email/phone/URL patterns, labelled birth dates, street-address patterns and titled names.
- The populated upgrade gate checks pre-existing student records are present in the redaction index.

### Edge, mobile and browser

- CI builds and scans edge enrollment/health images and tests that edge containers are non-root; the unused root bootstrap container has been removed.
- Flutter static analysis, unit/widget tests and Android debug compilation pass.
- Browser smoke and live CSP checks pass through the Caddy edge for all role screens.

## Remaining findings and recommendations

### P2 — External AI provider egress is less constrained than webhook/integration egress

**Evidence:** `src/config.js` requires HTTPS for `AI_PROVIDER_URL` (except an explicit development loopback option), but does not validate the destination against an approved-host list or public-address policy. `src/ai/providers.js` constructs the endpoint and calls `fetch` with the default redirect behavior. The request can include a bearer API key and redacted district text.

**Impact:** This is deployment-configuration-controlled, not a tenant-controlled URL. It is not a demonstrated remote exploit. However, a mistaken or compromised provider URL (or redirecting endpoint) can send the provider credential and redacted content to an unintended destination; HTTPS alone does not establish that the host is approved.

**Recommendation:** Parse and validate provider URLs at startup; reject embedded credentials, local/private/reserved destinations and non-approved hosts; disable redirects (or revalidate every redirect); pin vetted DNS answers if arbitrary hostnames are allowed. Add tests for private IPs, DNS rebinding, redirect-to-private, credential stripping and approved host behavior. Consider a shared egress validator used by webhooks, AI and integrations.

### P2 — AI redaction is heuristic, not a guarantee of de-identification

**Evidence:** `redact()` and `redactContent()` use the district student index plus patterns for common identifiers. The source explicitly documents that unlabelled birthdays, unusual address formats and untitled adult names may not be recognized. External use is opt-in, which is good, but the external provider still receives content after best-effort redaction.

**Impact:** Free text may contain identifying context not captured by the current index or patterns. Passing tests demonstrate coverage of known cases, not complete anonymization.

**Recommendation:** Treat external AI as a district privacy decision requiring documented approval, provider contract/data-processing review, retention/training controls and user notice. Add a configurable external-AI deny-by-default policy per district; expand redaction tests with realistic adversarial examples; consider a human review or local-only mode for sensitive workflows. Never describe this as guaranteed anonymization.

### P2 — No production-scale load or query-plan evidence

**Evidence:** The performance audit documents the remaining arrival reconciliation correlated lookups, offset pagination cost, DB/event-loop/GC observability gaps and the need for production-like benchmarks. The merged transport batching and HTTP latency histogram improve known hot paths, but the current CI suite does not establish district-scale p95/p99 under realistic concurrency.

**Recommendation:** Run the documented synthetic district matrix (1/10/50/100 schools; 8,500 students / 950 staff shape), capture EXPLAIN ANALYZE BUFFERS for arrival reconciliation and high-volume directories, and measure p50/p95/p99, DB pool wait, query count/time, event-loop delay, CPU/RSS/GC and concurrent attendance writes. Do not add speculative indexes or weaken RLS to improve speed.

### P2 — Queue metrics are implemented, but operational alerting is not proven

**Evidence:** `eduos_queue_backlog()` loops across districts and performs multiple queue aggregates per district. The API caches results for 15 seconds per process. The metrics expose queue state, oldest ready age and a read-health gauge, but no production Prometheus/Grafana/alert receiver or multi-replica load test was accessed.

**Recommendation:** Wire alerts for oldest ready webhook >300 seconds, notification >120 seconds, nonzero dead-letter/failed growth, and `eduos_queue_backlog_up=0`. Load-test the function with a large district count and queue volume. If it becomes expensive, replace per-district repeated aggregates with set-based aggregation or a bounded periodic snapshot. Account for one cache/query per API replica.

### P2 — Notification email/SMS/push are still not real delivery channels

**Evidence:** Release-gate documentation and configuration state that shipped adapters are only `off` and `log` dry-run modes. The UI and dispatcher correctly distinguish skipped/failed from delivered, but there is no production email/SMS/push sender in this repository state.

**Recommendation:** Before promising external notifications, integrate approved providers with signed/secret-managed credentials, provider delivery receipts, idempotency, retries, suppression/unsubscribe rules and tenant-safe logs. Keep emergency-services contact claims explicitly false unless a real integration is implemented and verified.

### P2 — Production deployment and physical-device validation remain external gates

**Evidence:** CI builds the Android debug APK but does not sign a production release or validate real devices. Documentation still requires real IdP issuer/redirect, public DNS/TLS, production secrets, backup/restore on production-sized data, edge hardware and scheduler/monitoring configuration.

**Recommendation:** Complete a district-specific production preflight, verify backup and restore with realistic data volume, exercise rolling restart/webhook recovery, test edge enrollment/update/health on target hardware, and conduct iOS/Android physical-device tests. Validate mobile release signing and store packaging separately.

## Priority execution order

1. Harden external AI provider URL/redirect/egress validation.
2. Finalize district external-AI privacy approval and policy controls.
3. Connect queue metrics to alerts; test metrics query at district scale.
4. Run repeatable performance/load and query-plan tests; add keyset pagination where measured.
5. Implement and certify real email/SMS/push senders only if required by product commitments.
6. Complete production environment, backup/restore, edge hardware and signed mobile release validation.

## Final assessment

The current main branch has a substantially stronger engineering baseline and a green seven-job CI run with real PostgreSQL integration, upgrade/restore drills, browser/CSP checks, edge checks and Android debug compilation. The earlier webhook lease, concurrency, Retry-After, IPv6, populated backfill and restore defects are addressed in main and covered by tests.

**Do not label this production-certified yet.** The most important code hardening still visible in the reviewed surface is external AI provider egress validation. The remaining release blockers are deployment, privacy approval, external messaging, scale and physical-device evidence—not a known failing CI suite.

No runtime code, migrations, secrets, production configuration or deployment settings were changed for this audit.
