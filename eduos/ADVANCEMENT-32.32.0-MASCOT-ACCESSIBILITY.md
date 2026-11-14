# EduOS 32.32.0 — Mascot accessibility and motion preferences

## Delivered
- Honors the operating-system/app `MediaQuery` reduced-motion preference.
- Uses a static mascot rendering when reduced motion is enabled.
- Pauses both Rive and fallback animation when reduced motion is enabled or the app is backgrounded.
- Resumes animation only when the app is foregrounded and motion is permitted.
- Adds a single accessible mascot label and excludes duplicate internal Rive semantics.

## Validation
- Node regression tests cover the Dart source contract.
- Dart formatting, `flutter analyze`, Flutter tests, and Android/iOS builds require Flutter SDK and must run in the Flutter CI job; not claimed as locally executed.
- This does not create a compiled `.riv` asset. The existing SVG remains the bundled fallback.
