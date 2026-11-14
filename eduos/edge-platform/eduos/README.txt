EduOS - Educational Operating System
=====================================

Version: 0.1.0-alpha
Date: 2026-06-11
License: Apache 2.0 (or your chosen educational open source license)
Maintainer: EduOS Project (community + district contributors)

## Mission

EduOS delivers a secure, privacy-respecting, low-maintenance operating system
purpose-built for educational institutions. It emphasizes:

- Immutable infrastructure (CoreOS-style)
- Role-based zero-touch provisioning via Ignition
- Strong separation between student, teacher, admin, and management planes
- Built-in support for district and state-level fleet orchestration
- Compliance-friendly telemetry (FERPA/COPPA/GDPR alignment)
- Simple enrollment for devices, users, and classrooms
- Atomic, policy-driven updates with canary and rollback support

## Directory Layout

eduos/
├── boot/
│   └── eduos-core.iso          # Base immutable OS image (see build instructions)
├── ignition/
│   ├── teacher.ign             # Teacher / classroom facilitator role
│   ├── student.ign             # Student device / kiosk role
│   ├── admin.ign               # On-site IT / school administrator
│   ├── edge.ign                # Classroom / building edge compute node
│   ├── district.ign            # District central management node
│   └── state.ign               # State / regional oversight & aggregation
├── services/
│   ├── bootstrap.service       # First-boot device onboarding
│   ├── enrollment.service      # User/device enrollment workflows
│   ├── health.service          # Telemetry, compliance, and node health
│   └── update.service          # Atomic update orchestration
└── README.txt                  # This file

## Core Concepts

### 1. Immutable Base (eduos-core.iso)
EduOS is derived from Fedora CoreOS (or RHEL CoreOS / Flatcar) with:
- Minimal host footprint
- Podman + systemd (Quadlet) for all workloads
- SELinux enforcing + locked-down users by default
- Read-only rootfs with /etc and /var overlays
- Automatic zincati / rpm-ostree style updates (customized)

The ISO can be written to USB, used for PXE, or installed via coreos-installer.

### 2. Ignition Provisioning (ignition/*.ign)
Ignition runs on first boot and declaratively configures the system:
- Users, groups, SSH keys, passwords
- Network configuration
- Storage layout and LUKS
- systemd units to enable
- Files and directories to create
- Container images to pull and run

Each .ign file is role-specific so a single ISO can serve many personas.

Example workflow:
  coreos-installer install \
    --ignition-url https://provision.eduos.local/ignition/teacher.ign \
    /dev/sda

Or use PXE + matchbox / Fedora CoreOS PXE for large fleets.

### 3. EduOS Services (services/*.service)
These are systemd unit files (or Quadlet .container/.volume/.network files)
that implement the control plane:

- **bootstrap.service**: Obtains machine identity, registers with district
  control plane, fetches initial certificates and policies.

- **enrollment.service**: Runs a local or proxied enrollment UI/API so
  teachers can onboard student devices or new users with QR codes or
  NFC badges.

- **health.service**: Collects anonymized metrics (CPU, storage, app usage),
  runs compliance checks, and reports to district/state dashboards.
  Supports offline caching + later sync.

- **update.service**: Coordinates with district policy server for staged
  rollouts, respects maintenance windows, supports canary cohorts and
  instant rollback on health degradation.

Services are designed to be replaceable. Many districts will run their
own control-plane instances while using the reference implementations here.

## Quick Start (Single Machine / USB)

1. Build or download eduos-core.iso (see below).
2. `dd if=eduos-core.iso of=/dev/sdX bs=4M status=progress`
3. Boot the USB on target hardware.
4. At the bootloader menu (or via kernel cmdline) pass:
   ignition.config.url=https://your-provision-server/ignition/student.ign
   (or embed the .ign into the ISO for air-gapped use)

For development:
   podman run --rm -it \
     -v $(pwd)/ignition:/ignition:Z \
     quay.io/coreos/ignition-validate:latest \
     /ignition/student.ign

## Building eduos-core.iso

EduOS uses the standard Fedora CoreOS pipeline with custom overlays.

Recommended tools:
- coreos-assembler (COSA)
- or fedora-coreos-config + rpm-ostree compose

High-level steps:
1. Clone https://github.com/eduos-project/fedora-coreos-config (fork)
2. Add custom packages, kernel arguments, and systemd units from this repo.
3. Run `cosa build` to produce the ISO + metal images.
4. Optionally wrap with your district branding and default Ignition.

See `boot/build-iso.sh` (to be added) for a simplified wrapper.

## Security & Privacy Model

- All inter-node communication uses mTLS + SPIFFE/SPIRE identities.
- Student data never leaves the district boundary by default.
- Health telemetry is aggregated and anonymized before state-level reporting.
- Full disk encryption + TPM2 binding on supported hardware.
- Immutable root + verified boot chain (where firmware allows).
- SELinux + seccomp + user namespaces for all containers.

## Integration Points

EduOS is designed to integrate with:
- Existing district SIS (Student Information Systems) via APIs
- Google Workspace for Education / Microsoft 365 Education
- Canvas, Schoology, or other LMS platforms
- Raspberry Pi, Intel NUC, old PCs, and thin clients as edge devices
- State education department dashboards (future reference implementation)

## Contributing

