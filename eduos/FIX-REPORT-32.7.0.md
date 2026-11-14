# EduOS 32.7.0: offline school nodes, the aggregation gate, EDEN and DECN

What was asked (deck p18-p23):
- a Pi 5-friendly local school node that keeps the core apps working when
  the uplink is down, with queued writes and conflict rules ("SafetyOS and
  append-only logs merge; they never overwrite") and safe-only phone caching;
- an aggregation gate (minimum cell size 5, complementary suppression),
  enforced in code at the egress point and tested by attempts to leak;
  consent-gated exceptions explicit, audited and off by default;
- EDEN (root → district → school → edge) with signed node identity under one
  trust root, signed versioned sync and per-tier caching;
- DECN: a partner takes over a failed school with minimum data,
  time-bounded, audited, district-authorized, with automatic handback;
- an admin/IT screen and partition tests.

Design, cached-data table and residual risks: **`docs/EDEN-32.7.0.md`**.
Operator steps: `docs/UPGRADING-32.7.0.md`.

## Honesty first: simulated vs proven
- **Signed node identity, not mTLS.** Certificates are Ed25519-signed JSON
  (EDEN-CERT-1, not X.509). Every request is signed and replay-protected. TLS
  is required for the hub URL in production; the docker simulation is plain
  HTTP between containers.
- **Raspberry Pi 5: not tested.** No arm64 image was built: this host has no
  buildx or QEMU. The image has no architecture-specific parts and the memory
  caps fit a 4-8 GB board, but Pi support is a plan until a pilot.
- **Multi-node results come from local containers on one x86_64 machine:**
  - one PostgreSQL container hosts both nodes' databases (separate DBs and
    roles);
  - a partition is `docker network disconnect`;
  - a failure is `docker stop`.

  Real WAN links, flapping networks and long outages are not proven.
- The school-node **Quadlet/Butane** units pass `make check` (butane
  `--strict`) but have not been booted on Fedora CoreOS.
- The trust root is `src/eden/authority-cli.js`. The edge platform's Python
  authority client is still a stub.
- The dev hub still holds the full demo district, because it is also the
  classic server. There is **no district→state export** yet; when it comes it
  must use the same gate.
- Gate residual risks: interval inference and differencing across releases
  or tables (documented; noise-based release is not built).
- New sign-ins need the district IdP. During an outage, signed-in staff keep
  working (8-hour idle timeout on nodes).

Hard rules kept:
- No student-level data leaves a school except a continuity package sealed
  to the partner node. The hub stores ciphertext and cannot open it.
- No GPS or location, no facial recognition, no threat scoring or profiling.
- No external AI calls; email, SMS and push stay off. No family
  notifications during failover.
- No new messaging paths.
- RLS (FORCE plus restrictive policies on all new tables), OIDC, CSRF, audit,
  FERPA purge (DECN purge reuses `eduos_purge_student`), rate limits, and axe
  at 0 violations.

## 1. Aggregation gate (`src/eden/aggregation-gate.js`, pure)
- **Scope:**
  - allowlisted count tables only (enrollment, attendance, mastery, bus
    check-ins, gradebook distribution, safety summary) plus node health;
  - dimensions and values are allowlisted;
  - counts only: no means or rates.
- **Suppression:**
  - counts from 1 to 4 are suppressed;
  - a row or column whose total is under 5 is suppressed whole, zeros
    included;
  - **complementary suppression** is verified with a rank test, so no
    suppressed cell can be solved from the published cells and margins;
  - an empty table is released as no cells.
- **Identifier scan:** a deep scan for student ids, numbers, names and family
  names blocks the release.
- **Single egress point:** `src/eden/egress.js` re-verifies the exact bytes
  before they leave, with fresh identifiers, and checks the sha against
  tampering. A static test fails if any other module signs requests or calls
  the hub.
- **At the hub:** it re-verifies on arrival and checks the school against the
  node certificate. Refusals land in `eden_inbound_log`.
- **Consent exceptions (`consented_record_transfer`):**
  - `EDEN_CONSENT_EXCEPTIONS=off` by default;
  - a request needs a consent reference and superintendent approval;
  - each one is single-use and audited;
  - a send attempt while the setting is off returns 403 plus a `blocked`
    egress log line.

## 2. EDEN
- **Authority CLI:** `init`, `issue-district`, `env`, `sign-bundle`, `verify`
  and `dev-init`. The root key is mode 600 and meant to be kept offline.
- **Enrollment:**
  - a one-time token (24 hours, one school);
  - the node proves it holds its keys;
  - the hub issues a node certificate;
  - the node verifies the chain to its **pinned** root, its own keys and its
    school.
- **Signed requests:** `X-Eden-Node`, `Timestamp`, `Nonce` and `Signature`,
  with ±5 min skew and a nonce table. Revocation serials travel in heartbeat
  directives.
- **Down:** signed, versioned bundles (catalog and licences, branding,
  approved lessons, content, revocations). The node refuses rollback and
  caches them.
