# EduOS 32.27.0 — Flutter School Branding & Mascot Runtime

## Delivered

- Added an isolated `mobile/flutter` starter package.
- Added centralized, overridable school-brand theme tokens.
- Added a local-bundle Rive loader with artboard/state-machine contract names.
- Added semantic action triggers for Wave, Celebrate, and Help.
- Added mood and two-axis eye-tracking numeric inputs with clamping.
- Added app lifecycle pause/resume using the Rive artboard API.
- Added a branded Flutter fallback when the approved `.riv` asset is absent.
- Added an authoring/rigging handoff for the requested six art groups, Root/Hip
  hierarchy, Look_Target, and four parallel state-machine layers.

## Important boundaries

No `.riv` asset was provided, so the runtime asset itself has not been authored,
rigged, or validated. The package deliberately does not include a fabricated
binary. The sample's fallback is functional until the approved artboard is added.
The browser app is unchanged functionally; this is a new Flutter integration
starter alongside it. The Flutter SDK is not installed in this environment, so
`flutter pub get`, analyzer, widget tests, Android/iOS builds, and physical-device
GPU profiling could not be executed here.

The Rive package is pinned to `^0.13.20` to match the requested `SMITrigger` and
`SMINumber` API. Upgrading to Rive 0.14 requires migration to the newer runtime
and must not be treated as a dependency-only update.

## Verification performed

- Node source/version contract test added and run.
- JavaScript syntax checks run for the existing web application.
- Release ZIP integrity checked.
- Flutter compile/runtime/device performance remain unverified.

## Final test results

- Focused release suite: **22/22 passed**.
- Existing web JavaScript syntax check: **passed** (zero syntax errors).
- Full Node suite: **359 passed, 24 failed, 1 skipped** (384 total). The failures
  include missing runtime dependencies in this workspace (`express`, `jose`,
  `pg`, and related integration imports); they are not represented as passing.
- Flutter validation: **not run** because neither `flutter` nor `dart` is
  installed in the build environment. The Rive asset is intentionally absent.

Rive's current stable package is 0.14.11; this starter intentionally pins the
last 0.13.20 legacy runtime for the named SMI input API. The newer runtime
requires a planned migration rather than a blind package bump.
