#!/bin/bash
# EduOS ISO Build Wrapper
# This script helps produce eduos-core.iso from Fedora CoreOS base + EduOS overlays.
#
# Prerequisites (run on a build machine with internet):
#   - coreos-assembler (COSA) or
#   - fedora-coreos-config + rpm-ostree compose + coreos-installer
#
# Usage:
#   ./boot/build-iso.sh --variant student --version 0.1.0
#   ./boot/build-iso.sh --all-roles   # build multiple ISOs with embedded ignition

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
VERSION="${VERSION:-0.1.0-alpha}"
VARIANT="${VARIANT:-student}"
OUTPUT_ISO="eduos-core-${VARIANT}-${VERSION}.iso"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

usage() {
    cat <<USAGE
EduOS ISO Builder

Options:
  --variant <student|teacher|admin|edge|district|state|all>
  --version <x.y.z>
  --embed-ignition   Embed the matching .ign into the ISO (air-gapped friendly)
  --help
USAGE
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --variant) VARIANT="$2"; shift 2 ;;
        --version) VERSION="$2"; shift 2 ;;
        --embed-ignition) EMBED_IGNITION=1; shift ;;
        --help) usage; exit 0 ;;
        *) echo "Unknown option: $1"; usage; exit 1 ;;
    esac
done

log "Building EduOS ISO variant=$VARIANT version=$VERSION"

# Example using coreos-installer (lightweight path)
if command -v coreos-installer >/dev/null 2>&1; then
    log "Using coreos-installer to embed Ignition (if requested)..."

    BASE_ISO_URL="https://builds.coreos.fedoraproject.org/prod/streams/stable/builds/latest/x86_64/fedora-coreos-latest-metal.x86_64.iso"
    BASE_ISO="/tmp/fedora-coreos-base.iso"

    if [[ ! -f "$BASE_ISO" ]]; then
        log "Downloading base Fedora CoreOS ISO (this requires internet)..."
        curl -L -o "$BASE_ISO" "$BASE_ISO_URL"
    fi

    IGNITION_FILE="$REPO_ROOT/ignition/${VARIANT}.ign"
    if [[ "${EMBED_IGNITION:-0}" == "1" && -f "$IGNITION_FILE" ]]; then
        log "Embedding $IGNITION_FILE into ISO..."
        coreos-installer iso embed \
            --ignition "$IGNITION_FILE" \
            --dest-ignition "$IGNITION_FILE" \
            "$BASE_ISO" \
            -o "$REPO_ROOT/boot/eduos-core-${VARIANT}-${VERSION}.iso"
    else
        cp "$BASE_ISO" "$REPO_ROOT/boot/eduos-core-${VARIANT}-${VERSION}.iso"
    fi

    log "ISO created: $REPO_ROOT/boot/eduos-core-${VARIANT}-${VERSION}.iso"
else
    log "coreos-installer not found. For full builds use coreos-assembler (COSA)."
    log "See https://coreos.github.io/coreos-assembler/ for instructions."
    log "You can still use the ignition/ configs with PXE or manual coreos-installer."
fi

log "Done. Remember to replace placeholder SSH keys and tokens before production use."

# ============================================================
# Modern rpm-ostree + Butane Workflow (Recommended)
# ============================================================
#
# 1. Convert Butane to Ignition:
#    butane butane/teacher.bu > ignition/teacher.ign
#
# 2. (Optional) Compose custom OSTree:
#    rpm-ostree compose tree --repo=repo compose/eduos-tree.yaml
#
# 3. Customize base Fedora CoreOS ISO:
#    coreos-installer iso customize \
#      --dest-ignition ignition/teacher.ign \
#      --dest-ignition ignition/base.bu \   # or merge in Butane
#      fedora-coreos-40.2024xxxx.x86_64.iso \
#      -o eduos-teacher-0.2.0.iso
#
# This is the preferred production path over simple embedding.
