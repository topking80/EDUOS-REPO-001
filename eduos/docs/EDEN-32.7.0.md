# EDEN, the aggregation gate, offline school nodes and DECN (32.7.0)

Deck pages 18-23. This file describes how it works and what it does **not**
yet prove. For operator steps see `docs/UPGRADING-32.7.0.md`.

## 1. Tiers and trust

```
root (offline authority) ── district hub (the existing EduOS server) ── school node ── phones / edge devices
```

- **One trust root.** `src/eden/authority-cli.js` makes the root key and
  signs district certificates. Keep the root key offline. The edge
  platform's Python authority client (`edge-platform/eduos/authority/`) is
  still a stub. This CLI is the working authority in 32.7.0.
- **Certificates** use a small JSON format (EDEN-CERT-1): canonical JSON
  signed with Ed25519. They carry an Ed25519 signing key and an X25519 sealing
  key. They are **not X.509**.
- **Signed node identity, not mutual TLS.** The brief allowed either; 32.7.0
  uses signed identity. Every node-to-hub request is signed by the node key
  over `EDEN1\nMETHOD\nPATH\nTIMESTAMP\nNONCE\nsha256(body)`. The hub accepts
  a request only if all of these hold:
  - the node's certificate chains to the pinned root;
  - the certificate is not revoked;
  - the timestamp is within ±5 minutes;
  - the nonce has not been used before (replays are refused).

  Transport encryption is TLS in production: `EDEN_HUB_URL` must be `https://`
  when `NODE_ENV=production`. **The local docker simulation uses plain HTTP**
  between containers. The signatures still apply there.
- **Enrollment.**
  1. District IT creates a one-time token on the hub's Nodes screen. It is
     valid for 24 hours and bound to one school.
  2. The node generates its own keys and proves it holds them
     (proof-of-possession over the token hash and its sealing key).
  3. The hub issues a node certificate for that school only.
  4. The node checks the certificate chains to its **pinned** root and names
     its own keys and school. If not, it refuses.
- Nodes only ever connect **outbound** to the hub.

## 2. What syncs

| Direction | What | Protection |
|---|---|---|
| down | app catalog and licences, branding, approved lessons, library content, revocations | Versioned bundles (EDEN-BUNDLE-1), signed by the district or root key. The node verifies them, refuses version rollback, and caches them (`eden_bundle_cache`). |
| up | aggregate count tables, node health | The aggregation gate, at the node's single egress point and again at the hub (§3). |
| node → hub → partner node | DECN continuity package | Sealed to the partner node's X25519 key (EDEN-SEAL-1: ephemeral X25519 + HKDF + AES-256-GCM), signed by the sender. The hub stores **ciphertext only** and has no key to open it. |

Caching at each tier: the hub keeps the latest aggregates per node, kind and
period, plus all published bundles. A node keeps its verified bundles and its
outbox. Phones keep the app shell only (§5).

## 3. The aggregation gate (`src/eden/aggregation-gate.js`)

- It is a **pure** module: no I/O.
- All egress goes through `src/eden/egress.js`. A unit test fails if any
  other file signs requests or calls the hub.
- Before anything leaves the node, `verifyReleased()` runs again on the exact
  bytes, with a fresh identifier index (the node's student ids, numbers,
  names and family names).
- The hub runs `verifyReleased()` again on arrival and checks the payload's
  school against the node certificate.

Rules:
- **Only allowlisted kinds:** enrollment_by_grade, attendance_daily,
  mastery_by_standard, transport_checkins_daily, gradebook_distribution,
  safety_summary and node_health. Dimensions and values are allowlisted too.
- **Counts only:** no means, rates or percentages.
- **Minimum cell size 5:** counts from 1 to 4 are suppressed.
- **Small margins:** a row or column whose total is under 5 is suppressed
  whole, including its zeros. A table whose total is under 5 is suppressed
  entirely.
- **Complementary suppression, verified with linear algebra.** For each
  suppressed cell the gate checks whether its value is uniquely determined by
  the published cells and margins (rank test). If it is, the gate suppresses
  more cells until none can be recovered exactly.
