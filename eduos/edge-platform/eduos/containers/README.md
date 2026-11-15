# EduOS edge container images

Three images, referenced by the Quadlet definitions in `../quadlet/`. Build
them from `edge-platform/eduos` (CI builds and vulnerability-scans all three
on every change):

```bash
podman build -f containers/Containerfile.bootstrap  -t quay.io/eduos/eduos-bootstrap:latest .
podman build -f containers/Containerfile.enrollment -t quay.io/eduos/eduos-enrollment:latest .
podman build -f containers/Containerfile.health     -t quay.io/eduos/eduos-health:2.0.0 .
```

For air-gapped or district-internal use, push to your own registry or
save/load the images as tarballs (`make containers`).

## Design notes

- **Base image:** every image builds `FROM` the image named in `BASE_IMAGE`
  (Fedora 45, supported until 2027-12-08). A repository test fails if a
  Containerfile uses anything else, and 30 days before that end of life.
- **Users:** enrollment runs as uid 10001 and health as uid 10003 (the same
  `eduos-health` user the host has, so host folders and the device token
  line up). Only bootstrap runs as root, because it provisions the node.
- **No update image:** `eduos-update` runs on the host (`services/update.*`),
  because it configures the OS updater and can roll the OS back. See
  `../docs/UPDATES-AND-HEALTH.md`.
- No secrets or sensitive data are baked into the images.
