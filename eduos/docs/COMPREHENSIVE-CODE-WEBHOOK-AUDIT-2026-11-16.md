# EduOS Comprehensive Source and Webhook Audit

- Audit date: 2026-11-16
- Repository: topking80/EDUOS-REPO-001
- Audited base: main at 13971c623bc072925d5a436d6d62f8d51d2d05ef
- Application version: 37.4.0
- Scope: repository inventory plus source review of backend entry/configuration, authentication/OIDC, authorization, PostgreSQL/RLS, flow events, webhook registration/delivery/outbox/dispatcher, external integrations, notification dispatch, migrations, CI, container composition and targeted tests.
- This is a source-level review. No production database, district secrets, live webhook receivers, physical mobile devices or production traffic were accessed.

## Executive result

No confirmed unauthenticated remote-code-execution or direct cross-district webhook read was established in this review. The implementation has meaningful defenses: OIDC issuer/subject validation and PKCE, CSRF/session checks, tenant transactions and forced RLS, a non-owner runtime DB role, HTTPS-only public-address webhook destinations, DNS answer validation and connection pinning, redirects disabled, HMAC signatures, bounded request/response sizes, durable outbox jobs, leases, retries, dead-lettering and a delivery ledger.

The webhook reliability controls have material gaps. The highest-priority finding is that the two-minute lease is applied to an entire sequentially processed batch of up to 25 jobs. The worst-case bounded delivery time for a batch can exceed the lease, allowing another worker to reclaim a job while the first worker is still processing earlier jobs. A second issue is that WEBHOOK_MAX_IN_FLIGHT is configured but the corresponding acquire/release helpers are never called, so it does not actually bound request-triggered dispatch concurrency.

## Findings

### P2 — Webhook batch lease can expire before later jobs start

**Files:** `eduos/src/webhook-outbox.js`, `eduos/src/webhooks.js`, `eduos/src/webhook-dispatch.js`

The worker claims up to 25 jobs and assigns each a two-minute lease, then iterates the claimed jobs sequentially. A single delivery can consume up to 3 seconds of DNS resolution and 5 seconds of HTTP timeout, before database work. Twenty-five worst-case deliveries can therefore exceed 200 seconds. Jobs near the end of the batch can expire before their send begins; a concurrent scheduler/API worker can reclaim them.

The stable delivery ID and lease-token settlement reduce damage, but do not prevent duplicate external POSTs in the at-least-once crash/lease-expiry window. Existing tests cover competing workers with 20ms sends and a manually expired lease; they do not simulate a slow first job followed by a later job whose lease expires before send.

**Recommended correction:** Claim just-in-time or claim a small batch sized from the maximum send duration; alternatively renew every remaining job immediately before send and skip if renewal fails. Ensure lease duration is greater than the hard send timeout plus margin. Add a PostgreSQL integration test with a deliberately slow first delivery, a second worker, and assertions that stale workers cannot cause concurrent duplicate sends. Retain receiver-side idempotency guidance.

### P2 — Configured webhook concurrency limit is not enforced

**Files:** `eduos/src/server.js`, `eduos/src/config.js`

`WEBHOOK_MAX_IN_FLIGHT` is validated and `acquireWebhookSlot()` / `releaseWebhookSlot()` are defined, but each helper appears only at its declaration; neither is called by the dispatch path. Request-triggered `processWebhookOutbox()` can therefore run concurrently across requests without the configured application-level bound. PostgreSQL SKIP LOCKED prevents two workers from initially claiming the same live row, but it does not cap aggregate DNS/HTTP sockets or worker pressure.

**Recommended correction:** Wrap every request-triggered outbox invocation in a bounded semaphore with guaranteed release in `finally`, or remove the misleading setting and implement a documented worker-level concurrency policy. Add a test that launches more simultaneous dispatch requests than the configured limit and verifies the maximum concurrent deliveries.

### P2 — Scheduled delivery requires external scheduling not supplied by Compose

**Files:** `eduos/src/webhook-dispatch.js`, `eduos/docker-compose.yml`

The scheduled dispatcher correctly provides a way to drain queues when districts have no API activity. However, the Compose `webhooks` service is an opt-in, one-shot `run --rm` job; it is not a continuously scheduled worker. Source comments require an external scheduler to invoke it every minute. If an operator only deploys the Compose stack and does not configure that scheduler, queued events and retries may remain pending until authenticated API activity triggers request-side dispatch.

**Recommended correction:** Make the scheduler an explicit production deployment prerequisite with a documented cron/Kubernetes/systemd example, least-privilege owner credentials, alerting on last successful run, oldest pending age, queue depth and dead-letter count. Include a release preflight that detects the missing scheduler configuration where deployment metadata is available. Do not silently claim webhook delivery is continuously active without that external schedule.

### P2 — HTTP 429 retry handling ignores Retry-After

**Files:** `eduos/src/webhooks.js`, `eduos/src/webhook-outbox.js`

HTTP 429 is classified as retryable, but the response headers are discarded by `deliverOnce()` and the worker uses its own exponential backoff. It cannot honor a receiver's `Retry-After` instruction. This can cause avoidable repeat requests and receiver throttling during sustained rate limiting.

**Recommended correction:** Capture a bounded, validated `Retry-After` value (seconds or HTTP date), persist the computed next-attempt time, and cap it to an operational maximum. Add tests for valid, invalid, past and excessively long values.

### P2 — Webhook signing-key rotation has no overlap/version mechanism

**Files:** `eduos/src/webhooks.js`, `eduos/src/config.js`, webhook subscription routes in `eduos/src/server.js`