- **Identifier deep scan:** any string anywhere in the payload that matches a
  student id, local number, display name or family name blocks the release.
- **safety_summary** carries counts only. `allAccounted` is computed by the
  gate and never taken from the caller.

Consent-gated exceptions (a record transfer for one learner, for example to a
new school):
- They are **off by default** (`EDEN_CONSENT_EXCEPTIONS=on` to enable).
- Each one needs a consent reference and a superintendent's approval, and is
  single-use and audited.
- When the setting is off, a send attempt returns 403 and writes a `blocked`
  line in the egress log.

Tests that try to leak data:
- `test/eden-gate-32700.test.js` (20 tests) covers small cells, subtraction
  attacks through margins, two suppressed cells in one row, zeros next to
  small totals, names hidden in labels or nested fields, unknown kinds, extra
  fields, rates, and tampering after release.
- `test/integration/eden-decn.test.js` sends forged, unsigned, replayed,
  non-gate, small-cell and wrong-school messages to a real hub. All are
  refused and logged.

Residual risks (documented, not solved):
- **Interval inference:** a suppressed cell is known to lie between 1 and 4,
  or within bounds set by its margins.
- **Differencing across releases or tables:** comparing yesterday's and
  today's tables, or two tables with shared margins, can narrow a value. The
  gate checks one table at a time.
- **Mitigations in place:** a fixed small set of tables, counts only, and a
  versioned supersede so a period has one current table.
- **Not built:** cross-release tracking and noise-based (differential
  privacy) release.
- **District→state export is not built in 32.7.0.** When it is, it must go
  through this same gate. The hub has no state uplink today.

## 4. The school node, offline

A school node is a full EduOS server for one school, set with
`EDUOS_NODE_TIER=school`. Its database holds that school only
(`node-provision.js`, which runs the owner-only `eduos_node_prune_to_school()`).
When the district uplink is down, everything on the node keeps working,
because nothing in a school workflow calls the district:
- attendance;
- bus check-ins;
- SafetyOS incidents and roll call;
- pick-up verification and release;
- Christie (local provider);
- gradebook and learning reads.

The agent loop retries with backoff, and aggregates wait in the outbox. A
stale table for a period is superseded by the newer one, not sent twice.

Writes and conflicts:
- Writes made while a phone was offline are replayed with `Idempotency-Key`
  and `X-EduOS-Queued-At`. A receipt (`offline_replays`) is claimed inside the
  write's own transaction, so a replay returns the first result and never
  writes twice.
- The queued-at time may be at most 2 minutes in the future and at most
  24 hours old. It is stored as `observed_at`.
- "Latest" status is ordered by `coalesce(observed_at, recorded_at)`, so an
  older observation replayed late never overrides a newer one.
- **SafetyOS and append-only logs merge; they never overwrite.** Roll-call
  entries, check-ins, attendance events, safety events and pick-up events are
  inserts only.
- A late roll call for an incident that has since closed is still accepted
  if it was observed while the incident was live. No family notification is
  sent for it.
- During failover, the hosted school's records are merged back into its own
  node with insert-only `ON CONFLICT DO NOTHING`.

Sign-in during an outage:
- New sign-ins need the district identity provider (OIDC). Staff who are
  already signed in keep working.
- The node profile sets an 8-hour idle timeout (`SESSION_IDLE_MINUTES=480`).
- A local identity provider for schools is not built in 32.7.0.

## 5. What a phone keeps (the "lost phone" question)

| Stored on the phone | Where | Contents | Lifetime |
|---|---|---|---|
| App shell | Service worker cache `eduos-app-shell-32.7.0` | `/app/` HTML, CSS, JS, icons, manifest. No school data. | Until the next version |
| Branding (desktop site only) | `localStorage` key of `eduos-branding.js` | The school's public branding key / version for icons | Until cleared |
| Offline write queue | IndexedDB `eduos-offline-queue` | Up to **200** roll-call, bus check-in or attendance marks, **AES-GCM encrypted** with a key generated in the browser as **non-extractable** | **24 hours** at most. Deleted on sign-out, on a 401, and when another account signs in. |

