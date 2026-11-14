#!/usr/bin/env bash
set -euo pipefail

URL="$1"
DEVICE="$2"

if [[ -z "$URL" || -z "$DEVICE" ]]; then
    echo "Usage: $0 <url> <device>"
    exit 1
fi

TMP=$(mktemp --suffix=.iso)
trap 'rm -f "$TMP"' EXIT

echo "Downloading ISO from $URL..."
curl -L --progress-bar "$URL" -o "$TMP"

./boot/make-usb.sh "$TMP" "$DEVICE"
./boot/verify-usb.sh "$TMP" "$DEVICE"

echo "Remote ISO flashed and verified successfully."