Each subscription secret is deterministically derived from the single configured `WEBHOOK_SIGNING_KEY` and subscription ID. Changing the master key changes every receiver secret at once. The API returns a derived secret only at subscription creation; there is no versioned key identifier, overlap window, rotation endpoint or bulk re-provision workflow.

**Recommended correction:** Introduce a key ID and current/previous signing-key configuration with a bounded overlap period, expose an authenticated per-subscription rotate/reveal-once workflow, and document receiver cutover. Keep old key material out of logs and never return it from list endpoints. Add rotation tests proving old and new signatures work only during the configured overlap.

### P3 — SSRF destination filtering should cover the full IANA special-purpose IPv6 space

**Files:** `eduos/src/webhooks.js`, `eduos/test/phase33-flow-webhooks.test.js`

The IPv6 block list includes loopback, ULA, link-local, multicast, documentation, NAT64/local-use, 6to4 and other explicit ranges. It does not currently include the full `2001::/23` IANA special-purpose block (for example protocol-assignment ranges such as Teredo/ORCHID/benchmarking). The current tests cover many private and translated forms but not these special-purpose IPv6 ranges.

**Recommended correction:** Review the current IANA IPv6 Special-Purpose Address Registry and block non-globally-reachable special-purpose prefixes explicitly, with narrowly documented exceptions only where needed. Add regression cases for each blocked prefix and maintain a test fixture tied to the registry revision. This is a defense-in-depth gap; this audit did not demonstrate a path from these ranges to a specific internal service.

### P3 — Domain allowlisting is optional, so default policy permits any public HTTPS host

**Files:** `eduos/src/config.js`, `eduos/src/webhooks.js`, webhook registration routes

When `WEBHOOK_ALLOWED_HOSTS` is empty, any structurally valid hostname resolving exclusively to public addresses can be registered by a role with webhook-management permission. This is not an SSRF bypass—the private-address checks still apply—but it increases the impact of compromised or misused district webhook-admin credentials.

**Recommended correction:** For production districts handling student data, prefer an explicit egress host allowlist or an administrator-approved destination registry. Make the open-public-host behavior a conscious, documented policy choice and audit changes to the allowlist.

## Positive controls verified in source

- Webhook destinations reject embedded credentials, fragments, unsafe schemes, private/reserved addresses and unsafe low ports; HTTPS is required except explicitly enabled loopback development.
- DNS answers are checked as a set and the vetted address is pinned for the connection, reducing DNS rebinding risk.
- Redirects are not followed; webhook responses are bounded; network timeouts are applied.
- Payload signatures use HMAC-SHA256 with a timestamp and a five-minute default verification window; per-subscription secrets are derived rather than stored in the database.
- Flow-event input is allow-listed, rejects free text and unknown keys, and outbound payload shape is fixed. The payload omits actor user IDs and student names; subject-student linkage is retained separately for feed authorization.
- Event row and outbox rows are inserted in the same tenant transaction.
- Outbox claims use `FOR UPDATE SKIP LOCKED`, stable delivery IDs, lease tokens, retry/backoff, dead-lettering and automatic subscription disable after repeated failures.
- Delivery attempts have a uniqueness constraint to suppress duplicate ledger entries for a delivery/attempt pair.
- Scheduled dispatch scopes each job to a district RLS context and can drain without a live API request.
- Integration HTTP shares the destination validation/pinning code, disables redirects, bounds response size and timeout, and connector secrets use AES-256-GCM with connector/district associated data.
- Email/SMS/push adapters shipped in this repository are only `off` and `log`; the log adapter is a dry run and sends nothing. Do not describe those channels as live delivery.
- The safety workflow does not prove emergency services or first responders were contacted. Do not represent an in-app notice or webhook as an emergency dispatch integration.

## Broader code and release review

The repository tree contains 782 tracked files across backend, database migrations, web frontend, Flutter mobile, edge platform, tests, deployment files and documentation. Source review covered the production server/configuration, auth/OIDC, policy, database/RLS transaction layer, flow events, webhook delivery/outbox/dispatcher, integration routes/sync/HTTP/secrets, notification dispatcher, relevant migrations, Compose services and webhook-specific tests. Prior source review in this project also covered attendance/arrival handoff, transport, SIS, learning, safety, pickup, audit, EDAL, AI gateway and edge security components.

The CI workflow at the audited commit has seven jobs. All seven completed successfully in run 43870953838: unit, PostgreSQL integration, end-to-end, Flutter mobile, edge, dependency security, and source/container security. This is meaningful evidence, but CI does not substitute for a slow-delivery lease stress test, live receiver verification, production load testing, physical-device validation or a production deployment review.

The review is not a claim that every line of all 782 files has been manually proven correct. Generated assets, every UI component, all edge scripts and all route/data combinations require additional dedicated passes. The following should remain release gates:

1. Run the full route/role/school/district authorization matrix against PostgreSQL and validate expected status codes, not just response-body leakage markers.
2. Run migrations from an empty database and an upgrade copy; verify least-privilege runtime grants and RLS with the actual production roles.
3. Add slow-batch webhook lease, concurrency-cap, 429 Retry-After, key-rotation and IPv6 special-purpose address tests.
4. Verify the scheduled webhook job is installed and observable in each production environment.
5. Run representative multi-district load tests, PostgreSQL query-plan review and queue backlog/recovery tests.
6. Verify real external sender integrations separately before enabling any email/SMS/push adapter.
7. Perform physical iOS/Android device tests, including offline queue contention, session expiry, push permissions and app upgrade behavior.

## Change policy

This audit branch adds this report only. It does not change runtime code, migrations, credentials, production settings, merge state or deployments. Fixes should be made in separately reviewable commits with regression tests and CI.
