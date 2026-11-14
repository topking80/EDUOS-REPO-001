# EduOS Build Guide

This document explains how to build EduOS images using the modern Fedora CoreOS toolchain.

## Prerequisites

### Local Development

You need the following tools:

- `butane` (for converting `.bu` → `.ign`)
- `coreos-installer`
- `make`
- (Optional but recommended) `coreos-assembler` (COSA) for full rpm-ostree composition

On Fedora:

```bash
sudo dnf install -y butane coreos-installer make
```

### In GitHub Actions

The workflow uses the official `quay.io/coreos-assembler/coreos-assembler` container, which includes everything needed.

## Quick Start

```bash
# 1. Generate Ignition config
make teacher.ign

# 2. Build a customized ISO
make iso-teacher

# 3. Build all role ISOs
make all-isos

# 4. Build a universal ISO with multiple Ignition configs embedded
make iso-universal
```

## Directory Structure

| Directory     | Purpose                                      |
|---------------|----------------------------------------------|
| `butane/`     | Human-readable Butane configs (`.bu`)        |
| `compose/`    | rpm-ostree treefiles (`eduos-tree.yaml`)     |
| `ignition/`   | Generated Ignition JSON files (`.ign`)       |
| `boot/`       | Output ISOs                                  |
| `scripts/`    | EduOS service implementation scripts         |
| `quadlet/`    | Podman Quadlet container definitions         |
| `pi5/`        | Raspberry Pi 5 boot overlays                 |

## Building for Different Roles

Each role has its own Butane file:

```bash
make student.ign
make admin.ign
make edge.ign
make district.ign
make state.ign
```

## Architecture Support (x86_64 vs aarch64)

The Makefile and GitHub Actions support specifying architecture:

```bash
make iso-edge ARCH=aarch64
```

**Note:** Full aarch64 ISO builds require an aarch64 base Fedora CoreOS image and a compatible `coreos-installer`. Raspberry Pi 5 support is currently experimental (see `pi5/README.md`).

## Raspberry Pi 5 / CM5

See `pi5/README.md` for hardware-specific instructions.

Recommended flow for Pi 5 Edge nodes:

1. Use `butane/edge.bu` (or `edge-with-quadlet.bu`)
2. Prepare boot media using files from `pi5/`
3. Flash to SD card / NVMe

## Air-Gapped Builds

1. Generate the desired `.ign` file(s)
2. Use `coreos-installer iso customize --dest-ignition ...` on a machine with the base ISO
3. Transfer the resulting ISO via USB

The `make iso-universal` target is particularly useful for air-gapped environments.

## Continuous Integration

EduOS uses GitHub Actions (`.github/workflows/build-eduos.yml`):

- Matrix build across all roles
- Automatic artifact upload
- Support for manual dispatch with custom version and architecture
- Placeholder for cosign signing (can be enabled with OIDC)

## Advanced: Custom OSTree Composition

If you want to bake packages and files directly into the base image (instead of delivering everything via Ignition):

```bash
rpm-ostree compose tree --repo=repo compose/eduos-tree.yaml
```

This produces a custom OSTree commit that can be used as the base for ISOs.

## Makefile Reference

| Target             | Description                                      |
|--------------------|--------------------------------------------------|
| `make help`        | Show available targets                           |
| `make <role>.ign`  | Generate Ignition JSON for a role                |
| `make iso-<role>`  | Build ISO for a specific role                    |
| `make all-isos`    | Build ISOs for all six roles                     |
| `make iso-universal` | Build one ISO with multiple Ignition configs   |
| `make clean`       | Remove generated Ignition and ISO files          |

Variables:

```bash
make iso-teacher VERSION=0.3.0 BASE_ISO=~/Downloads/fedora-coreos.iso
```

## Security Recommendations

- Replace all placeholder `password_hash` and SSH keys before production use
- Consider signing ISOs with `cosign` or GPG
- Use private registries or pre-pulled images when using Quadlet
- Audit the final Ignition JSON before deploying at scale

## Troubleshooting

**Butane errors:**
- Check YAML indentation
- Ensure `local:` paths are correct relative to the `.bu` file

**ISO customization fails:**
- Make sure you have a valid Fedora CoreOS base ISO
- `coreos-installer` version should be reasonably recent

**Raspberry Pi 5 issues:**
- See `pi5/README.md` for current limitations

---

For questions or contributions, open an issue in the EduOS repository.
