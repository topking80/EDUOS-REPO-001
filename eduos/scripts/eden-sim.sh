#!/usr/bin/env bash
# 32.7.0 EDEN local simulation: two school nodes next to the dev stack.
#   make eden-sim            start (needs `make up` first), run the scenario + screenshots
#   make eden-sim-down       stop the nodes (keep their data)
#   ./scripts/eden-sim.sh --down-volumes   stop and delete the nodes' data
# The scenario (dev/eden-smoke.mjs): enrollment under the local trust root,
# gated aggregates, a phone that loses signal (offline queue), a district
# uplink partition via `docker network disconnect`, healing, partner setup,
# a school node failure with district-authorized failover to the partner,
# and automatic handback when the node returns. LOCAL EVALUATION ONLY: these
# are containers on one machine, not Raspberry Pi hardware on real links.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=${EDUOS_DEV_ENV_FILE:-.env.dev}
[ -f "$ENV_FILE" ] || { echo "run 'make up' first ($ENV_FILE not found)" >&2; exit 1; }
export EDUOS_ENV_FILE="$ENV_FILE"
MAIN=(docker compose --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.dev.yml --profile edge)
EDEN=(docker compose --env-file "$ENV_FILE" -f docker-compose.eden.yml)
WAN=eduos-eden_eden_wan

detach_main() {
  for svc in app devidp; do
    cid=$("${MAIN[@]}" ps -q "$svc" 2>/dev/null || true)
    [ -n "$cid" ] && docker network disconnect -f "$WAN" "$cid" >/dev/null 2>&1 || true
  done
}
case "${1:-}" in
  --down) detach_main; "${EDEN[@]}" down --remove-orphans; echo "School nodes stopped (data kept)."; exit 0 ;;
  --down-volumes) detach_main; "${EDEN[@]}" down --volumes --remove-orphans; echo "School nodes stopped; their data deleted."; exit 0 ;;
esac

grep -q '^EDEN_ROOT_CERT=.' "$ENV_FILE" || { echo "the dev stack has no EDEN trust root yet: run 'make up' again" >&2; exit 1; }
if ! grep -q '^EDEN_SIM_DB_PASSWORD=.' "$ENV_FILE"; then
  printf 'EDEN_SIM_DB_PASSWORD=%s\n' "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> "$ENV_FILE"
fi
app=$("${MAIN[@]}" ps -q app); idp=$("${MAIN[@]}" ps -q devidp)
[ -n "$app" ] && [ -n "$idp" ] || { echo "the dev stack is not running: make up" >&2; exit 1; }
docker exec "$app" node -e "process.exit(process.env.EDUOS_NODE_TIER==='district'?0:1)" || {
  echo "the dev app is not running as the district hub; recreate it: docker compose ... up -d app (make up does this)" >&2; exit 1; }

echo "Starting the simulated school database…"
"${EDEN[@]}" up -d --wait eden-db
# The district "WAN": the dev app (as district-hub) and the dev IdP join it.
# (`create` makes the compose networks without starting the nodes.)
"${EDEN[@]}" create --quiet-pull node-a node-b >/dev/null 2>&1 || "${EDEN[@]}" create node-a node-b
docker network inspect "$WAN" >/dev/null
docker network connect --alias district-hub "$WAN" "$app" 2>/dev/null || true
docker network connect --alias devidp "$WAN" "$idp" 2>/dev/null || true
echo "Running the scenario (dev/eden-smoke.mjs)…"
node dev/eden-smoke.mjs
