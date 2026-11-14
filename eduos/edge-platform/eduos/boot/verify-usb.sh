#!/usr/bin/env bash
set -euo pipefail

ISO="$1"
DEVICE="$2"

if [[ ! -f "$ISO" || ! -b "$DEVICE" ]]; then
    echo "Usage: $0 <iso> <device>"
    exit 1
fi

ISO_SIZE=$(stat -c%s "$ISO")
ISO_HASH=$(sha256sum "$ISO" | awk '{print $1}')

echo "Verifying USB..."

DEVICE_HASH=$(
    sudo dd if="$DEVICE" \
        bs=1M \
        count=$(( (ISO_SIZE + 1048575) / 1048576 )) \
        status=none \
    | head -c "$ISO_SIZE" \
    | sha256sum \
    | awk '{print $1}'
)

echo "ISO    : $ISO_HASH"
echo "DEVICE : $DEVICE_HASH"

if [[ "$ISO_HASH" == "$DEVICE_HASH" ]]; then
    echo "Verification PASSED ✓"
else
    echo "Verification FAILED ✗"
    exit 1
fi
