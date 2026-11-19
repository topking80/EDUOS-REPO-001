# School-Node Local-First Reliability — Readiness and Verification Plan

**PR queue item:** 1 — Local-first edge reliability  
**Repository baseline:** `main` at `f11d119aed96453d18b953f88e1a0edac7af9e82`  
**Scope:** Audit and release gates for one-school EDEN nodes, offline phone queues, synchronization, and disaster continuity.

## Executive finding

EduOS already contains a substantial local-first implementation. This work must harden and prove that implementation rather than create a parallel edge architecture.

**Current disposition: PARTIAL — software architecture and simulation are present; physical hardware and production-site readiness are not yet proven.**

Two important limits must be explicit:

1. The school-node deployment documentation says Raspberry Pi 5 hardware has not been tested and no arm64 image was built in the documented release. Pi support remains a target profile, not a verified deployment claim.
2. During an uplink outage, staff who already have a valid local session can continue supported school workflows. New sign-ins still require the district identity provider; a local identity provider is not built. Do not add an independent school authentication authority as a shortcut around district identity and revocation controls.

## Existing implementation evidence inspected

| Area | Repository evidence | What the evidence supports | Remaining proof |
|---|---|---|---|
| One-school node | `src/eden/node-provision.js`, `src/eden/node.js`, `deploy/school-node/compose.yml`, Quadlet/Butane assets | Provisioning and runtime are designed for one school's local database and apps | Install/upgrade/restore on target hardware |
| Signed node identity | `src/eden/crypto.js`, `src/eden/runtime.js`, `src/eden/node.js`, `src/eden/hub.js` | Ed25519-signed requests, pinned-root certificate validation, timestamp and nonce replay checks, outbound node connections | Production TLS, key rotation/revocation drills, certificate recovery |
| Downstream sync | `src/eden/node.js`, `src/eden/crypto.js` | District-signed versioned bundles, signature verification, version rollback refusal and local cache | Interrupted download, corrupt cache, rollback and recovery under real storage pressure |
| Upstream egress | `src/eden/egress.js`, `src/eden/aggregation-gate.js` | Single egress point, allowlisted aggregate kinds, minimum-cell and complementary suppression checks, identifier scan, re-verification at send | Operational review of repeated releases and differencing risk; current docs say cross-release/noise protection is not built |
| Offline writes | `public/app/app.js`, `public/app/sw.js`, `src/offline-replay.js` | Shell-only cache; encrypted, non-extractable-key queue; allowlisted roll-call, bus check-in and attendance writes; 200-item/24-hour limits; identity ownership; idempotency and observed-time bounds | Real device/browser matrix, storage eviction, browser restart, clock skew, lost-device and MDM drills |
| Flutter queue | `mobile/flutter/lib/core/offline_queue.dart` | Queue ownership is bound to server and membership tuple; tests protect this invariant | Full Flutter device-level offline/replay journey and encrypted-storage review on supported devices |
| Partition/recovery | `test/integration/eden-decn.test.js` | Multi-process hub and two-node scenario exercises partition, local writes, resync, replay ordering, failover, handback, merge and purge | Repeat on physical nodes over a real network with power loss and router failure |
| Degraded identity | `docs/EDEN-32.7.0.md` | Existing authenticated sessions continue; new OIDC sign-ins need district identity provider | District-approved offline authentication policy, if new sign-in during outage is a requirement |
| Hardware profile | `deploy/school-node/README.md` | Compose and Quadlet deployment paths and memory limits are documented | Pi 5 / arm64 build, thermal/storage/power/network soak, peripherals, measured load and recovery |

## District-governance decision

**Approved direction:** continue using the district-issued node identity and certificates; preserve the school node's one-school database; keep cross-node transfer on the EDEN trust path; keep the aggregation gate as the only aggregate egress path; and retain the current narrow offline-write allowlist.

**Not approved:** introducing a separate local school identity provider, accepting self-asserted local roles, bypassing district revocation, widening the phone cache to rosters/grades/messages/pick-up passes, or sending student-level records through the aggregate channel.

If the district later requires new sign-in during a WAN outage, design a separate proposal for district-issued, short-lived, device-bound offline credentials with explicit expiry, role/school scope, revocation semantics, audit, and recovery. It must be reviewed under the District Governance Feature Acceptance Baseline before implementation. This readiness plan does not authorize it.

## Required work and acceptance gates

### 1. Production deployment and hardware

- Build and inspect both amd64 and arm64 images; record image digests and SBOM/provenance.
- Run database migration and one-school provisioning on a clean target device.
- Verify secrets and node identity files have restrictive permissions and are not baked into images or logs.
- Test supported storage media, disk-full behavior, read-only filesystem behavior, database restart, and power interruption.
- Measure CPU, memory, temperature, disk I/O, and database growth at idle and under representative school load.
- Run a minimum 72-hour soak with uplink available, unavailable, and flapping.
- Test backup, restore to replacement hardware, node re-enrollment, certificate revocation, and safe decommission/purge.
- Record exact hardware, OS, firmware, image digest, software version, and test results. No generic claim of "Pi supported" without this evidence.

