# EduOS Quadlet / Podman Container Definitions

This directory contains Quadlet unit files for running the EduOS core services as rootless or rootful Podman containers on Fedora CoreOS / RHEL CoreOS derivatives.

## Why Quadlet?

Quadlet is the modern, declarative way to run containers under systemd on immutable operating systems. Instead of writing complex systemd unit files that call `podman run`, you write simple `.container` files and systemd generates the real units automatically.

Benefits:
- Much simpler and less error-prone than raw systemd + podman-run units
- Automatic dependency management and restart behavior
- Clean integration with `systemctl` (the generated units appear as normal services)
- Better security defaults and resource limits

## How to Use

1. Copy the `.container` files to `/etc/containers/systemd/` on the target system (or bake them into your OS image during build).
2. Run `systemctl daemon-reload`
3. Enable and start the services:
   ```bash
   systemctl enable --now eduos-bootstrap eduos-enrollment eduos-health eduos-update
   ```

## Image References

The Quadlet files reference images under `quay.io/eduos/...`. These are placeholders. In a real deployment you would:

- Build your own images from the scripts in `../scripts/`
- Or use a district-internal registry
- Or embed the logic directly if you prefer systemd units over containers for the control plane

## Volume & Configuration Notes

- All services expect `/etc/eduos/` and `/var/lib/eduos/` to exist (created by bootstrap or Ignition)
- Configuration TOML files are mounted read-only where appropriate
- The enrollment service publishes port 8080 by default

## Migration from Systemd Units

The original `.service` files in `../services/` remain fully functional and are simpler for many districts to start with. Quadlet is recommended when you want the full power of Podman (image updates, rootless where possible, better isolation).

You can run both side-by-side during transition.

## Using Quadlet with Butane / Ignition

Instead of (or in addition to) baking Quadlet files into the OS image via `rpm-ostree`, you can deliver them at first boot using Butane:

Example in your `.bu` file:

```yaml
storage:
  files:
    - path: /etc/containers/systemd/eduos-health.container
      mode: 0644
      contents:
        local: ../../quadlet/eduos-health.container
```

Then enable the generated systemd unit (e.g. `eduos-health.service`) in the `systemd.units` section.

See `butane/edge-with-quadlet.bu` for a full working example.
