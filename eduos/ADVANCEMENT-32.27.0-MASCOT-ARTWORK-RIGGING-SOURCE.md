# EduOS 32.27.0 — Mascot Artwork & Rigging Source

## Delivered

- Added a bespoke, generic EduOS helper-character SVG with separately named SVG groups for Root, Head, Torso, Arm_L, Arm_R, Leg_L, Leg_R, and Accessories.
- Added accessible SVG title/description metadata.
- Replaced the Flutter icon-only fallback with the locally bundled mascot SVG through `flutter_svg`.
- Added a machine-readable Rive authoring contract with Root/Hip/spine/limb bone names, external Look_Target, parallel state-machine layers, inputs, expression blend duration, and blink timing.
- Updated Flutter and web release metadata to 32.27.0.
- Added regression tests for the artwork, rig contract, and Flutter fallback integration.

## Important boundary

The SVG is a static vector source/fallback, not a skeleton-rigged Rive animation. The JSON file is an authoring contract, not an executable Rive state machine. A designer must still import/rebuild the vector groups in Rive Editor, create the actual bones/constraints and parallel state machine, export `assets/branding/eduos_mascot.riv`, and test the exported file in the Flutter runtime. No `.riv` binary is fabricated or claimed to exist.

## Validation

- Focused Node regression suite: 13/13 passed.
- JavaScript syntax checks: passed.
- Flutter SDK build/analyze: not run; Flutter SDK is not installed in this environment.
- Physical-device frame rate, draw calls, and battery profile: not run.
