# EduOS on Raspberry Pi 5 / Compute Module 5

**Status**: Experimental but promising. Raspberry Pi 5 is an excellent low-cost Edge and classroom hub platform.

## Why Raspberry Pi 5?

- Excellent price/performance (especially CM5 for embedded products)
- Good I/O (PCIe, dual HDMI, multiple USB3, GPIO)
- Low power consumption — suitable for always-on edge nodes
- Strong community and industrial support (CM5)
- 64-bit only (aarch64) — matches modern CoreOS expectations

## Current Limitations

- Fedora CoreOS does **not** currently provide official aarch64 ISOs or metal images for Raspberry Pi (as of mid-2026).
- You must use one of the following approaches:
  1. Custom rpm-ostree compose with Fedora CoreOS aarch64 packages + Raspberry Pi firmware
  2. Use an existing community project (e.g., fedora-coreos-pi or similar forks)
  3. Start from Raspberry Pi OS Lite and layer CoreOS-style immutability (more work)

## Recommended Path (2026)

Use the **Fedora IoT** or **Fedora CoreOS for ARM** community efforts and adapt the EduOS Ignition + scripts on top.

### Boot Process on Pi 5

Pi 5 uses:
- `config.txt` and `cmdline.txt` in the boot partition (FAT32)
- `start4.elf` / `fixup4.dat` firmware files
- Device tree overlays for PCIe, fan, etc.

For CoreOS-style systems you typically:
1. Create a custom boot partition with the above files + `ignition.firstboot` marker
2. Use `coreos-installer` or a custom installer that understands Pi partitioning
3. Embed Ignition via kernel command line or a special file on the boot partition

## EduOS-Specific Recommendations for Pi 5 (Edge Role)

```bash
# Example kernel arguments to add for Pi 5 Edge nodes
ignition.config.url=https://district.eduos.local/ignition/edge.ign
rd.neednet=1
console=serial0,115200 console=tty1
```

### Hardware-Specific Ignition Additions (edge.ign for Pi)

Add to the `storage.files` section:

```json
{
  "path": "/boot/config.txt",
  "mode": 420,
  "contents": {
    "source": "data:,# EduOS Pi 5 Edge config\narm_boost=1\ndtoverlay=vc4-kms-v3d\n"
  }
}
```

### Power & Thermal Considerations

- Use a good 27W+ USB-C PD supply
- For CM5 in a metal case, add active cooling
- The health service already monitors temperature — useful for Pi deployments

## Testing Status

As of June 2026, EduOS on Pi 5 has been tested in QEMU aarch64 emulation and on real Pi 5 hardware using a community CoreOS aarch64 build. Full upstream support is still maturing.

## Next Steps for Pi 5 Support

- Contribute aarch64 image build recipes to the EduOS repo
- Create a `pi5/` directory with firmware + boot overlay files
- Validate full Ignition + service stack on real hardware
