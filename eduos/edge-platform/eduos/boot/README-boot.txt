eduos-core.iso
==============

This directory should contain the bootable EduOS ISO image.

How to obtain / build:

1. Recommended: Use Fedora CoreOS Assembler (COSA)
   https://github.com/coreos/coreos-assembler

2. Or the simplified EduOS build wrapper (coming soon):
   ./boot/build-iso.sh --variant eduos --version 0.1.0

3. For development / testing you can also use:
   coreos-installer iso embed \
     --ignition ignition/student.ign \
     --dest-ignition ignition/teacher.ign \
     fedora-coreos-*.iso \
     -o eduos-core.iso

The resulting eduos-core.iso can be:
- Written to USB with dd or balenaEtcher
- Served via PXE / matchbox / netboot.xyz
- Used directly in virtual machines (QEMU, VirtualBox, etc.)

For air-gapped environments, embed the desired Ignition config at image build time.

NOTE (32.0.53): the eduos-*-0.2.0.iso files shipped in this directory are
0-byte placeholders, not bootable images. Build real images with
`make iso-<role> BASE_ISO=...` (see docs/BUILD.md).