- **Up:** gated aggregates through an outbox with versioned supersede.
- **Caching:** the hub keeps the latest table per node, kind and period, and
  all bundles. The node keeps its bundle cache and outbox.
- **Tiers:** `EDUOS_NODE_TIER=district` or `school`. Nodes only connect
  outbound.

## 3. School node and offline
- **Node profiles:**
  - `deploy/school-node/` (compose; caps of 384 + 192 + 64 MB; read-only app
    container, no capabilities);
  - Quadlet units plus `butane/school-node.bu`.
  - The Dockerfile pre-creates `/var/lib/eduos-node`, the identity volume.
- **`src/eden/node-provision.js`:** keeps one school, using the owner-only
  `eduos_node_prune_to_school()`. The demo seed and synthetic learners are
  refused in production.
- **Offline replay:**
  - `Idempotency-Key` plus `X-EduOS-Queued-At` (at most 2 min in the future,
    at most 24 h old);
  - the receipt is claimed in the same transaction as the write;
  - "latest" is ordered by observed time;
  - late roll calls for an incident that has since closed are accepted (no
    notification).
- **Phone queue:**
  - IndexedDB, AES-GCM with a **non-extractable** key;
  - at most 200 entries, 24 h TTL;
  - cleared on sign-out, on a 401 and when the account changes;
  - allowlist: roll call, bus check-ins, attendance. Pick-up stays
    online-only.
  - The SW cache is `eduos-app-shell-32.7.0`, still shell only.
  - Found and fixed during the sim: a write made offline before any CSRF
    token was cached now queues instead of failing.

## 4. DECN
- **Package:** a minimum continuity package (learners, staff, rosters,
  routes, stops, riders, approved pick-up adults, live pass hashes,
  restrictions), sealed EDEN-SEAL-1 to the partner. It is refreshed hourly or
  on change.
- **Authorization:**
  - superintendent only (IT and principals get 403);
  - the failed node must be silent for longer than the offline threshold and
    the partner must be online;
  - a package must exist;
  - a reason of 10+ characters and at most 24 h (configurable up to 72);
  - one open failover per school.
- **Hosting:**
  - the restore re-enables or creates the school's staff memberships on the
    partner;
  - a session guard allows SafetyOS, pick-up, transport, attendance,
    students, branding and account only (`403 not_available_during_failover`);
  - hosting ends at expiry.
- **Handback:** automatic on the origin's heartbeat, or **End** early. The
  partner seals the return package, then purges its copy (sessions revoked,
  learners purged, rows deleted, created staff deleted or disabled for audit).
  The origin imports insert-only, and the hub closes the failover. Every step
  is in append-only `eden_failover_events` plus audit.

## 5. Screens (`/app/`)
- **Hub Nodes tab** (superintendent and district IT):
  - node health, partners, failover in progress and history;
  - Authorize failover (superintendent only);
  - enrollment tokens, signed updates, and the inbound log ("What schools
    sent").
- **School node screen** (principal):
  - uplink banner and **Sync now**;
  - outbox, partner and continuity status, bundles;
  - "Covering for another school";
  - egress log ("What left this school");
  - device memory against the container limit.
- **Overview cards:** "School node connected / District link is down", and
  "Covering from a partner school" for hosted staff.

## Results
- **Unit tests:** 375/375. New: 21 gate leak/suppression tests, 11
  crypto/egress/migration tests, 6 offline-queue/deploy tests.
- **PostgreSQL integration:** 81/81, including 6 new EDEN tests in
  `test/integration/eden-decn.test.js` with a hub and two nodes as separate
  processes and databases:
  - enrollment and token reuse;
  - aggregates with no names or ids anywhere in the hub's EDEN tables;
  - forged, unsigned, replayed, non-gate, small-cell and wrong-school
    messages refused;
  - bundles, and consent off by default;
  - partition with the hub stopped: local writes, idempotent replay, an
    older replay not winning, out-of-window replay refused, outbox drained
    after heal;
  - DECN rules, ciphertext-only package, hosting, blocked paths, automatic
    handback, purge to 0 and append-only merge.
- `/ready` reports 15 migrations.
- **Fresh stack** (`make down-volumes && make up`), then `make smoke-browser`:
  39/39 HTTP smoke, 34/34 desktop, 12/12 mobile, 20/20 SafetyOS and 18/18
  learning phone steps, with axe at 0 violations on 102 scans.
- **`make eden-sim`:** 10/10 steps, axe at 0 violations on 10 screens, 0 page
  errors. Steps: enrollment, gated aggregates, phone offline queue
  (ciphertext verified in IndexedDB), partition via `docker network
  disconnect`, heal, partners, `docker stop` failure and authorized failover,
  hosted principal on the partner, automatic handback with purge and import.
- **Memory** (docker stats during the sim): node A 33 MiB, node B 39 MiB,
  eden-db 89 MiB (caps 192 MiB each). Only three extra containers ran.
- `make check` (edge platform): all roles OK, including the new
  `school-node`.
