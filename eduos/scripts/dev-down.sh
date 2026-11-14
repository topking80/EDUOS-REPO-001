#!/usr/bin/env bash
# Stop the local evaluation stack. --volumes also deletes the database, the
# Caddy CA and the generated .env.dev secrets.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=${EDUOS_DEV_ENV_FILE:-.env.dev}
[ -f "$ENV_FILE" ] || { echo "nothing to stop ($ENV_FILE not found)"; exit 0; }
export EDUOS_ENV_FILE="$ENV_FILE"
DC=(docker compose --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.dev.yml --profile edge --profile seed --profile ops)
# 32.7.0: the simulated school nodes go first (their WAN network has the dev app attached).
if docker compose -p eduos-eden ps -aq 2>/dev/null | grep -q .; then
  if [ "${1:-}" = "--volumes" ]; then ./scripts/eden-sim.sh --down-volumes; else ./scripts/eden-sim.sh --down; fi
fi
if [ "${1:-}" = "--volumes" ]; then
  "${DC[@]}" down --volumes --remove-orphans
  rm -f "$ENV_FILE"; rm -rf .eden-dev
  echo "Stopped; database volume and $ENV_FILE removed."
else
  "${DC[@]}" down --remove-orphans
  echo "Stopped; data kept (make up resumes)."
fi
