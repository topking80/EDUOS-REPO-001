# Upgrading to EduOS 32.7.0

Design and limits: `docs/EDEN-32.7.0.md`. Nothing changes for a single-server
install unless you set `EDUOS_NODE_TIER`.

## 1. Migration

- `db/015_eden_local_node_decn.sql` is applied by `src/migrate.js`. `/ready`
  now reports 15 migrations.
- What it adds:
  - `observed_at` and `queued` columns on roll call, check-ins and
    attendance, plus the `offline_replays` table (idempotent replay);
  - a disabled system user (`urn:eduos:system`) used by the EDEN agent and
    hub roles;
  - hub tables (`eden_nodes`, `eden_enrollment_tokens`, `eden_nonces`,
    `eden_bundles`, `eden_node_bundles`, `eden_aggregates`,
    `eden_inbound_log`, `eden_continuity_packages`, `eden_failovers`,
    `eden_failover_events`);
  - node tables (`eden_node_state`, `eden_outbox`, `eden_egress_log`,
    `eden_bundle_cache`, `eden_consent_exceptions`, `decn_*`).
- Every new table has FORCE row-level security with tenant isolation plus
  restrictive role policies. The logs are append-only. There are no location
  columns.
- Re-run `migrate` so `db/runtime_grants.template.sql` grants the runtime role
  the new tables, the `eden_outbox` sequence and the SECURITY DEFINER
  functions. The owner-only `eduos_node_prune_to_school()` is not granted.

## 2. Trust root (once per state or deployment)

```sh
node src/eden/authority-cli.js init --dir /secure/eden-root --name "EduOS root for <state>"
node src/eden/authority-cli.js issue-district --dir /secure/eden-root --district-id <uuid> --name "<district>"
node src/eden/authority-cli.js env --dir /secure/eden-root --district-id <uuid>   # prints EDEN_ROOT_CERT / EDEN_DISTRICT_CERT / EDEN_DISTRICT_KEY
```

- Keep `root.key.json` offline (mode 600). Only the certificates and the
  district key go to the hub.
- `sign-bundle` signs root-level bundles, which the hub imports with
  `POST /api/eden/admin/bundles/import`.

## 3. District hub

Add these settings to the district server's env:

```
EDUOS_NODE_TIER=district
EDEN_ROOT_CERT=…  EDEN_DISTRICT_CERT=…  EDEN_DISTRICT_KEY=…
EDEN_NODE_OFFLINE_AFTER_SECONDS=90     # silence before a node counts as offline (min 5)
EDEN_FAILOVER_MAX_HOURS=24             # 1-72
EDEN_CONSENT_EXCEPTIONS=off            # leave off unless counsel approves record transfers
```

- Superintendents and IT see a **Nodes** tab in `/app/` for nodes, partners,
  enrollment tokens, signed updates and the inbound log.
- Only superintendents can authorize a failover.
- Put `/api/eden/v1/*` behind the same TLS edge as the rest of the server.

## 4. School nodes

Use one of the two packaged profiles:
- `deploy/school-node/` (Docker or Podman compose, about 640 MB of memory
  caps);
- `edge-platform/eduos/butane/school-node.bu` (Fedora CoreOS, Quadlet).

Steps:
1. On the hub's Nodes screen, choose **Add a school node** to create a token.
2. Set the node's env: `EDUOS_NODE_TIER=school`, `EDEN_ROOT_CERT`
   (the pinned root), `EDEN_HUB_URL=https://…`, `EDEN_DISTRICT_ID`,
   `EDEN_SCHOOL_ID` and `EDEN_ENROLLMENT_TOKEN`.
3. Run `migrate`, load the school's data, then run
   `node src/eden/node-provision.js --school <uuid>` with the owner
   `DATABASE_URL`. This keeps one school.
4. Start the node. It enrolls, then syncs every `EDEN_SYNC_INTERVAL_SECONDS`
   (default 30). The identity key lives in `EDEN_IDENTITY_FILE`; keep that
   volume.
5. Remove the token from the env once the node shows as online.

Principals see a "School node" card on their School screen, with uplink,
outbox, the egress log ("What left this school"), partner, updates and
device memory. **Sync now** is rate-limited (`EDEN_SYNC_NOW_PER_MINUTE`,
default 6) and audited.

To revoke a node, use `POST /api/eden/admin/nodes/:id/revoke`. Revoked
certificate serials reach other nodes in heartbeat directives.

## 5. DECN

1. Set a partner for each school on the Nodes screen. The continuity package
   follows within an hour.
2. If a school node is down, the superintendent uses **Authorize failover**,
   with a reason and a number of hours.
3. The school's staff sign in at the partner node's address for SafetyOS,
   pick-up, buses and attendance.
4. Handback happens automatically when the node returns, or press **End**.
5. Tell families through your usual channel: EduOS sends no family
   notifications during a failover.

## 6. Local evaluation

- `make up` now also creates a local trust root in `.eden-dev/` (git-ignored)
  and runs the dev API as the district hub.
- `make eden-sim` starts `docker-compose.eden.yml`: `eden-db`, `node-a` on
  :8501 and `node-b` on :8502. It then runs the scenario in
  `dev/eden-smoke.mjs`: enrollment, aggregates, phone offline queue,
  partition and heal, partners, failover, handback. Screenshots go to
  `EDEN_SCREENSHOT_DIR`.
- `make eden-sim-down` stops the nodes (`ARGS=--down-volumes` deletes their
  data). `make down` / `make down-volumes` stop the nodes first.

## 7. Phones

- The service worker cache is `eduos-app-shell-32.7.0`, still shell only.
- New: an encrypted offline queue for roll call, bus check-ins and
  attendance (§5 of the EDEN doc). Nothing to configure.
- Signing out with unsent changes asks first, because sign-out deletes them.
