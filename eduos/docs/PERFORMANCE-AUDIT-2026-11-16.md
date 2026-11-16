# EdOS performance audit and optimization plan

**Audit date:** 2026-11-16  
**Repository:** `topking80/EDUOS-REPO-001`  
**Base commit:** `b192470f789ef62d31c919cdec285c12ad334697`  
**Branch:** `perf/district-workload-optimization`

## Scope and evidence

This is a source-level audit of the Node 22 / Express 5 / PostgreSQL service. No production database, live deployment, district traffic trace, or representative load-test environment was available during this pass. Consequently, this document records code-level hotspots and testable hypotheses, **not measured production bottlenecks**. No performance numbers are fabricated.

Reviewed:
- `eduos/package.json`
- `eduos/src/db.js`
- `eduos/src/server.js`
- `eduos/src/metrics.js`
- `eduos/src/paging.js`
- `eduos/src/arrival-routes.js`
- `eduos/src/transport-routes.js`
- `eduos/src/notify.js`
- `eduos/src/notify-dispatch.js`
- `eduos/src/webhook-outbox.js`
- `eduos/docker-compose.yml`
- `eduos/Dockerfile`

## Findings (ordered by likely impact)

### P1 — Transport read endpoints perform sequential N+1 queries

In `src/transport-routes.js`, `GET /api/transport/today` has two query-amplification patterns:

1. Driver and principal/superintendent branches iterate routes and call `routeDetail()`. That helper independently queries stops and today's run, then (when riders are requested) riders and latest check-ins. Query count therefore grows with the number of routes.
2. Teacher and family branches iterate each returned rider and issue another check-in query. Those queries are sequential, so response latency grows with roster size and round-trip latency.

**Implemented on this branch:** the teacher/family rider view now fetches all visible check-in events with one paired-array query and groups them by (run_id, student_id). The tenant transaction and original teacher-roster / guardian-child scope remain unchanged, and the event response shape/order is preserved. A pure grouping helper and unit tests were added. **Also implemented on this branch:** driver, principal/superintendent, and route-management views now hydrate stops, today's runs, riders, and latest check-ins in a fixed set of batched queries instead of querying each route separately. Existing route order, rider ordering, counts, role-scoped route selection, tenant transaction, and response fields are retained. Full PostgreSQL integration and query-count tests remain outstanding.

### P1 — Arrival reconciliation has correlated per-rider subqueries

`GET /api/arrival/reconciliation` computes handoff count and attendance existence for each assigned rider and uses LATERAL lookups for the latest check-in and handoff. PostgreSQL may execute these as indexed nested loops; without confirming the actual plan and indexes, their cost at 3,000 riders is unknown.

**Recommended fix:** capture `EXPLAIN (ANALYZE, BUFFERS)` on anonymized production-like data; verify composite indexes match district, route/run, student, event date, and ordering predicates. Compare a pre-aggregated CTE/window plan before changing SQL. Do not add speculative indexes without plan evidence and write-cost review.

### P1 — Notification dispatcher holds database locks while invoking adapters

`src/notify-dispatch.js` selects pending rows `FOR UPDATE SKIP LOCKED`, then invokes each adapter before committing. Current shipped adapters are only `off` and `log` (dry-run), so no external network call currently occurs. If real email/SMS/push adapters are introduced, the current transaction shape would hold row locks and a connection during provider latency.

**Recommended fix before enabling a network adapter:** claim a bounded batch with a lease token and commit; send outside the transaction; settle each row in a short transaction conditioned on the lease token. Preserve tenant context, bounded attempts, retry backoff, idempotency and a dead-letter path. Add multi-worker and lease-expiry tests.

### P2 — Offset pagination may become expensive for deep pages

`src/paging.js` uses `LIMIT/OFFSET`. This is straightforward and safe, but PostgreSQL still walks skipped rows on deep offsets.

**Recommended fix:** retain the current API for compatibility; introduce cursor/keyset pagination for high-volume directories and event feeds using stable indexed ordering (e.g. name + id or timestamp + id). Keep authorization predicates inside every page query.

