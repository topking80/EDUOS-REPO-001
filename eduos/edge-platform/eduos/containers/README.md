# EduOS Container Images (Containerfiles)

This directory contains Containerfiles for building the four core EduOS services as OCI containers. These images are referenced by the Quadlet definitions in `../quadlet/`.

## Building the Images

From the repository root:

```bash
# Bootstrap
podman build -f containers/Containerfile.bootstrap \
    -t quay.io/eduos/eduos-bootstrap:latest .

# Enrollment (includes Python web server)
podman build -f containers/Containerfile.enrollment \
    -t quay.io/eduos/eduos-enrollment:latest .

# Health
podman build -f containers/Containerfile.health \
    -t quay.io/eduos/eduos-health:latest .

# Update
podman build -f containers/Containerfile.update \
    -t quay.io/eduos/eduos-update:latest .
```

## Pushing to a Registry

```bash
podman push quay.io/eduos/eduos-bootstrap:latest
podman push quay.io/eduos/eduos-enrollment:latest
# ... etc
```

For air-gapped or district-internal use, push to your own registry or save/load the images as tarballs.

## Design Notes

- Images are based on Fedora 40 for consistency with Fedora CoreOS.
- Minimal package sets to reduce attack surface and image size.
- Scripts are copied from `../scripts/` — keep them in sync.
- No secrets or sensitive data are baked into the images.
- Health and Update containers run as long-lived processes (daemons).
- Bootstrap is designed as a one-shot / oneshot-style container.

## Future Improvements

- Multi-stage builds to further reduce size
- Non-root user inside containers where possible
- Healthchecks in the Containerfiles
- Version pinning instead of `latest`
