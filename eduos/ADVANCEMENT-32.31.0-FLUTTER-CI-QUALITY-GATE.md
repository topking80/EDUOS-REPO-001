# EduOS 32.31.0 — Flutter CI Quality Gate

## Purpose

The mascot and Flutter branding work previously had Dart tests but no repository CI job that executed them. This release adds an automated mobile quality gate instead of treating unexecuted Dart tests as verified.

## CI job

`.github/workflows/ci.yml` now includes `flutter-mobile`, pinned to Flutter 3.24.5 for a repeatable baseline. On pushes and pull requests it:

1. Resolves packages in `mobile/flutter`.
2. Runs `flutter analyze --fatal-infos`.
3. Runs `flutter test --reporter expanded`.
4. Compiles an Android debug APK.

The existing Node, PostgreSQL integration, edge, and full-stack jobs remain in place.

## Verification in this environment

- Node CI-contract test: run locally and report outcome in release notes.
- JavaScript syntax: run locally.
- Flutter SDK: unavailable locally; Dart analysis, Flutter tests, and APK compilation are delegated to the new CI job and are **not claimed as passed** here.
- This job compiles Android debug only; iOS signing/build and physical-device performance still require macOS/device validation.

## Release boundary

This is build/test automation, not a claim that a compiled mobile release has passed. The Rive `.riv` authoring asset remains a separate deliverable; the local SVG/fallback remains the available mascot artwork.