Never stored:
- `/api/` or `/auth/` responses (the service worker is network-only for
  them);
- names, rosters, grades, messages and pick-up passes.

Pick-up release is **online only**, because the adult's identity must be
checked live.

Honest limit: the key is non-extractable, so script cannot read or export it.
But someone holding an **unlocked** phone with the app open can still use the
app, and so can queue entries. Device lock and MDM remain the district's
controls. A lost **locked** phone holds ciphertext and the app shell.

## 6. DECN: a partner covers a failed school

1. **Pairing.** The district sets a partner for each school on the Nodes
   screen.
2. **Continuity package.** Each node seals a **minimum** package to its
   partner: learners (name, number, grade), staff (principal, teachers,
   drivers), rosters, bus routes, stops and riders, approved pick-up adults,
   live pick-up pass hashes and pick-up restrictions. It is refreshed hourly
   or when it changes, and the hub stores ciphertext only. It excludes:
   - grades, cases, messages and health data;
   - parent accounts. No family notifications go out during a failover.
3. **Authorization.** Only a superintendent can authorize a failover. IT and
   principals get 403. All of these are required:
   - the failed node has been silent for longer than
     `EDEN_NODE_OFFLINE_AFTER_SECONDS` (default 90), which avoids split brain;
   - the partner is online;
   - a package exists;
   - a reason of at least 10 characters;
   - at most `EDEN_FAILOVER_MAX_HOURS` (default 24, max 72).

   Only one failover can be open per school. Every step is an append-only
   `eden_failover_events` row plus an audit event.
4. **Hosting.** The partner opens the package and restores the minimum data.
   - The school's own staff sign in at the partner with their normal district
     sign-in.
   - A session guard limits them to SafetyOS, pick-up, transport, attendance,
     students, branding and their account. Everything else returns
     `403 not_available_during_failover`.
   - Hosting stops at expiry.
5. **Automatic handback.** When the failed node's heartbeat returns, the hub
   starts handback on its own. The superintendent can also end a failover
   early. Then:
   1. The partner seals everything recorded while hosting back to the school
      node: attendance, check-ins, roll call, safety and pick-up events.
   2. The partner **purges** its copy: it revokes the sessions, purges the
      learners, deletes the school's rows, and deletes the staff accounts it
      created (or disables them where its own audit trail refers to them).
   3. The school node imports the records insert-only, and the hub closes the
      failover.

## 7. Simulated vs proven

**Proven in this build:**
- **Code paths:** all unit and PostgreSQL integration tests pass (see the fix
  report). The integration test runs a real hub and two real nodes as
  separate processes on separate databases. It covers enrollment, signature
  and replay rejection, gate refusals, a partition (hub stopped), idempotent
  replay, failover rules, hosting, handback, purge and merge.
- **Local container simulation** (`make eden-sim`, `dev/eden-smoke.mjs`):
  - the dev stack's API is the district hub;
  - two school-node containers run against one PostgreSQL container that has
    a separate database and roles per node;
  - phones are headless Chrome at phone size;
  - a partition is `docker network disconnect` of the node's "WAN";
  - a node failure is `docker stop`;
  - axe found 0 violations on every screen.

**Not proven:**
- Raspberry Pi 5 or any arm64 hardware. No arm64 image was built: this build
  host has no buildx or QEMU. The image has no architecture-specific parts.
- Real WAN links, latency or flapping networks over days.
- TLS between tiers in the simulation.
- One PostgreSQL server per school in the simulation (it shares one container
  to save memory).
- The Quadlet / Butane school-node units on real Fedora CoreOS. They compile
  under `butane --strict` (`make check`) but have not been booted.
- State or root tiers above the district.
- The hub still holds the full demo district (the dev stack is a classic
  single server and a hub at once). A production hub would be fed by
  aggregates only.