### P2 — Current HTTP metrics do not expose latency distributions

`src/metrics.js` records request count and cumulative duration by method, route template and status class, plus in-flight requests, RSS and pool counts. This is useful for totals but cannot calculate p50/p95/p99 from the exported series.

**Recommended fix:** add bounded latency histogram buckets (or OpenTelemetry histograms) and metrics for event-loop delay, CPU, heap, GC, DB query latency, pool acquisition wait, and background queue age. Continue using route templates, never raw URLs or student identifiers. Keep labels bounded and metrics endpoint authenticated.

### P2 — Database pool configuration needs workload-based tuning

`src/db.js` defaults `DATABASE_POOL_MAX` to 20 per process and exposes total/idle/waiting counts. This is a reasonable default, not a measured optimum. Multiplying this by API replicas and worker processes can exceed PostgreSQL connection capacity.

**Recommended fix:** size the total connection budget across all app/worker replicas; alert on pool wait time and saturation; test connection churn and DB failover. Avoid raising pool size without PostgreSQL capacity evidence.

## Non-negotiable constraints

- All tenant-owned reads and writes remain inside `withTenantTransaction`.
- Never weaken PostgreSQL RLS, role checks, school scope, or guardian/teacher roster restrictions for speed.
- Safety and attendance writes remain synchronous, auditable, and idempotent.
- Emergency paths must not queue behind analytics or AI workloads.
- No student identifiers, prompts, notification content, or raw request URLs in telemetry.
- Preserve webhook lease-token behavior and at-least-once delivery semantics.

## Benchmark plan

Run on a disposable PostgreSQL instance with synthetic, non-identifying data at 1, 10, 50 and 100 school sizes (including 8,500-student / 950-staff district shape). Record:

- p50/p95/p99 API latency and throughput by route;
- SQL query count and cumulative DB time per request;
- pool wait time, active/idle/waiting connections;
- CPU, RSS, heap, event-loop delay and GC pauses;
- transport roster response time at 50/500/2,000 riders;
- arrival reconciliation time at 500/1,500/3,000 riders;
- notification dispatch throughput and oldest pending age;
- attendance write correctness and duplicate/idempotency behavior under concurrency.

Use warm-up plus repeated runs, report medians and confidence intervals, and compare identical data, hardware, and concurrency. Set provisional release gates: p95 <300 ms for ordinary API reads, p95 <500 ms for attendance submission, and no cross-tenant data exposure or correctness regression. Treat these as targets, not current measurements.

## Implementation sequence

1. Complete driver/principal route hydration batching and add response/query-count regression tests.
2. Inspect PostgreSQL plans and migration indexes for transport/arrival paths; add only plan-validated indexes.
3. ~~Refactor notification dispatch to claim/send/settle leases before any real external adapter is enabled.~~ Done on main (#35, #38).
4. Add histogram and DB/event-loop metrics with bounded labels. (HTTP latency histogram implemented; DB/event-loop metrics remain.)
5. Add keyset pagination to the largest high-volume feeds while retaining offset compatibility.
6. Run full unit, PostgreSQL integration, security regression, and load suites; publish before/after results.

## Status

- [x] Source-level audit started on a dedicated branch.
- [ ] Production-like baseline load test.
- [x] Teacher/family transport check-in N+1 reduced to one batched query; grouping unit tests.
- [x] Driver/principal/vice-principal/superintendent route hydration moved to batched child queries.
- [x] PostgreSQL query-count verification: `test/integration/transport-batching.test.js` (one route and six routes take the same 4 queries; per-route stops, runs, riders and counts unchanged, same stop shape).
- [x] Full unit and PostgreSQL integration suites on the branch, after merging current main.
- [ ] Query-plan/index validation.
- [x] Notification worker lease refactor (on main: claim, send with nothing open, settle under the lease; #35, #38).
- [x] Bounded HTTP latency histogram (route template, method, status class; no raw URLs), with metric families kept contiguous in the text format.
- [ ] DB query latency, pool acquisition wait, event-loop delay, CPU/heap/GC metrics.
- [ ] Load verification.
