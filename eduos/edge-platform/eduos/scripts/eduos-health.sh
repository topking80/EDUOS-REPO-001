#!/bin/bash
# EduOS health agent (Edge Phase 2).
#
# Every [agent].interval_seconds it collects device metrics, compliance flags
# and the OS update status written by eduos-update, saves the report to a
# local outbox, and sends the outbox oldest-first to the district EduOS
# server (POST /api/edge/health) with this device's token. While offline or
# while the server is down, reports wait in the outbox (at most
# [agent].max_cache_entries; the oldest are dropped first) and sending backs
# off. Reports never contain student data.
#
# Runs as the unprivileged eduos-health user (uid 10003): on the host from
# eduos-health.service, or in the eduos-health container. Uses only bash,
# coreutils, awk and curl, all present on Fedora CoreOS.
#
# The device token comes from district IT (Nodes > Edge devices > Register)
# and goes in /etc/eduos/health-token, readable by group eduos-health only.
set -euo pipefail

ETC="${EDUOS_ETC:-/etc}"
CONFIG="$ETC/eduos/health.toml"
HEALTH_DIR="${EDUOS_HEALTH_DIR:-/var/lib/eduos/health}"
OS_STATUS="${EDUOS_OS_STATUS:-/var/lib/eduos/os-status/status.json}"
TOKEN_FILE="${EDUOS_HEALTH_TOKEN_FILE:-$ETC/eduos/health-token}"
OUTBOX="$HEALTH_DIR/outbox"
AGENT_VERSION="2.0.0"
LOG_TAG="eduos-health"
MAX_SEND_PER_CYCLE=5   # the server accepts about six reports a minute per device

log() { logger -t "$LOG_TAG" -- "$1" 2>/dev/null || true; echo "$1" >&2; }

