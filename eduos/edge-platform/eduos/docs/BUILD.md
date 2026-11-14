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
| `make clean`       | Remove generated Ignition (contains password hashes) and build/ |
| `make check`       | Lint + compile all roles under --strict with throw-away credentials |
| `make credentials` | List the credentials each role needs             |

Variables:

```bash
make iso-teacher VERSION=0.3.0 BASE_ISO=~/Downloads/fedora-coreos.iso
```

## Security Recommendations

- Supply real password hashes and SSH keys at build time (see "32.0.54 build-time credentials")
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

## 32.0.53 build and provisioning notes

**Compiling Ignition.** Run `make ignition` (or `make <role>.ign`) from
`edge-platform/eduos`. Butane is invoked as `butane --strict -d .`, so every
`local:` path in `butane/*.bu` (for example `scripts/eduos-enrollment.py`,
`services/enrollment.service`) is relative to this directory, and role configs
merge the compiled `ignition/base.ign`. The `ignition/*.ign` files in this
package were regenerated from the current Butane sources with Butane 0.23.0;
the 32.0.52 copies were stale and the 32.0.52 Butane files did not compile.

**Enrollment intake (student, teacher, district roles).** The Ignition configs
now install `/usr/local/bin/eduos-enrollment.py` (32.0.52 installed only the
wrapper that execs it) and the systemd units from `services/` that the configs
enable but never defined. The token has one canonical location,
`/run/eduos/enrollment-token`: `eduos-bootstrap.sh` generates a fresh random
token there on every boot (root:eduos-enrollment, 0640), and the unit, the
Quadlet and the script default all read that path. The placeholder
`/etc/eduos/enrollment-token` that `student.bu` used to ship (never read by
anything) is gone, and the intake refuses tokens shorter than 32 characters or
containing `PLACEHOLDER`, `CHANGE`, `REPLACE` or `EXAMPLE`.

**Boot ISOs.** `boot/eduos-*-0.2.0.iso` in this package are **0-byte
placeholders**, not bootable images. Build real images with
`make iso-<role> BASE_ISO=/path/to/fedora-coreos.iso` (requires
`coreos-installer`) and verify them with `boot/verify-usb.sh` before flashing.

## 32.0.54 build-time credentials

`butane/*.bu` contain **no credentials**. Each account's password hash and SSH
keys are markers (`@@EDUOS_<ACCOUNT>_PASSWORD_HASH@@`,
`@@EDUOS_<ACCOUNT>_SSH_KEYS@@`). `make ignition` renders them through
`scripts/eduos-edge-config.py` into `build/<role>.bu` (mode 0600, deleted after
the build) and then compiles with `butane --strict`. The build **stops** when a
value is missing, malformed, or a known placeholder (`CHANGE_ME`, `REPLACE`,
`PLACEHOLDER`, `EXAMPLE`, `...`). The error names every missing credential.

List what each role needs with `make credentials`:

| Role | Credentials |
|------|-------------|
| admin | `EDUOS_ADMIN_PASSWORD_HASH`, `EDUOS_ADMIN_SSH_KEYS` |
| district / edge / state | `EDUOS_<ROLE>_PASSWORD_HASH` |
| teacher | `EDUOS_TEACHER_PASSWORD_HASH`, `EDUOS_TEACHER_SSH_KEYS` |
| student | `EDUOS_STUDENT_PASSWORD_HASH` (kiosk account), `EDUOS_STUDENT_DEVICE_ADMIN_PASSWORD_HASH`, `EDUOS_STUDENT_DEVICE_ADMIN_SSH_KEYS` (the `eduos-admin` account) |

Supply them as environment variables, or in a KEY=VALUE file **outside git**
named by `EDUOS_EDGE_SECRETS` (default `secrets/edge-credentials.env`, which is
git-ignored). Values are read literally, with no shell expansion. The build
refuses a secrets file that is tracked by git. For any key, `KEY_FILE=/path`
may be used instead. For `*_SSH_KEYS` that is an authorized_keys file;
alternatively give several keys in one value separated by `;`.

```sh
mkpasswd -m yescrypt            # or: openssl passwd -6
cat > ~/eduos-edge.env <<'ENV'
EDUOS_STUDENT_PASSWORD_HASH=$y$j9T$...
EDUOS_STUDENT_DEVICE_ADMIN_PASSWORD_HASH=$y$j9T$...
EDUOS_STUDENT_DEVICE_ADMIN_SSH_KEYS_FILE=/secure/it-admins.pub
ENV
chmod 600 ~/eduos-edge.env
make ignition EDUOS_EDGE_SECRETS=~/eduos-edge.env
```

The generated `ignition/*.ign` contain the password hashes. They are git-ignored
and written 0600; treat them as secrets. `make clean` removes them. `make check`
needs no secrets and is what CI runs: it lints the sources and compiles every
role under `--strict` with throw-away credentials. The CI workflow then builds
real Ignition from repository secrets with the same names.

**Kiosk account.** On student devices, `student` is in no group: no `wheel`, no
sudo and no SSH key. `/etc/polkit-1/rules.d/50-eduos-student-kiosk.rules` lets
it reboot, power off or suspend from its own active local session and denies
every other polkit action. The EduOS services run as system units and need
nothing from this account. Device administration uses the separate
`eduos-admin` account (wheel, SSH key, password for sudo).

**Lint.** `make lint` (also part of `make check` and `npm test`) fails on any
committed `password_hash` value or SSH public key in Butane/YAML sources, on a
shipped enrollment token, and on the `student` account holding wheel, sudo,
adm, root, docker, systemd-journal, disk or lp.
