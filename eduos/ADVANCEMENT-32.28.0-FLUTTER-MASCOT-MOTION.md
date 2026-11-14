# EduOS 32.28.0 — Flutter Mascot Motion Fallback

## Delivered

- Added a lightweight Flutter-native animation fallback around the locally bundled EduOS SVG mascot.
- Idle uses a restrained breathing pulse; greeting adds a gentle wave-like tilt; celebration adds a short vertical bounce; help adds a subtle concerned tilt.
- Mood blends the mascot tile from the primary to accent brand color without altering the source artwork.
- Animation uses a single `AnimationController`, disposes it with the widget, and stops it when the app backgrounds.
- The authored Rive asset remains the preferred runtime; the animated SVG fallback is used only while Rive is unavailable or cannot be loaded.
- Added regression tests for action mapping, controller disposal/lifecycle handling, and mood styling.

## Validation

- Focused Node tests: run `node --test test/phase32-mascot-fallback-motion.test.js test/phase32-mascot-artwork.test.js test/flutter-branding-starter.test.js`.
- JavaScript syntax checks: run `find src public -type f -name '*.js' -print0 | xargs -0 -n1 node --check`.
- Flutter analyzer/device profiling: not run in this environment; verify with Flutter SDK on Android and iOS before release.
- Rive `.riv` binary is still an authored asset and is not fabricated by this release.
