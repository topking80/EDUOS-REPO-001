# 32.0.21 — Optional session-validation cache (auth hot path)

## What changed
Every authenticated request runs one `SELECT … FROM sessions …` to validate the
session cookie before doing any work. Under load against a single hot session
(the shape the earlier soak/load tests used) that lookup is pure repetition.

32.0.21 adds an **opt-in, in-process cache** of validated sessions:

- `config.sessionCacheTtlMs` ← `SESSION_CACHE_TTL_MS` (default **0 = disabled**).
- When `> 0`, `requireSession` serves a session seen within the TTL from an
  in-memory map (keyed by the session token hash) instead of hitting the DB.
- The cache hands out an **isolated copy** of the actor, so per-request mutation
  (e.g. CSRF rotation setting `req.actor.csrfTokenHash`) never leaks across
  requests.
- Bounded at 5000 entries (oldest-out) so it cannot grow without limit.

## Why it is OFF by default (the revocation story)
Validating every request against the database is a deliberate security property:
a revoked or expired session is rejected on the very next request. Caching trades
that for a bounded staleness window, so the secure behavior stays the default and
an operator opts in explicitly.

The two in-process events that change a session's validity **evict immediately**,
so they are never served stale:
- **logout** — evicts the token hash right after writing `revoked_at`.
- **CSRF rotation** (`issueCsrfToken`) — evicts so the next request re-reads the
  rotated CSRF hash (prevents a stale hash rejecting the new token).

The only residual window is an **out-of-band** change — e.g. an admin revoking a
session row directly in the database, or the row crossing `expires_at` — which can
be served up to `SESSION_CACHE_TTL_MS` old. Choose the TTL to match the revocation
latency you accept (e.g. 5000 = ≤5s). **Single instance only:** one node's
eviction does not reach others, so keep this at 0 (or front it with a shared
store) in multi-node deployments.

## Tests
`test/phase33-session-cache.test.js` (6 new tests, suite now **130/130**):
- source audit: default is 0; both cache accessors hard-no-op at TTL 0; logout and
  CSRF rotation evict.
- behavioral (TTL enabled, stubbed pool, no DB):
  - 2nd request served from cache — **no** second DB lookup;
  - served actor is an isolated copy (tamper does not persist);
  - logout evicts → next request re-reads;
  - CSRF rotation evicts → next request re-reads (no stale CSRF hash);
  - entry past its TTL falls through to a fresh read.

## Measured effect (model, not a live DB run)
The live PG/OIDC stack from earlier turns was reclaimed on a worker restart, so
this is a deterministic hot-path model (`bench-session-cache.mjs`), **not** a live
load test. It isolates exactly what the cache removes — one session-lookup
round-trip per request — while keeping the tenant transaction (BEGIN/set_config/
query/COMMIT, ~4 round-trips) that every request pays regardless:

```
model: one hot session; 1 DB round-trip = 0.3ms
full read = session-lookup (1 rt, removable) + tenant transaction (4 rt, always)

cache OFF         ~657 req/s   20000 DB session-lookups
cache ON (warm)   ~824 req/s       1 DB session-lookup

DB round-trips/request: ~5 -> ~4   (20% fewer)
end-to-end throughput:  1.25x on hot authenticated read traffic
```

The ratio is structural (5 → 4 round-trips), so it holds regardless of per-round-
trip latency. This is a modest, honest gain on the DB-bound read path — not the
orders-of-magnitude figure an auth-step-in-isolation microbenchmark would show,
because the tenant transaction, not the session lookup, is the dominant cost.

## Unchanged
Default behavior (every request validates against the DB), all 15 artwork assets,
RLS/OIDC/CSRF/audit security model, and the "demonstration, not production
authorization" posture. No new runtime dependency.
