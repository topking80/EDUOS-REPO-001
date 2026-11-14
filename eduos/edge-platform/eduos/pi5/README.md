# EduOS on Raspberry Pi 5 / Compute Module 5

This directory contains boot configuration files and guidance for running EduOS Edge nodes on Raspberry Pi 5 hardware.

## Files

- `config.txt` — Hardware and overlay configuration for Pi 5
- `cmdline.txt` — Kernel command line with EduOS + Ignition arguments

## How to Prepare a Bootable USB / SD Card for Pi 5

1. Download or build a suitable aarch64 CoreOS / Fedora IoT base image for Raspberry Pi.
2. Partition the media with a small FAT32 boot partition + rootfs.
3. Copy the Pi firmware files (`start4.elf`, `fixup4.dat`, etc.) into the boot partition.
4. Copy `config.txt` and `cmdline.txt` from this directory into the boot partition.
5. (Optional but recommended) Embed or reference the `edge.ign` file.
6. Boot the Pi 5 from the media.

## Recommended Hardware Configurations

| Use Case              | Model          | RAM  | Storage          | Cooling          | Notes                              |
|-----------------------|----------------|------|------------------|------------------|------------------------------------|
| Classroom Edge Hub    | Pi 5 8GB       | 8GB  | NVMe or USB SSD  | Active (fan)     | Best balance                       |
| Low-cost / Lab        | Pi 5 4GB       | 4GB  | microSD or USB   | Passive or fan   | Acceptable for lighter workloads   |
| Embedded / Custom     | CM5            | 4/8GB| eMMC or NVMe     | Case-dependent   | For productized classroom devices  |

## Integration with EduOS

- Use the **edge** Ignition profile (`ignition/edge.ign`)
- The health service will automatically pick up temperature and other Pi-specific metrics
- Consider adding GPIO or sensor scripts later for physical classroom status (door sensors, projector status, etc.)

## Current Limitations (June 2026)

Official Fedora CoreOS aarch64 metal images for Raspberry Pi are still maturing. Many teams currently use:
- Community builds of Fedora CoreOS for ARM
- Fedora IoT as a base and layer EduOS components on top
- Custom rpm-ostree compositions

We are actively tracking upstream progress and will provide turnkey Pi 5 image recipes as soon as stable official images are available.

## Next Steps

- Automated script to assemble a complete Pi 5 boot media from a base image + these overlays
- Validation matrix for different Pi 5 RAM/storage/cooling combinations
- Example Quadlet + GPIO integration for physical classroom automation
