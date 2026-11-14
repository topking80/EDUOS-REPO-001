# EduOS — Educational Operating System

**Phase 1 Monorepo** (June 2026)

EduOS is a secure, immutable, container-native Linux distribution purpose-built for K-12 and higher education environments.

It combines the strengths of Fedora CoreOS (immutability + declarative provisioning) with education-specific services for enrollment, health telemetry, policy-driven updates, and strong privacy/compliance controls.

---

## Phase 1 Deliverables

This repository represents the complete **Phase 1** foundation:

- ✅ All six role-based Ignition configurations (via Butane)
- ✅ Core services (Bootstrap, Enrollment, Health, Update)
- ✅ Quadlet + traditional systemd support
- ✅ Container build files
- ✅ Raspberry Pi 5 / Edge node support
- ✅ Full build automation (Makefile + GitHub Actions)
- ✅ Air-gapped deployment support
- ✅ District overlay examples
- ✅ Professional documentation

---

## Quick Start

```bash
# Build all ISOs
make all-isos VERSION=0.2.0

# Create a bootable USB
make usb DEVICE=/dev/sdb
```

See [docs/QUICKSTART.md](docs/QUICKSTART.md) for district IT teams.

---

## Repository Structure

```
eduos/
├── .github/workflows/          # CI/CD (matrix builds + cosign signing)
├── boot/                       # ISO building + USB creation tools
├── butane/                     # Human-readable configs (all 6 roles + overlays)
├── compose/                    # rpm-ostree treefiles
├── configs/                    # TOML policy files (health, updates)
├── containers/                 # Containerfiles for core services
├── docs/                       # Documentation (BUILD.md, QUICKSTART.md, etc.)
├── overlays/                   # District-specific customizations
├── pi5/                        # Raspberry Pi 5 boot overlays
├── quadlet/                    # Podman Quadlet definitions
├── scripts/                    # Service implementation scripts
├── services/                   # Traditional systemd unit files
├── ignition/                   # Generated .ign files (gitignored in real use)
├── Makefile                    # Main build automation
└── README.md
```

---

## Key Features (Phase 1)

| Area                    | Status      | Notes |
|-------------------------|-------------|-------|
| Role-based provisioning | Complete    | Student, Teacher, Admin, Edge, District, State |
| Build system            | Advanced    | Butane + Makefile + GitHub Actions + cosign |
| Container support       | Complete    | Quadlet + Containerfiles |
| Raspberry Pi 5          | Supported   | Edge node focused |
| Air-gapped              | First-class | Universal ISO + USB workflows |
| Documentation           | Strong      | BUILD.md, QUICKSTART.md, Integration guides |
| District customization  | Supported   | `overlays/district-example/` |

---

## Documentation

| Document                    | Audience                  | Purpose |
|----------------------------|---------------------------|--------|
| [docs/QUICKSTART.md](docs/QUICKSTART.md)     | District IT teams        | Fastest way to try EduOS |
| [docs/BUILD.md](docs/BUILD.md)               | Developers & DevOps      | Full build instructions |
| [docs/INTEGRATION_EXAMPLES.md](docs/INTEGRATION_EXAMPLES.md) | Architects | SIS/LMS integration patterns |
| [pi5/README.md](pi5/README.md)               | Edge deployment teams    | Raspberry Pi 5 guidance |
| [docs/AIR_GAPPED_DEPLOYMENT.md](docs/AIR_GAPPED_DEPLOYMENT.md) | Security teams | Disconnected operation |

---

## Building

```bash
# Generate Ignition configs
make teacher.ign student.ign edge.ign

# Build all role ISOs
make all-isos VERSION=0.2.0

# Build universal ISO (multiple Ignition configs embedded)
make iso-universal

# Build container images
make containers
```

See [docs/BUILD.md](docs/BUILD.md) for complete instructions.

---

## Phase 1 → Phase 2 Roadmap (High Level)

- Full aarch64 / Raspberry Pi 5 production images
- District control plane reference implementation (web dashboard)
- Enhanced SIS/LMS integrations
- Hardware certification program
- Production-grade certificate management (SPIRE)
- Community contribution process

---

## License

Apache 2.0 (or your chosen open source license for education projects)

---

**EduOS Phase 1** — Building the foundation for secure, manageable, and privacy-respecting educational technology infrastructure.

## USB Creation (Recommended)

```bash
# Write a single USB
make usb DEVICE=/dev/sdb

# Write + verify
make usb DEVICE=/dev/sdb
make verify-usb DEVICE=/dev/sdb

# Download from URL and flash
make flash-url URL=https://downloads.eduos.org/eduos-core.iso DEVICE=/dev/sdb

# Write multiple devices (school + district + state)
make usb-all
```

## Interactive Demo

A beautiful real-time runtime simulation is available at:

**`demo/runtime.html`**

It demonstrates:
- Role-based interfaces (Admin, Teacher, Student, Parent)
- Event-driven architecture (Student → Event Bus → others)
- Live attendance updates
- Emergency lockdown mode

Open it in a browser to see EduOS in action.

## Enhanced Runtime Demo (v27+)

**Location:** `demo/runtime.html`

### New in this version:
- **5 reactive students** in the Student portal
- Clicking a student reveals a full action chain
- Realistic event simulation (live attendance, bus updates)
- WebSocket-style event bus simulation
- Much more polished and production-like UI

Open it locally to explore the full interactive experience.

## Companion app demo

`demo/eduos_app.html` — the unified EdOS multi-persona companion app (Student, Teacher,
Guardian, Administrator, Resource Officer, Bus Driver). Single self-contained file with
animated charts, role-accent theming, Christie/Edison/Leo AI surfaces, and EDAL/DECN
platform notes. Open directly in a browser.
