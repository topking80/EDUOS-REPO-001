# EduOS 32.0.40 — Enrollment Security Hardening

## Fixed
- Removed unauthenticated enrollment form and arbitrary URL-encoded body storage.
- Enrollment intake now binds to loopback only; external TLS termination/reverse proxy is required and no public listener is configured.
- Requires a 384-bit per-boot random bearer token supplied through a protected runtime secret file; startup fails closed if missing/invalid.
- Uses constant-time token comparison, bounded JSON body, strict allow-listed fields and role validation.
- Rate-limits each source address and returns generic errors.
- Stores only a pending enrollment request using a random request ID, atomic exclusive file creation and restrictive permissions. It does not activate accounts/devices.
- Dedicated unprivileged service account, read-only container filesystem, dropped capabilities, no-new-privileges, PID limit and private writable queue.
- Quadlet port published only on 127.0.0.1; image tag is versioned, not `latest`.

## Operational requirements
- Provision a trusted TLS reverse proxy and restrict access to it; do not expose the loopback service directly.
- Protect `/run/eduos/enrollment-token` and rotate by restarting bootstrap/service. Never place token in logs, source control, image layers or client-side HTML.
- Add district identity-provider authentication, approval workflow, audit forwarding, persistent queue backup and mTLS device identity before production enrollment.
- Container image digest pinning and signed image verification must be added in release CI before production rollout.
- The enrollment service only stages requests; no user/device is automatically trusted or provisioned.