We welcome contributions from:
- School district IT teams
- State education technology offices
- EdTech vendors
- Security researchers focused on K-12
- Open source contributors passionate about education equity

Please open issues or pull requests on the main EduOS repository.

## Roadmap (0.1 → 1.0)

- [ ] Reference Ignition configs with real examples
- [ ] Working bootstrap + enrollment services (containerized)
- [ ] Health telemetry pipeline + simple web dashboard
- [ ] Update orchestration with canary + policy engine
- [ ] Documentation site + video walkthroughs
- [ ] Hardware certification list (common classroom devices)
- [ ] Air-gapped / disconnected operation mode
- [ ] Full multi-architecture support (x86_64, aarch64)

## Contact & Community

- Matrix: #eduos:matrix.org (or your preferred chat)
- GitHub: https://github.com/eduos-project (placeholder)
- Mailing list: eduos-announce@lists.eduos.local

Thank you for helping build technology that serves students and teachers
without getting in their way.

— The EduOS Team

## New Additions (June 2026 iteration)

### Implemented Service Logic (scripts/)
All four core services now have working Bash (and Python where beneficial) implementations:

- `scripts/eduos-bootstrap.sh` — Machine identity, directory setup, district registration stub
- `scripts/eduos-enrollment.sh` — Local web enrollment portal (Python http.server) with form + JSON storage
- `scripts/eduos-health.sh` — Continuous metrics collection (CPU, memory, disk) + JSON reporting
- `scripts/eduos-update.sh` — Maintenance-window aware update orchestration with simple policy

These scripts are referenced by the systemd units. In a real build they should be included in the OS image (via rpm-ostree overlay or COSA).

### Expanded Ignition Configs
All six role-specific `.ign` files have been significantly improved with:
- Proper user definitions + GECOS + group membership
- Placeholder SSH authorized keys (replace before use)
- Role marker files and role-specific configuration
- Enabled EduOS systemd units
- Storage directories

Note: Full long script content is not embedded in the JSON (to keep files manageable). The production pattern is to bake `scripts/` into the base image.

### Supporting Configuration
- `configs/health.toml` — Telemetry collection policy, privacy controls, FERPA mode
- `configs/update-policy.toml` — Canary strategy, maintenance windows, automatic rollback rules

### Build Script
- `boot/build-iso.sh` — Helper to download Fedora CoreOS base and optionally embed Ignition configs (air-gapped friendly). Supports `--variant` and `--embed-ignition`.

### Recommended Next Steps (from user request)
- Generate full multi-page PDF architecture dossier with diagrams (using matplotlib + reportlab)
- Add more hardware targets (Raspberry Pi 5 / Compute Module, Intel NUC, old thin clients)
- Air-gapped mode documentation + offline enrollment workflow
- SIS/LMS integration examples (Canvas, PowerSchool, etc.)
- Quadlet / Podman container versions of the services for easier updates

Run `tree /home/workdir/artifacts/eduos` or explore the files to continue development.

## Modern Build Pipeline (Recommended for Production)

EduOS now supports the standard Fedora CoreOS build workflow using **Butane** + **rpm-ostree compose** + **coreos-installer iso customize**.

### Directories Added

- `butane/` — Human-friendly `.bu` configs (e.g. `teacher.bu`, `base.bu`)
- `compose/` — `eduos-tree.yaml` for custom OSTree composition

### Example Workflow

```bash
# 1. Generate Ignition from Butane (cleaner than raw JSON)
butane butane/teacher.bu > ignition/teacher.ign

# 2. (Advanced) Build custom OSTree layer
rpm-ostree compose tree --repo=repo compose/eduos-tree.yaml

# 3. Create customized ISO with embedded Ignition
coreos-installer iso customize \
  --dest-ignition ignition/teacher.ign \
  fedora-coreos-*.iso \
  -o eduos-teacher-0.2.0.iso
```

This approach is strongly preferred over the older `coreos-installer iso embed` method because:
- Butane configs are much more maintainable than raw Ignition JSON
- You can compose custom packages and files into the base image
- Better support for multi-role and air-gapped scenarios

See `boot/build-iso.sh` for more details and the full commented workflow.

## Makefile Automation

A `Makefile` has been added for convenience:

```bash
make help                 # Show available targets
make teacher.ign          # Generate ignition/teacher.ign
make iso-teacher          # Build boot/eduos-teacher-0.2.0.iso
make all-isos             # Build ISOs for all six roles
make clean
```

You can override variables:

```bash
make iso-student VERSION=0.3.0 BASE_ISO=~/Downloads/fedora-coreos-*.iso
```

## New Automation Features (Latest)

- `make iso-all` now builds all role ISOs
- `make iso-universal` builds one ISO with multiple Ignition configs embedded
- GitHub Actions workflow at `.github/workflows/build-eduos.yml`
- Example Butane config with Quadlet: `butane/edge-with-quadlet.bu`

See the Makefile for all available targets.

## Documentation

See `docs/BUILD.md` for the complete build guide, including:
- Local and CI workflows
- Architecture support (x86_64 / aarch64)
- Raspberry Pi 5 instructions
- Air-gapped builds
- Security recommendations

## District-Specific Overlays

See `overlays/district-example/` for a complete example (including Nashville ZIP code, branded MOTD, district policies, etc.).

Copy it and customize for your district.
