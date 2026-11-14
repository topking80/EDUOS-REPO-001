#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/devices.conf"

echo "Writing multiple EduOS USB devices..."

./boot/make-usb.sh release/eduos-school.iso   "$SCHOOL"
./boot/make-usb.sh release/eduos-district.iso "$DISTRICT"
./boot/make-usb.sh release/eduos-state.iso    "$STATE"

echo
echo "All EduOS USB devices written successfully."