### 2. Network and synchronization fault matrix

| Fault | Required behavior | Evidence required |
|---|---|---|
| Hub unavailable at startup | Local apps start; agent reports offline and retries with bounded backoff | Automated test and operator-visible status |
| WAN drops during write | Local transaction commits; no dependency on hub | HTTP/database integration test |
| WAN flaps during upload | No duplicate aggregate or partial release; retry is safe | Multi-process test and outbox inspection |
| Duplicate/replayed request | Reject replay or return original idempotent result; never double-write | Runtime-role PostgreSQL test |
| Clock skew | Reject timestamps outside documented limits; preserve valid observed-time ordering | Boundary tests |
| Corrupt/tampered bundle | Reject; keep last verified bundle; alert operator | Tamper test |
| Revoked node certificate | Hub rejects node; no new data egress | Revocation integration test |
| Database restart/power loss | Recover committed data and queue state; no silent loss | Physical power-cut test |
| Disk full | Fail safely, alert, preserve database integrity; no false "synced" status | Fault-injection test |
| Long outage then recovery | Bounded catch-up, observable backlog, no unbounded burst | Load/soak test |
| Duplicate phone replay | Same user and idempotency key cannot create duplicate event | Real PostgreSQL integration test |
| Another user signs in | Previous user's queued writes are not replayed under new identity | Browser and Flutter tests |

### 3. Local identity and session boundary

- Preserve the current rule: already authenticated users can use supported local workflows during an uplink outage.
- New authentication must fail closed when the configured district identity provider is unavailable; never silently downgrade to a local password or unverified identity.
- Show a clear operator/user state that distinguishes "existing session available" from "new sign-in unavailable".
- Verify session idle expiry, logout queue deletion, account switching, and district session revocation behavior.
- Do not claim full offline sign-in until an approved offline credential protocol is designed, implemented, and independently tested.

### 4. Data minimization and egress

- Keep the phone cache limited to the documented app shell and approved encrypted queue.
- Do not cache API/auth responses, rosters, grades, messages, private notes, or pickup-release credentials in the service worker.
- Re-check the identifier block-list immediately before egress.
- Keep only allowlisted count aggregates on the normal node-to-hub path.
- Keep consent-gated record transfer disabled by default and require a single-use consent reference plus superintendent approval.
- Document the known aggregate differencing/interval-inference residual risks; do not describe the gate as differential privacy.

### 5. Failover / DECN

- Verify superintendent-only authorization, partner health, offline threshold, bounded duration, and single active failover.
- Verify the partner receives only the sealed minimum continuity package and cannot read hub-stored ciphertext.
- Verify hosted sessions are limited to the documented emergency service allowlist and expire.
- Verify automatic handback, insert-only merge, partner purge, session revocation, and append-only event/audit trail.
- Repeat all of the above with network interruption and node restart during each lifecycle stage.

## Commands and test evidence

Run from `eduos/` in the repository checkout:

```sh
npm test
npm run test:integration
make eden-sim
make -C edge-platform/eduos check
```

The EDEN PostgreSQL integration suite requires `EDUOS_TEST_PG_URL` (or `EDEN_TEST_PG_URL` as referenced by the test) pointing to a PostgreSQL 15+ superuser test instance. The suite creates temporary databases and non-superuser owner/runtime roles. If the variable is absent, the integration suite skips; a skipped test is not a pass.

Relevant existing tests inspected:

- `test/offline-node-32700.test.js`
- `test/offline-queue-owner-key.test.js`
- `test/offline-replay-boundaries-37.4.test.js`
- `test/eden-crypto-32700.test.js`
- `test/eden-gate-32700.test.js`
- `test/integration/eden-decn.test.js`

This PR is a readiness/verification document only. It does not claim these commands were run in this environment or that hardware has been tested.

## Exit criteria for closing PR queue item 1

Queue item 1 may be marked complete only when:

1. The software test matrix passes on the exact commit intended for release.
2. The real-PostgreSQL EDEN/DECN suite ran (not skipped) with non-owner runtime roles.
3. The two-node partition/recovery scenario passes.
4. A target hardware pilot passes installation, 72-hour soak, power-loss, disk-full, restore, and revocation drills.
5. New sign-in outage behavior is documented and tested as fail-closed.
6. Remaining aggregate privacy limitations are acknowledged and accepted by the district.
7. Evidence is attached to the PR: CI run links, logs, image digests, hardware profile, and signed pilot checklist.

Until then, local-first architecture exists, but production hardware readiness remains **unverified**.
