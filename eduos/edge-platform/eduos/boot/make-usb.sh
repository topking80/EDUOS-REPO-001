#!/usr/bin/env bash
set -euo pipefail

ISO="${1:-}"
DEVICE="${2:-}"

if [[ -z "$ISO" || -z "$DEVICE" ]]; then
    echo "Usage: $0 <iso> <device>"
    exit 1
fi

if [[ ! -f "$ISO" ]]; then
    echo "Error: ISO not found: $ISO"
    exit 1
fi

if [[ ! -b "$DEVICE" ]]; then
    echo "Error: Invalid block device: $DEVICE"
    exit 1
fi

echo "====================================="
echo "EduOS USB Creator"
echo "====================================="
echo "ISO    : $ISO"
echo "DEVICE : $DEVICE"
echo
echo "WARNING: ALL DATA ON $DEVICE WILL BE LOST"
echo

read -rp "Continue? (yes/no): " CONFIRM

if [[ "$CONFIRM" != "yes" ]]; then
    echo "Aborted."
    exit 1
fi

echo
echo "Preparing device..."
sudo umount "${DEVICE}"* 2>/dev/null || true
sudo wipefs -af "$DEVICE"

echo
echo "Writing ISO to $DEVICE..."
sudo dd \
    if="$ISO" \
    of="$DEVICE" \
    bs=8M \
    status=progress \
    oflag=direct \
    conv=fsync

sync

echo
echo "EduOS USB creation complete."
