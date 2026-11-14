#!/bin/bash
# EduOS Bootstrap Service
# First-boot device onboarding, identity acquisition, and registration

set -euo pipefail

ROLE_FILE="/etc/eduos/role"
BOOTSTRAP_MARKER="/etc/eduos/bootstrap-done"
LOG_TAG="eduos-bootstrap"

log() {
    logger -t "$LOG_TAG" "$1"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "EduOS Bootstrap starting..."

if [[ -f "$BOOTSTRAP_MARKER" ]]; then
    log "Bootstrap already completed. Exiting."
    exit 0
fi

# Detect role
if [[ -f "$ROLE_FILE" ]]; then
    ROLE=$(cat "$ROLE_FILE")
else
    ROLE="unknown"
fi
log "Detected role: $ROLE"

# Create required directories
mkdir -p /var/lib/eduos/{identity,health,updates,enrollments/pending}
chmod 750 /var/lib/eduos
# Dedicated unprivileged identity for the enrollment intake.
if ! getent group eduos-enrollment >/dev/null 2>&1; then
    groupadd --system --gid 10001 eduos-enrollment
fi
if ! id eduos-enrollment >/dev/null 2>&1; then
    useradd --system --uid 10001 --gid eduos-enrollment --home-dir /nonexistent --shell /sbin/nologin eduos-enrollment
fi
chown -R eduos-enrollment:eduos-enrollment /var/lib/eduos/enrollments
chmod 700 /var/lib/eduos/enrollments /var/lib/eduos/enrollments/pending
# Ephemeral bearer secret: generated locally, never logged or stored in the immutable image.
install -d -o root -g eduos-enrollment -m 0750 /run/eduos
umask 027
python3 - <<'PYTOKEN'
import secrets
from pathlib import Path
p=Path("/run/eduos/enrollment-token")
p.write_text(secrets.token_urlsafe(48))
p.chmod(0o640)
PYTOKEN
chown root:eduos-enrollment /run/eduos/enrollment-token

# Generate machine identity (in real deployment: use TPM, secure boot measurements, or SPIRE)
MACHINE_ID=$(cat /etc/machine-id 2>/dev/null || uuidgen || echo "eduos-$(date +%s)")
echo "$MACHINE_ID" > /var/lib/eduos/identity/machine-id
log "Machine identity established: $MACHINE_ID"

# Placeholder for mTLS certificate request to district control plane
# In production: curl --cert ... https://district.eduos.local/api/v1/bootstrap
log "Requesting initial certificates from district control plane (simulated)..."

# Write bootstrap completion marker
date -Iseconds > "$BOOTSTRAP_MARKER"
log "Bootstrap completed successfully for role=$ROLE"

# Trigger next services if needed
systemctl --no-block start eduos-enrollment.service eduos-health.service || true

exit 0
