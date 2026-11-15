#!/bin/bash
# EduOS update agent (Edge Phase 2).
#
# Fedora CoreOS already updates itself safely: Zincati asks the update graph
# for new releases and rpm-ostree stages them as signed (GPG-verified),
# atomic deployments, keeping the previous one to roll back to. This agent
# does NOT download or apply updates itself. It:
#
#   apply-policy  turns /etc/eduos/update-policy.toml into a Zincati config
#                 fragment: maintenance windows in the district's time zone,
#                 a canary cohort (earliest rollout) chosen per device, or
#                 updates switched off. Zincati is restarted only if it changed.
#   verify        after a device boots into a new deployment and has run for
#                 [canary].health_check_minutes, checks it is healthy (no
#                 failed eduos-* units, disk and CPU under the [rollback]
#                 thresholds). Healthy: it becomes the known-good deployment.
#                 Unhealthy: updates are held (so Zincati doesn't re-apply the
#                 same release) and, if [rollback].automatic, the device rolls
#                 back to the previous deployment once, with a reboot.
#   status        writes /var/lib/eduos/os-status/status.json for the health
#                 agent to report (booted/staged version, hold, cohort, result).
#   release-hold  lifts a hold once IT has looked at it.
#   follow-target with [approvals].require_district_signoff, installs the OS
#                 version the district approved (see below).
#   run           apply-policy, verify, follow-target, status (the timer).
#
# District sign-off: with [approvals].require_district_signoff = true, Zincati
# never updates on its own. The agent asks the EduOS server
# (GET /api/edge/update-target, with the device token from the health agent)
# which version the district approved for this device's cohort: canaries get
# an approved version first, everyone else once it's promoted. It asks
# rpm-ostree to deploy that exact version, inside the maintenance window, and
# only if updates aren't held. No answer, or nothing approved: no update.
# If the district hasn't turned approvals on in EduOS, Zincati runs as usual.
#
# Runs on the host as root from eduos-update.service (a oneshot, started by
# eduos-update.timer and when the policy file changes), because it configures
# the OS updater. It uses only bash, coreutils, awk, sha256sum, curl, systemctl
# and rpm-ostree, all present on Fedora CoreOS.
set -euo pipefail

ETC="${EDUOS_ETC:-/etc}"
VAR="${EDUOS_VAR:-/var/lib/eduos}"
RPM_OSTREE="${RPM_OSTREE:-rpm-ostree}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
CURL="${CURL:-curl}"
POLICY="$ETC/eduos/update-policy.toml"
HEALTH_CONFIG="$ETC/eduos/health.toml"
TOKEN_FILE="${EDUOS_HEALTH_TOKEN_FILE:-$ETC/eduos/health-token}"
VERSION_RE='^[0-9]{2,3}\.[0-9]{8}\.[0-9]+\.[0-9]+$'
ZDIR="$ETC/zincati/config.d"
FRAGMENT="$ZDIR/55-eduos-policy.toml"
HOLD="$ZDIR/90-eduos-hold.toml"
STATE="$VAR/updates"
STATUS_DIR="$VAR/os-status"
LOG_TAG="eduos-update"

log() { logger -t "$LOG_TAG" -- "$1" 2>/dev/null || true; echo "$1" >&2; }
die() { log "error: $1"; exit 2; }

