# EduOS Air-Gapped & Disconnected Deployment Guide

EduOS was designed with air-gapped and intermittently connected environments as a first-class use case. Many K-12 districts, especially in rural areas or with strict security policies, require full offline operation.

## Core Principles

1. **Everything needed to boot and run a role must be deliverable via USB or internal media.**
2. **No hard dependency on external registries or control planes after initial provisioning.**
3. **Local services (enrollment, health caching, update staging) must continue to function offline.**
4. **Updates can be sneaker-netted via USB when connectivity is impossible.**

## Method 1: Pre-Embedded Ignition (Recommended for Air-Gap)

Use the build script with `--embed-ignition`:

```bash
./boot/build-iso.sh --variant student --embed-ignition --version 0.2.0
```

This produces `eduos-core-student-0.2.0.iso` with the Ignition config baked in. The ISO can be written to USB and used completely offline.

**Advantages**:
- Single artifact to distribute
- No network required at boot time
- Easy to audit what configuration was applied

**Disadvantages**:
- Different ISO per role (or use one "universal" ISO + runtime selection)

## Method 2: Universal ISO + Local Ignition File

1. Build a generic `eduos-core.iso` without embedded Ignition.
2. On a USB stick, create a second partition or directory containing the desired `.ign` file.
3. At boot, pass on the kernel command line:
   ```
   ignition.config.url=file:///run/media/ignition/student.ign
   ```
   or use the `ignition.firstboot` + file drop method supported by coreos-installer.

## Offline Enrollment & Health

The `eduos-enrollment` and `eduos-health` services are designed to work fully offline:

- Enrollments are written to `/var/lib/eduos/enrollments/*.json`
- Health reports are cached in `/var/lib/eduos/health/`
- When a device later connects (or a USB "sync stick" is inserted), the local data can be uploaded or rsynced to the district control plane.

## Update Delivery in Air-Gapped Environments

Options (from simplest to most advanced):

1. **Manual USB updates** — District IT prepares an update payload USB. Technician inserts it during maintenance window. The `eduos-update` agent detects it and applies if policy allows.
2. **Sneaker-net manifest + image** — District builds a new OS image + Ignition, distributes on USBs.
3. **Tiered canary with physical transport** — Edge nodes in connected schools receive updates first, then USBs are created from those nodes and carried to disconnected sites.

## Security Considerations for Air-Gap

- Use TPM2 + measured boot where possible (even on Pi 5 with fTPM)
- Pre-provision machine identities and certificates during image build
- Sign all containers/images used in the air-gapped environment
- Maintain an offline copy of the EduOS build pipeline for emergency rebuilds

## Recommended Workflow for Highly Sensitive Sites

1. Build and test everything in a connected lab.
2. Export the final ISO + all required Ignition configs + any container images to read-only media.
3. Perform a clean-room transfer into the air-gapped network.
4. Use the embedded Ignition method for initial deployment.
5. Use local enrollment + cached health for ongoing operations.
6. For updates, use the USB payload method with cryptographic verification.

EduOS treats air-gapped operation as a core requirement, not an afterthought.
