# EduOS Edge Runtime — Integration and Security Review

## Source bundle incorporated
The uploaded `eduos-full-project.zip` has been preserved under `platform/edge-runtime-reference/`. Relevant operator documentation is published read-only under `public/eduos-edge-docs/`. The main application now includes a Device & Edge Operations workspace, accessible to the Superintendent and Principal demo personas, and Vision Studio deployment concepts route into it.

## Capabilities represented
- Butane/Ignition role profiles: student, teacher, admin, district, edge and state.
- Fedora CoreOS / rpm-ostree build and ISO customization workflow.
- Podman containers and Quadlet/systemd service definitions for bootstrap, enrollment, health and update agents.
- USB creation and verification scripts.
- Offline/air-gapped deployment patterns and local cache concepts.
- Raspberry Pi 5 / CM5 ARM64 edge path, explicitly experimental in the supplied documentation.
- SIS/LMS integration examples, which are conceptual patterns rather than live vendor connectors.

## Security findings — do not deploy the supplied enrollment server as-is
1. `scripts/eduos-enrollment.sh` starts a Python HTTP server bound to `0.0.0.0:8080` with no authentication, TLS, CSRF protection, request schema validation, or rate limiting.
2. POST body length is trusted directly; raw form content is written to disk without field validation, and timestamp-only filenames can collide.
3. The enrollment page interpolates the role into HTML without output encoding.
4. `scripts/eduos-update.sh` is a simulation. It removes a `pending-update` marker but does not verify a signed manifest, digest, source, rollout eligibility, perform an actual OS update, or execute rollback. The parsed canary percentage is not used for selection.
5. `scripts/eduos-health.sh` writes local telemetry only; the central mTLS upload is commented out. CPU calculation is a sample from `/proc/stat`, not a time-delta utilization measure.
6. `scripts/eduos-bootstrap.sh` uses `/etc/machine-id` as its machine identity and describes certificate issuance as simulated. Cloned images may require unique identity provisioning and a trusted enrollment flow.
7. The Makefile's universal ISO target uses `|| true`, which can mask a failed image build. The ISO wrapper downloads a mutable `latest` base image without a pinned checksum/signature verification step.
8. The district overlay example includes a named district in documentation. Treat it as unapproved sample content and replace it with a neutral district placeholder before reuse.
9. Quadlet documentation allows enrollment port 8080 publication by default; avoid exposing it outside a restricted lab until replaced with an authenticated service.
10. Pi 5 support is documented as experimental and depends on compatible ARM image, firmware and bootloader work. Hardware validation is still required.

## Integration boundary
The new Device & Edge Operations page is a product/demo workspace and operator guide. Fleet numbers are synthetic, checklist state is browser-local, and mode selectors are simulations. No device agent, central telemetry collector, real update service, ISO build pipeline, SIS vendor connector, or Pi fleet is activated by this integration.

## Required gates before pilot
- Replace prototype enrollment with authenticated device identity and server-side authorization.
- Implement TLS/mTLS with managed certificates and revocation.
- Validate all enrollment payloads and protect against CSRF, replay, oversized requests and duplicate IDs.
- Sign and verify image/container/update artifacts; pin base images and dependencies.
- Implement canary cohort selection, health gates, human approval, rollback and audit.
- Use hardware-backed machine identity where available and verify clone/reimage behavior.
- Test role profiles, USB integrity, air-gap update flow and recovery on actual hardware.
- Complete threat model, privacy review, operational runbooks and district change approval.

## Validation limitations
Static source review and application syntax checks do not establish production safety. No hardware, bootable ISO, Podman runtime, Fedora CoreOS build environment, district control plane, or physical Raspberry Pi test was available in this integration environment.
