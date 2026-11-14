#!/bin/bash
# EduOS Update Agent
# Policy-driven atomic updates with canary and rollback support

set -euo pipefail

POLICY_FILE="/etc/eduos/update-policy.toml"
UPDATE_DIR="/var/lib/eduos/updates"
LOG_TAG="eduos-update"
ROLE=$(cat /etc/eduos/role 2>/dev/null || echo "unknown")

log() { logger -t "$LOG_TAG" "$1"; echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

mkdir -p "$UPDATE_DIR"

log "EduOS Update agent starting for role=$ROLE"

# Read simple policy (very basic TOML parsing for demo)
if [[ -f "$POLICY_FILE" ]]; then
    MAINT_WINDOW=$(grep -E '^maintenance_window' "$POLICY_FILE" | cut -d'"' -f2 || echo "02:00-04:00")
    CANARY=$(grep -E '^canary_percent' "$POLICY_FILE" | cut -d'=' -f2 | tr -d ' ' || echo "10")
else
    MAINT_WINDOW="02:00-04:00"
    CANARY="10"
fi

log "Policy loaded: maintenance_window=$MAINT_WINDOW canary=${CANARY}%"

while true; do
    CURRENT_HOUR=$(date +%H)
    # Very simplified maintenance window check (real impl would be more sophisticated)
    if [[ "$CURRENT_HOUR" -ge 2 && "$CURRENT_HOUR" -lt 4 ]]; then
        log "Inside maintenance window. Checking for updates..."

        # Simulated check against district update server
        # In real: rpm-ostree update or zincati check, or custom EduOS update manifest
        if [[ -f "$UPDATE_DIR/pending-update" ]]; then
            log "Pending update found. Applying (simulated for role=$ROLE)..."
            # rpm-ostree upgrade --reboot   (or equivalent)
            rm -f "$UPDATE_DIR/pending-update"
            log "Update applied. Reboot would be scheduled here."
        else
            log "No pending updates."
        fi
    else
        log "Outside maintenance window. Sleeping."
    fi

    sleep 3600   # Check every hour
done
