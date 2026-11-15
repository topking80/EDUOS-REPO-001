# EDUOS 37.4.0 — Audit Addendum 4: Continuous Integration

**Branch:** `ci/eduos-tests` (PR #4)
**Date:** November 14, 2026

## F-10 — The project's CI never ran (fixed)
The release ships `ci.yml`, `dependency-update-validation.yml` and `dependabot.yml` under `eduos/.github/`, but GitHub only reads `.github/` at the repository root, so no check ran on any push or PR. All three files moved to the root with paths adjusted for `eduos/`; the jobs are the project's own. Two tests that pin `ci.yml`'s contents now locate it at the repository root.

## Findings from the first CI runs

| ID | Finding | Status |
|---|---|---|
| F-11 | **The Flutter app didn't compile.** `eduos_mascot.dart` used APIs that rive 0.13 (pinned `^0.13.20`) doesn't have: `RiveFile.dispose()`, and `findInput<T>` assigned to typed inputs. 9 analyzer errors, 2 warnings, plus `const` lints under `--fatal-infos`. | Fixed against rive 0.13.20's source |
| F-12 | **No Android project.** `mobile/flutter` ships Dart code only, so `flutter build apk` failed. | CI generates the Android scaffolding first (`flutter create --platforms=android`), after analyze and test |
| F-13 | **Test sends didn't update the screen.** After "Send test", the webhooks screen's Last delivery column didn't update; the browser e2e test waited for it. | A test now updates `last_delivery_at`/`last_outcome`, never `failure_count`/`status` |
| F-14 | **The security scanner couldn't start.** `trivy-action@0.28.0` doesn't exist, and v0.28.0 depends on a deleted `setup-trivy` tag. | Now on v0.36.0, pinned by commit SHA |
| F-16 | **10 HIGH CVEs in the production image**, all in the npm CLI bundled with `node:22-alpine` (brace-expansion, ip-address, pacote, picomatch, sigstore). App dependencies and Alpine packages were clean. | npm, npx, corepack and yarn removed from the final image; the runtime only uses `node`. No exception added. |
| F-15 | Trivy DS-0002 (HIGH): the edge agents `Containerfile.bootstrap`, `.health` and `.update` run as root. | **Accepted risk** (owner decision, 2026-11-14), see below |

**Final state: all 7 CI jobs pass.**

Clean on first run: gitleaks (no secrets); dependencies (0 HIGH/CRITICAL); unit; integration (real PostgreSQL); edge Python + butane; e2e (`make up` + `make smoke` + headless Chrome).

## Accepted risk: F-15
Recorded in `.trivyignore.yaml`. It covers only DS-0002, only these three files, and only the source scan. The same check still fails CI for any other Dockerfile or Containerfile, including the production app image, which runs as non-root.

- **Bootstrap:** needs root by design. It writes `/etc/eduos`, chowns host folders and starts systemd units.
- **Health, update:** **follow-up.** Run them as a dedicated non-root user (as `Containerfile.enrollment` already does). Bootstrap must create `/var/lib/eduos/health` and `/var/lib/eduos/updates` owned by that user, and the change must be tested on edge hardware before rollout. Then remove their entries from `.trivyignore.yaml`.

**Disposition:** Continue validation. Not production approval.
