#!/usr/bin/env bash
# Run the end-to-end smoke test against the stack started by `make up`.
#   ./scripts/smoke.sh            HTTP flows (dev/smoke.mjs)
#   ./scripts/smoke.sh --browser  also a headless-browser pass + screenshots (dev/browser-smoke.mjs,
#                                 then the 32.4.0 phone-size role-app pass, dev/mobile-smoke.mjs,
#                                 then the 32.5.0 SafetyOS + pick-up phone pass, dev/safety-smoke.mjs,
#                                 then the 32.6.0 learning core + EDAL phone pass, dev/learning-smoke.mjs)
#   ./scripts/smoke.sh --mobile   HTTP flows + only the phone-size passes (role apps, SafetyOS)
#   ./scripts/smoke.sh --safety   HTTP flows + only the SafetyOS + pick-up phone pass
#   ./scripts/smoke.sh --learning HTTP flows + only the learning core + EDAL phone pass
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=${EDUOS_DEV_ENV_FILE:-.env.dev}
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE not found: run make up first" >&2; exit 1; }
get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }
export EDUOS_ENV_FILE="$ENV_FILE"
DC="docker compose --env-file $ENV_FILE -f docker-compose.yml -f docker-compose.dev.yml --profile edge"
CA=$(mktemp); trap 'rm -f "$CA"' EXIT
$DC cp edge:/data/caddy/pki/authorities/local/root.crt "$CA" >/dev/null
export NODE_EXTRA_CA_CERTS="$CA"
export EDUOS_BASE="https://localhost:$(get EDUOS_HTTPS_PORT)"
export EDUOS_INTERNAL="$DC exec -T app node -e"
export EDUOS_RETENTION="$DC --profile ops run --rm -T retention"
export METRICS_TOKEN="$(get METRICS_TOKEN)"
# The webhook sink shares the app's network namespace; after recreating only
# the app it must be recreated too (a full `up -d` does that).
if ! $DC exec -T app node -e 'fetch("http://127.0.0.1:9999/deliveries").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' >/dev/null 2>&1; then
  echo "webhook sink not reachable from the app; running a full 'up -d' to reattach it" >&2
  $DC up -d >/dev/null
fi
node dev/smoke.mjs
if [ "${1:-}" = "--browser" ]; then node dev/browser-smoke.mjs; node dev/mobile-smoke.mjs; node dev/safety-smoke.mjs; node dev/learning-smoke.mjs; fi
if [ "${1:-}" = "--mobile" ]; then node dev/mobile-smoke.mjs; node dev/safety-smoke.mjs; node dev/learning-smoke.mjs; fi
if [ "${1:-}" = "--safety" ]; then node dev/safety-smoke.mjs; fi
if [ "${1:-}" = "--learning" ]; then node dev/learning-smoke.mjs; fi
