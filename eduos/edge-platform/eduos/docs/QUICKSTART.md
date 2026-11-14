# EduOS Quickstart Guide for District IT Teams

**Goal**: Get EduOS running on a test machine in under 30 minutes.

## What is EduOS?

EduOS is a secure, immutable Linux-based operating system designed specifically for K-12 schools. It gives you:

- Role-based provisioning (Student, Teacher, Admin, Edge)
- Easy device enrollment by teachers
- Health monitoring and compliance reporting
- Policy-controlled updates with rollback
- Strong support for air-gapped and low-connectivity environments

## Step 1: Try It on a Test Machine (USB)

### Option A: Use a Pre-built ISO (Fastest)

1. Download the latest `eduos-universal-*.iso` from the GitHub Actions artifacts (or ask your state/district team for one).
2. Write it to a USB drive:
   ```bash
   sudo dd if=eduos-universal-0.2.0.iso of=/dev/sdX bs=4M status=progress
   ```
3. Boot a spare laptop or desktop from the USB.
4. At first boot, the system will use a default role (or you can pass `ignition.config.url`).

### Option B: Build Your Own (Recommended for Evaluation)

On a Linux machine with `butane` and `coreos-installer` installed:

```bash
git clone https://github.com/eduos-project/eduos.git
cd eduos
make all-isos VERSION=0.2.0
```

Then write one of the generated ISOs from the `boot/` directory to USB.

## Step 2: Customize for Your District

1. Copy `butane/teacher.bu` (or another role) to `butane/my-district-teacher.bu`
2. Edit the file:
   - Keep the `@@...@@` credential markers; supply real password hashes and SSH
     keys at build time (`docs/BUILD.md`, "32.0.54 build-time credentials")
   - Update `management-url`
   - Adjust `health.toml` and `update-policy.toml` in `configs/`
3. Regenerate:
   ```bash
   make my-district-teacher.ign
   make iso-teacher
   ```

See `overlays/district-example/` for a sample district overlay you can copy and modify.

## Step 3: Enroll Devices

Once a machine is running EduOS:

- The **enrollment service** runs a local web UI on port 8080
- Teachers can open `http://<device-ip>:8080` to enroll new student devices or users
- Enrollments are stored locally and can sync to your district control plane later

## Step 4: Next Steps

| Goal                              | Recommended Action                              |
|-----------------------------------|-------------------------------------------------|
| Test in a classroom               | Use `edge.bu` on a Raspberry Pi 5 or NUC        |
| Centralized management            | Deploy `district.bu` on a server/VM             |
| Air-gapped environment            | Use `make iso-universal` + USB distribution     |
| Integrate with existing SIS       | See `docs/INTEGRATION_EXAMPLES.md`              |
| Production rollout                | Read `docs/BUILD.md` and customize policies     |

## Common Customizations

- Change default passwords and SSH keys (critical)
- Set your district's maintenance window in `update-policy.toml`
- Add your logo / MOTD in a district overlay
- Configure health reporting endpoint

## Getting Help

- Full documentation: `docs/BUILD.md`
- Integration examples: `docs/INTEGRATION_EXAMPLES.md`
- Raspberry Pi 5: `pi5/README.md`
- Air-gapped guide: `docs/AIR_GAPPED_DEPLOYMENT.md`

EduOS is designed to be customized by district IT teams. Start small, test thoroughly, and scale what works.

Welcome to EduOS.

## Creating the USB Drive (Recommended Method)

After building an ISO, use the helper script:

```bash
./boot/make-usb.sh boot/eduos-universal-0.2.0.iso /dev/sdb
```

This script includes safety checks and clear warnings before writing.
