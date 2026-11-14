#!/bin/bash
# EduOS Health & Telemetry Agent
# Collects system metrics, compliance status, and reports to district/state

set -euo pipefail

HEALTH_DIR="/var/lib/eduos/health"
CONFIG="/etc/eduos/health.toml"
INTERVAL=300   # 5 minutes
LOG_TAG="eduos-health"

log() { logger -t "$LOG_TAG" "$1"; }

mkdir -p "$HEALTH_DIR"

log "EduOS Health agent starting (interval=${INTERVAL}s)"

while true; do
    TIMESTAMP=$(date -Iseconds)
    HOSTNAME=$(hostname)
    ROLE=$(cat /etc/eduos/role 2>/dev/null || echo "unknown")

    # Collect basic metrics
    CPU=$(awk '{u=$2+$4; t=$2+$4+$5; if (t>0) print u*100/t; else print 0}' <(grep 'cpu ' /proc/stat))
    MEM_TOTAL=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
    MEM_AVAIL=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
    DISK_ROOT=$(df / | awk 'NR==2 {print $5}' | tr -d '%')

    # Write JSON report
    cat > "$HEALTH_DIR/report.json" <<JSON
{
  "timestamp": "$TIMESTAMP",
  "hostname": "$HOSTNAME",
  "role": "$ROLE",
  "metrics": {
    "cpu_percent": ${CPU%.*},
    "mem_total_kb": $MEM_TOTAL,
    "mem_available_kb": $MEM_AVAIL,
    "root_disk_used_percent": $DISK_ROOT
  },
  "compliance": {
    "selinux": "$(getenforce 2>/dev/null || echo 'unknown')",
    "boot_time": "$(uptime -s)",
    "eduos_version": "0.1.0-alpha"
  }
}
JSON

    log "Health report written: cpu=${CPU%.*}% disk=${DISK_ROOT}%"

    # In production: POST to district health endpoint with mTLS
    # curl -X POST --data-binary @"$HEALTH_DIR/report.json" https://district.eduos.local/api/v1/health

    sleep "$INTERVAL"
done