# toml_get SECTION KEY DEFAULT: the value of KEY in [SECTION], quotes and
# trailing comments removed. Enough for the flat policy file we ship.
toml_get() { toml_from "$POLICY" "$@"; }
toml_from() { # FILE SECTION KEY DEFAULT
  local v="" file=$1; shift
  [[ -f "$file" ]] && v=$(awk -v want="$1" -v key="$2" '
    /^[[:space:]]*\[/ { s=$0; gsub(/^[[:space:]]*\[|\][[:space:]]*(#.*)?$/, "", s); sec=s; next }
    sec==want {
      line=$0; sub(/#.*/, "", line)
      if (match(line, "^[[:space:]]*" key "[[:space:]]*=")) {
        val=substr(line, RLENGTH+1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", val); gsub(/^"|"$/, "", val); print val; exit
      }
    }' "$file")
  echo "${v:-$3}"
}

minutes() { local h=${1%%:*} m=${1##*:}; echo $((10#$h * 60 + 10#$m)); }

# canary or standard, stable per device: first 32 bits of sha256(machine-id) mod 100.
cohort() {
  local percent=$1 id hash
  id=$(cat "$ETC/machine-id" 2>/dev/null || true)
  [[ -n "$id" ]] || { echo standard; return; }
  hash=$(printf '%s' "$id" | sha256sum | cut -c1-8)
  if (( (16#$hash % 100) < percent )); then echo canary; else echo standard; fi
}

write_if_changed() { # path content -> 0 if changed
  local path=$1 content=$2 tmp
  if [[ -f "$path" ]] && [[ "$(cat "$path")" == "$content" ]]; then return 1; fi
  mkdir -p "$(dirname "$path")"
  tmp=$(mktemp "$path.XXXXXX")
  printf '%s\n' "$content" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$path"
  return 0
}

signoff_required() { [[ "$(toml_get approvals require_district_signoff false)" == true ]]; }

# ask_district: sets APPROVAL (off|waiting|current|unreachable) and TARGET, and
# remembers whether the district requires approval (district-requires), so a
# network outage doesn't flip Zincati on and off.
APPROVAL=""; TARGET=""
ask_district() {
  local endpoint url token body cohort_name
  mkdir -p "$STATE"
  rm -f "$STATE/target-version"
  endpoint=$(toml_from "$HEALTH_CONFIG" reporting endpoint "")
  url="${EDUOS_UPDATE_TARGET_URL:-${endpoint%/api/edge/health}/api/edge/update-target}"
  token=$(head -c 200 "$TOKEN_FILE" 2>/dev/null | tr -d '[:space:]' || true)
  if [[ -z "$endpoint" && -z "${EDUOS_UPDATE_TARGET_URL:-}" ]] || [[ ! "$url" =~ ^https:// && "${EDUOS_HEALTH_ALLOW_HTTP:-0}" != 1 ]] \
     || [[ ! "$token" =~ ^edh1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$ ]]; then
    log "district sign-off is required but this device has no EduOS endpoint or device token; no OS updates until it does"
    APPROVAL=unreachable; return 0
  fi
  cohort_name=$(cohort "$(toml_get canary percent 10)")
  [[ "$(toml_get general strategy canary)" == canary ]] || cohort_name=standard
  if ! body=$("$CURL" -sS --fail --max-time 20 -H "Authorization: Bearer $token" "$url?cohort=$cohort_name" 2>/dev/null); then
    log "couldn't ask EduOS for the approved OS version; not updating"
    APPROVAL=unreachable; return 0
  fi
  body=$(printf '%s' "$body" | tr -d '[:space:]' | head -c 2000)
  if [[ "$body" == *'"requireApproval":false'* ]]; then
    echo false > "$STATE/district-requires"; APPROVAL=off; return 0
  fi
  if [[ "$body" != *'"requireApproval":true'* ]]; then log "unexpected answer from EduOS; not updating"; APPROVAL=unreachable; return 0; fi
  echo true > "$STATE/district-requires"
  TARGET=$(printf '%s' "$body" | sed -n 's/.*"target":"\([^"]*\)".*/\1/p')
  if [[ -z "$TARGET" ]]; then APPROVAL=waiting; return 0; fi
  [[ "$TARGET" =~ $VERSION_RE ]] || { log "EduOS sent an invalid version; not updating"; TARGET=""; APPROVAL=unreachable; return 0; }
  echo "$TARGET" > "$STATE/target-version"
  if [[ "$(deployment booted version)" == "$TARGET" ]]; then APPROVAL=current; else APPROVAL=waiting; fi
}

# in_window: the current time (in the policy's time zone) is inside the
# maintenance window, or there's no window.
in_window() {
  local start end tz now s e n
  [[ "$(toml_get general strategy canary)" == immediate || "$(toml_get maintenance_window enabled true)" != true ]] && return 0
  start=$(toml_get maintenance_window start 02:00); end=$(toml_get maintenance_window end 04:00)
  tz=$(toml_get maintenance_window timezone localtime)
  if [[ -n "${EDUOS_CLOCK:-}" ]]; then now=$EDUOS_CLOCK
  elif [[ "$tz" == localtime ]]; then now=$(date +%H:%M)
  else now=$(TZ="$tz" date +%H:%M); fi
  s=$(minutes "$start"); e=$(minutes "$end"); n=$(minutes "$now")
  if (( s < e )); then (( n >= s && n < e )); else (( n >= s || n < e )); fi
}

# follow_target: deploy the district-approved version when it differs from
# the booted one. Never while held or disabled, never a version this device
# rolled back from, outside the window, or twice within six hours.
follow_target() {
  signoff_required || return 0
  [[ -n "$TARGET" && "$APPROVAL" == waiting ]] || return 0
  if [[ "$(toml_get general enabled true)" != true ]]; then return 0; fi
  if [[ -f "$HOLD" ]]; then log "district approved $TARGET but updates are held; not installing"; return 0; fi
  if [[ "$(cat "$STATE/rollback-from-version" 2>/dev/null)" == "$TARGET" ]]; then
    log "not installing $TARGET again: this device rolled back from it"; return 0
  fi
  in_window || return 0
  local attempted="" when=0 now
  now=$(date +%s)
  if [[ -f "$STATE/deploy-attempted" ]]; then read -r attempted when < "$STATE/deploy-attempted" || true; fi
  if [[ "$attempted" == "$TARGET" && "$when" =~ ^[0-9]+$ ]] && (( now - when < 6 * 3600 )); then
    APPROVAL=installing; return 0
  fi
  echo "$TARGET $now" > "$STATE/deploy-attempted"
  APPROVAL=installing
  log "installing district-approved OS version $TARGET"
  # --bypass-driver: Zincati is registered as the update driver; with
  # sign-off, the district (through this agent) drives instead.
  "$RPM_OSTREE" deploy --bypass-driver --reboot "$TARGET" || { log "rpm-ostree couldn't deploy $TARGET"; APPROVAL=waiting; }
}

apply_policy() {
  local enabled strategy win_on start end tz percent cohort_name="standard" frag
  enabled=$(toml_get general enabled true)
  strategy=$(toml_get general strategy canary)
  win_on=$(toml_get maintenance_window enabled true)
  start=$(toml_get maintenance_window start 02:00)
  end=$(toml_get maintenance_window end 04:00)
  tz=$(toml_get maintenance_window timezone localtime)
  percent=$(toml_get canary percent 10)

  [[ "$enabled" == true || "$enabled" == false ]] || die "[general].enabled must be true or false"
  mkdir -p "$STATE"
  [[ "$strategy" =~ ^(canary|immediate|maintenance-window-only)$ ]] || die "[general].strategy must be canary, immediate or maintenance-window-only"
  [[ "$start" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ && "$end" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || die "maintenance window times must be HH:MM"
  [[ "$tz" == localtime || "$tz" =~ ^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$ ]] || die "[maintenance_window].timezone must be an IANA name or localtime"
  if ! [[ "$percent" =~ ^[0-9]{1,3}$ ]] || (( percent > 100 )); then die "[canary].percent must be 0-100"; fi
  local zincati_on=$enabled
  if signoff_required; then
    ask_district
    # Zincati picks versions itself, so it stays off while the district
    # decides; follow-target installs the approved version instead.
    if [[ "$(cat "$STATE/district-requires" 2>/dev/null || echo true)" != false ]]; then zincati_on=false; fi
  else
    APPROVAL=off
  fi

  frag="# Generated by eduos-update from $POLICY. Do not edit; edit the policy.
[updates]
enabled = $zincati_on"
  if [[ "$strategy" != immediate && "$win_on" == true ]]; then
    local len=$(( ( $(minutes "$end") - $(minutes "$start") + 1440 ) % 1440 ))
    (( len > 0 )) || die "the maintenance window must be longer than 0 minutes"
    frag+="
strategy = \"periodic\"

[updates.periodic]
time_zone = \"$tz\"

[[updates.periodic.window]]
days = [ \"Mon\", \"Tue\", \"Wed\", \"Thu\", \"Fri\", \"Sat\", \"Sun\" ]
start_time = \"$start\"
length_minutes = $len"
  else
    frag+="
strategy = \"immediate\""
  fi
  if [[ "$strategy" == canary ]]; then
    cohort_name=$(cohort "$percent")
    # 0.0 asks for a release as soon as it's out (monitored canaries);
    # 1.0 asks to be in the last, most cautious part of the rollout.
    frag+="

[identity]
rollout_wariness = $([[ $cohort_name == canary ]] && echo 0.0 || echo 1.0)"
  fi
  echo "$cohort_name" > "$STATE/cohort"
  if write_if_changed "$FRAGMENT" "$frag"; then
    log "Zincati policy updated (strategy=$strategy, cohort=$cohort_name)"
    "$SYSTEMCTL" try-restart zincati.service || log "couldn't restart zincati.service"
  fi
}

# JSONPath query against the deployment list; prints the first value or "".
deployment() {
  "$RPM_OSTREE" status --json --jsonpath "\$.deployments[?(@.$1==true)].$2" 2>/dev/null \
    | tr -d '"[:space:]' | sed 's/[][]//g' | cut -d, -f1
}

hold() {
  local reason=$1
  write_if_changed "$HOLD" "# Written by eduos-update: $reason
# Remove with: eduos-update.sh release-hold
[updates]
enabled = false" && { log "updates held: $reason"; "$SYSTEMCTL" try-restart zincati.service || true; }
  printf '%s\n' "$reason" > "$STATE/hold-reason"
}

healthy() {
  local disk_max cpu_max failed disk load cpus cpu
  disk_max=$(toml_get rollback threshold_disk_percent 90)
  cpu_max=$(toml_get rollback threshold_cpu_percent 85)
  failed=$("$SYSTEMCTL" list-units --failed --plain --no-legend 'eduos-*' 2>/dev/null | awk 'NF{print $1}' | tr '\n' ' ')
  if [[ -n "$failed" ]]; then echo "failed units: $failed"; return 1; fi
  disk=$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}')
  if (( disk >= disk_max )); then echo "root disk ${disk}% (limit ${disk_max}%)"; return 1; fi
  load=$(awk '{print $2}' "${EDUOS_LOADAVG:-/proc/loadavg}")   # 5-minute load
  cpus=$(nproc)
  cpu=$(awk -v l="$load" -v c="$cpus" 'BEGIN{printf "%d", (l / c) * 100}')
  if (( cpu >= cpu_max )); then echo "CPU load ${cpu}% (limit ${cpu_max}%)"; return 1; fi
  return 0
}

verify() {
  local booted known="" attempted="" wait_min up why
  mkdir -p "$STATE"
  booted=$(deployment booted checksum)
  [[ "$booted" =~ ^[a-f0-9]{64}$ ]] || { echo pending > "$STATE/last-verify"; log "verify: couldn't read the booted deployment"; return 0; }
  [[ -f "$STATE/known-good" ]] && known=$(cat "$STATE/known-good")
  [[ -f "$STATE/rollback-attempted" ]] && attempted=$(cat "$STATE/rollback-attempted")
  if [[ "$booted" == "$known" ]]; then echo healthy > "$STATE/last-verify"; return 0; fi

  wait_min=$(toml_get canary health_check_minutes 30)
  [[ "$wait_min" =~ ^[0-9]{1,4}$ ]] || wait_min=30
  up=$(awk '{printf "%d", $1}' "${EDUOS_UPTIME:-/proc/uptime}")
  if (( up < wait_min * 60 )); then echo pending > "$STATE/last-verify"; return 0; fi

  if why=$(healthy); then
    echo "$booted" > "$STATE/known-good"
    # Healthy on a version it once rolled back from: that version is fine now.
    if [[ "$(cat "$STATE/rollback-from-version" 2>/dev/null)" == "$(deployment booted version)" ]]; then rm -f "$STATE/rollback-from-version"; fi
    if [[ -z "$known" ]]; then echo first_boot; else echo healthy; fi > "$STATE/last-verify"
    log "deployment ${booted:0:12} is healthy and now known-good"
    return 0
  fi

  log "deployment ${booted:0:12} is unhealthy: $why"
  hold "unhealthy after update to ${booted:0:12}: $why"
  if [[ -z "$known" ]]; then echo unhealthy > "$STATE/last-verify"; return 0; fi   # nothing known-good to go back to
  if [[ "$(toml_get rollback automatic true)" == true && "$attempted" != "$booted" ]]; then
    echo "$booted" > "$STATE/rollback-attempted"
    deployment booted version > "$STATE/rollback-from-version"
    echo rolled_back > "$STATE/last-verify"
    log "rolling back to the previous deployment"
    "$RPM_OSTREE" rollback --reboot || { echo unhealthy > "$STATE/last-verify"; log "rollback failed"; }
  else
    echo unhealthy > "$STATE/last-verify"
  fi
}

json_str() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "${s//$'\n'/ }"; }

status() {
  local booted_v booted_c staged_v updates="enabled" reason="" cohort_name verify z out target="" rollback_from="" approval
  approval=${APPROVAL:-$(cat "$STATE/approval" 2>/dev/null || echo off)}
  signoff_required || approval=off
  echo "$approval" > "$STATE/approval" 2>/dev/null || true
  target=$(cat "$STATE/target-version" 2>/dev/null || true)
  rollback_from=$(cat "$STATE/rollback-from-version" 2>/dev/null || true)
  booted_v=$(deployment booted version); booted_c=$(deployment booted checksum); staged_v=$(deployment staged version)
  if [[ -f "$HOLD" ]]; then updates=held; reason=$(cat "$STATE/hold-reason" 2>/dev/null || echo "held"); fi
  [[ "$(toml_get general enabled true)" == false ]] && updates=disabled
  cohort_name=$(cat "$STATE/cohort" 2>/dev/null || echo standard)
  verify=$(cat "$STATE/last-verify" 2>/dev/null || echo pending)
  z=$("$SYSTEMCTL" is-active zincati.service 2>/dev/null || true); [[ "$z" =~ ^(active|inactive|failed)$ ]] || z=unknown
  out="{\"booted_version\":$(json_str "$booted_v"),\"booted_checksum\":$(json_str "$booted_c"),\"staged_version\":$(json_str "$staged_v"),"
  out+="\"updates\":\"$updates\",\"hold_reason\":$(json_str "${reason:0:200}"),\"cohort\":\"$cohort_name\",\"last_verify\":\"$verify\",\"zincati\":\"$z\","
  out+="\"approval\":\"$approval\",\"target_version\":$(json_str "$target"),\"rollback_from_version\":$(json_str "$rollback_from")}"
  mkdir -p "$STATUS_DIR"
  write_if_changed "$STATUS_DIR/status.json" "$out" || true
}

release_hold() {
  rm -f "$HOLD" "$STATE/hold-reason"
  log "update hold released"
  "$SYSTEMCTL" try-restart zincati.service || true
}

case "${1:-run}" in
  apply-policy) apply_policy ;;
  verify) verify ;;
  status) mkdir -p "$STATE"; status ;;
  release-hold) release_hold; status ;;
  follow-target) apply_policy; follow_target; status ;;
  run) apply_policy; verify; follow_target; status ;;
  *) echo "usage: $0 [run|apply-policy|verify|follow-target|status|release-hold]" >&2; exit 64 ;;
esac
