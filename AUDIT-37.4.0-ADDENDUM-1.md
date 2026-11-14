# EDUOS 37.4.0 — Audit Addendum 1: Full-Suite Run Against Original Archive

**Covers outstanding items:** 1 (full-suite re-run), 10 (archive checksum), partial 2 (classification of failures)
**Date:** November 14, 2026
**Application code:** unchanged

## Source evidence

- Archive: `eduos-37.4.0-dns-retry-improvements.zip` (as committed in `fe61da6`)
- SHA-256: `b8ec38b58a99b44f177350e565ac77c8e0cc068c677d5d30f7d46e91ef58d583`
- `package.json` version: 37.4.0
- Runtime: Node.js v22.23.4, Linux; dependencies via `npm ci --ignore-scripts`
- Command: `node --test` (no environment variables set), from the extracted `eduos-37.4.0/` directory

## Result

| Tests | Pass | Fail | Skipped |
|---|---|---|---|
| 565 | 546 | 18 | 1 |

The full suite is **not green**. All 18 failures were inspected and classified below. Only one points to a release defect (F-1); the rest are test maintenance or test-harness issues.

## Failure classification

### F-1 — Missing `.env.example` (release packaging defect) — 1 failure
- `test/deploy-32053.test.js` fails at load: `ENOENT .env.example`.
- `.gitignore` explicitly un-ignores it (`!.env.example`), and other dotfiles (`.npmrc`, `.gitignore`, `.dockerignore`) are in the archive, so the omission isn't explained by dotfiles being stripped.
- Also absent from the 37.3.1 transfer kit archive.
- The test also checks that `.env.example` has one `TRUSTED_PROXY_IPS` matching the compose edge network, so the file has deployment significance.

### F-2 — Stale release-version / title assertions — 13 failures
These tests hardcode older releases (34.7.0, 35.0.0, 35.6.0, 35.8.0, 32.21.0 cache name, or an allow-list ending at 37.3.0). The application consistently reports 37.4.0 (package, page title, service worker `eduos-app-shell-37.4.0`).

- `arrival-handoff.test.js` — version allow-list stops at 37.3.0
- `attendance-accountability-34.9.test.js` — expects 35.6.0
- `morning-command-center-34.8.test.js` — expects 35.6.0
- `offline-node-32700.test.js` (service worker) — expects cache `eduos-app-shell-32.21.0`
- `phase27-integration.test.js` — expects title 34.7.0
- `phase31-integration.test.js` — expects title 34.7.0
- `phase32-arrival-demo-safety-gate.test.js` — expects 35.6.0
- `phase32-edge-hardening.test.js` — expects 35.6.0
- `pickup-accountability-35.0.test.js` — expects 35.6.0
- `product-consistency.test.js` — expects 35.0.0
- `reunification-manifest-35.1.test.js` — expects 35.6.0
- `sro-coordination-35.2.test.js` — expects 35.8.0
- `sro-role-35.3.test.js` — expects 35.8.0

Recommended fix (unchanged from the main report): compare against `package.json`, the lockfile, the app title and the service-worker cache name dynamically; keep every functional check.

### F-3 — Stale navigation assertion — 1 failure
- `offline-node-32700.test.js` (admin/IT screens) expects `it_admin: [["nodes", "Nodes", "server"]]` exactly.
- `public/app/app.js:131` now has `it_admin: [["nodes", "Nodes", "server"], ["library", "Library", "book"]]`, consistent with the librarian/library work in 36.x.
- The Nodes tab is still present. The assertion should check that it's included, not require an exact match.

### F-4 — Camera-policy conflict — 2 failures
- `learning-32600.test.js` and `safety-32500.test.js` assert the phone UI has no `getUserMedia`/geolocation. The app uses the camera for the barcode scanner.
- This needs a policy decision, not just a test edit: either document an approved camera exception (barcode scanner only, user-initiated, no frames retained or uploaded) and narrow the tests to it, or remove the camera use.

### F-5 — Test-harness environment dependency — 1 failure
- `security-tenant-context-33.2.test.js` fails at import: `Missing required environment variable: DATABASE_URL` (then `OIDC_ISSUER`, `OIDC_REDIRECT_URI`, …).
- Sibling tests (`phase33-session-cache`, `phase32-session-hardening`) set their own defaults with `process.env.X ||= …`; this file doesn't.
- With dummy values for the six required variables it passes **5/5**, matching the main report.
- Don't set these variables globally for the whole suite. That overrides the sibling tests' expected defaults and causes 5 extra failures in `phase33-session-cache` and `phase32-session-hardening` (for example "OIDC authorized-party mismatch"). Fix the file to set its own defaults like its siblings.

## Updated status of outstanding items

| # | Item | Status |
|---|---|---|
| 1 | Full suite against original archive | **Done**: 546/565 pass, 18 fail, all classified |
| 2 | Stale assertions and camera conflict | **Classified**: F-2/F-3 test maintenance; F-4 needs a policy decision |
| 10 | Archive checksum and environment | **Done** (above) |
| new | `.env.example` missing from release | **Open**: release packaging defect (F-1) |
| 3–9 | RLS grants, transport, replay, outbox, roles, production | Unchanged: open |

## Approved fixes applied (branch `fix/eduos-37.4.0-audit-findings`)

The 37.4.0 source is now in `eduos/`, unchanged, as a baseline commit. Each fix is a separate commit on top of it:

| Commit | Finding | Change |
|---|---|---|
| Import EDUOS 37.4.0 source unchanged as baseline | n/a | Archive extracted to `eduos/`, no edits |
| test: compare release metadata against package version… | F-2 | New `test/helpers/release.js`. 13 tests now check that package, lockfile, title, sidebar label and SW cache name all match `package.json` |
| test: require the IT Nodes tab… | F-3 | Asserts the Nodes tab is present, not the exact tab list |
| test: give tenant-context test its own inert config defaults | F-5 | `||=` defaults and a dynamic import of `db.js`. No DB connection |
| deploy: restore .env.example (reconstructed) | F-1 | Rebuilt from `config.js`, compose and README. **The original wasn't available; review before use** |

Verification:
- Changing the SW cache name to 37.3.0 makes the release-metadata check fail as expected.
- Removing the Nodes tab from `it_admin` makes F-3's test fail as expected.

Full suite with no environment variables after the fixes: **574 tests, 571 pass, 2 fail, 1 skipped.** The two remaining failures are F-4, the camera-policy conflict, which is waiting on a policy decision.

**Disposition:** Continue validation. Not production approval.