toml_get() { # SECTION KEY DEFAULT
  local v=""
  [[ -f "$CONFIG" ]] && v=$(awk -v want="$1" -v key="$2" '
    /^[[:space:]]*\[/ { s=$0; gsub(/^[[:space:]]*\[|\][[:space:]]*(#.*)?$/, "", s); sec=s; next }
    sec==want {
      line=$0; sub(/#.*/, "", line)
      if (match(line, "^[[:space:]]*" key "[[:space:]]*=")) {
        val=substr(line, RLENGTH+1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", val); gsub(/^"|"$/, "", val); print val; exit
      }
    }' "$CONFIG")
  echo "${v:-$3}"
}

int_or() { [[ "$1" =~ ^[0-9]{1,6}$ ]] && echo "$1" || echo "$2"; }

INTERVAL=$(int_or "${EDUOS_HEALTH_INTERVAL:-$(toml_get agent interval_seconds 300)}" 300)
(( INTERVAL >= 30 )) || INTERVAL=30
CACHE_ON=$(toml_get agent offline_cache true)
MAX_CACHE=$(int_or "$(toml_get agent max_cache_entries 1000)" 1000)
# EDUOS_HEALTH_ENDPOINT overrides the config; set it empty to keep reports local.
ENDPOINT="${EDUOS_HEALTH_ENDPOINT-$(toml_get reporting endpoint "")}"
TIMEOUT=$(int_or "$(toml_get reporting timeout_seconds 30)" 30)
WANT_TEMP=$(toml_get metrics temperature true)
WANT_SB=$(toml_get compliance check_secure_boot true)
SB_VAR="${EDUOS_SECUREBOOT_VAR:-/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c}"

# enabled/disabled from the UEFI SecureBoot variable (its last byte), unknown without UEFI.
secure_boot() {
  [[ "$WANT_SB" == true && -r "$SB_VAR" ]] || { echo unknown; return; }
  case "$(od -An -t u1 -j 4 -N 1 "$SB_VAR" 2>/dev/null | tr -d '[:space:]')" in
    1) echo enabled ;; 0) echo disabled ;; *) echo unknown ;;
  esac
}

if [[ -n "$ENDPOINT" && ! "$ENDPOINT" =~ ^https:// && "${EDUOS_HEALTH_ALLOW_HTTP:-0}" != 1 ]]; then
  log "refusing to send reports to a non-https endpoint: $ENDPOINT"
  ENDPOINT=""
fi

json_str() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "${s//$'\n'/ }"; }
num_or_null() { [[ "$1" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] && echo "$1" || echo null; }

collect() {
  local cpu mem_total mem_avail disk temp="null" up selinux boot_time os="{}" role hostname
  cpu=$(awk '/^cpu /{u=$2+$4; t=$2+$4+$5; if (t>0) printf "%.1f", u*100/t; else print 0}' /proc/stat)
  mem_total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
  mem_avail=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
  # On the host this is /. In the container, / is the image, so the container
  # sets EDUOS_DISK_PATH to a host folder on the same root filesystem.
  disk=$(df -P "${EDUOS_DISK_PATH:-/}" | awk 'NR==2{gsub("%","",$5); print $5}')
  up=$(awk '{printf "%d", $1}' /proc/uptime)
  if [[ "$WANT_TEMP" == true ]] && [[ -r /sys/class/thermal/thermal_zone0/temp ]]; then
    temp=$(awk '{printf "%.1f", $1/1000}' /sys/class/thermal/thermal_zone0/temp)
  fi
  selinux=$(getenforce 2>/dev/null || echo unknown)
  boot_time=$(uptime -s 2>/dev/null || echo "")
  # Written by eduos-update on the host (root); a single JSON object.
  if [[ -r "$OS_STATUS" ]] && [[ "$(head -c 1 "$OS_STATUS")" == "{" ]] && (( $(wc -l < "$OS_STATUS") <= 1 )); then
    os=$(head -c 4096 "$OS_STATUS")
  fi
  role=$(head -c 32 "$ETC/eduos/role" 2>/dev/null | tr -cd 'a-z-' || true)
  hostname=$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9.-' | head -c 64)
  printf '{"timestamp":"%s","hostname":%s,"role":%s,"agent_version":"%s","buffered":%s,' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(json_str "$hostname")" "$(json_str "${role:-unknown}")" "$AGENT_VERSION" "$(pending_count)"
  printf '"metrics":{"cpu_percent":%s,"mem_total_kb":%s,"mem_available_kb":%s,"root_disk_used_percent":%s,"temperature_c":%s,"uptime_seconds":%s},' \
    "$(num_or_null "$cpu")" "$(num_or_null "$mem_total")" "$(num_or_null "$mem_avail")" "$(num_or_null "$disk")" "$temp" "$(num_or_null "$up")"
  printf '"compliance":{"selinux":%s,"secure_boot":"%s","boot_time":%s,"eduos_version":%s},"os":%s}\n' \
    "$(json_str "$selinux")" "$(secure_boot)" "$(json_str "$boot_time")" "$(json_str "$(head -c 40 "$ETC/eduos/version" 2>/dev/null | tr -cd 'A-Za-z0-9._+-' || echo "")")" "$os"
}

pending_count() { find "$OUTBOX" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' '; }

enqueue() {
  local f
  mkdir -p "$OUTBOX"
  f="$OUTBOX/$(date -u +%Y%m%dT%H%M%S)-$$-$RANDOM.json"
  collect > "$f.tmp" && mv "$f.tmp" "$f"
  # The latest report, for local inspection. Copy then rename, so an existing
  # symlink at report.json is replaced rather than followed.
  cp "$f" "$HEALTH_DIR/.report.json.tmp" && mv -f "$HEALTH_DIR/.report.json.tmp" "$HEALTH_DIR/report.json"
  # Nowhere to send (no endpoint) or caching off: keep only the newest report.
  if [[ -z "$ENDPOINT" || "$CACHE_ON" != true ]]; then
    find "$OUTBOX" -maxdepth 1 -name '*.json' ! -path "$f" -delete
  fi
  # Keep at most MAX_CACHE reports: drop the oldest.
  local extra
  extra=$(( $(pending_count) - MAX_CACHE ))
  if (( extra > 0 )); then
    find "$OUTBOX" -maxdepth 1 -name '*.json' | sort | head -n "$extra" | xargs -r rm -f
    log "outbox full: dropped $extra old report(s)"
  fi
}

# send_one: 0 sent (or dropped as invalid), 1 try again later, 2 token refused.
# flush:    0 outbox sent, 1 server unreachable or failing (back off),
#           3 not configured yet (no endpoint or token): keep reports, no back-off.
send_one() {
  local f=$1 code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data-binary "@$f" "$ENDPOINT" 2>/dev/null) || code=000
  case "$code" in
    2??) rm -f "$f"; return 0 ;;
    401|403) return 2 ;;
    400|413|422) log "server refused report $(basename "$f") ($code); dropping it"; rm -f "$f"; return 0 ;;
    *) return 1 ;;
  esac
}

flush() {
  [[ -n "$ENDPOINT" ]] || return 3
  if [[ ! -r "$TOKEN_FILE" ]]; then log "no device token at $TOKEN_FILE yet; keeping reports on this device"; return 3; fi
  TOKEN=$(head -c 200 "$TOKEN_FILE" | tr -d '[:space:]')
  [[ "$TOKEN" =~ ^edh1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$ ]] || { log "the device token in $TOKEN_FILE isn't valid"; return 3; }
  local sent=0 f rc
  while IFS= read -r f; do
    (( sent < MAX_SEND_PER_CYCLE )) || break
    rc=0; send_one "$f" || rc=$?
    case $rc in
      0) sent=$((sent + 1)) ;;
      2) log "the server refused this device's token (revoked or wrong); keeping reports"; return 3 ;;
      *) return 1 ;;
    esac
  done < <(find "$OUTBOX" -maxdepth 1 -name '*.json' | sort)
  return 0
}

log "EduOS health agent $AGENT_VERSION starting (interval=${INTERVAL}s, endpoint=${ENDPOINT:-none})"
backoff=$INTERVAL
while true; do
  enqueue
  rc=0; flush || rc=$?
  if (( rc == 1 )); then
    # Server unreachable or failing: wait longer each time, up to an hour.
    backoff=$(( backoff * 2 )); (( backoff <= 3600 )) || backoff=3600
  else
    backoff=$INTERVAL
  fi
  [[ "${EDUOS_HEALTH_ONCE:-0}" == 1 ]] && break
  sleep "$backoff"
done
