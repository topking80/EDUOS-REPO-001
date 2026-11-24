# EduOS client platforms — current implementation and release gates

Last reconciled against `main`: November 24, 2026.

This document describes what is present in the repository now, what CI verifies,
and what still requires external credentials or physical-device validation. A
source directory or successful cross-platform unit test is not evidence that a
store-ready binary has been built, signed, or certified on that platform.

## 1. Current platform inventory

| Platform | Implementation on main | Automated validation | Release status |
|---|---|---|---|
| Android phones and tablets | Flutter app in `eduos/mobile/flutter/android/`; native role screens, responsive layouts and Time Capsule/history features | Required `flutter-mobile` job: dependency lock, analyzer, Flutter tests and Android debug APK build | Release signing, store listing and device certification remain |
| Android TV / Google TV | Same Android application package, leanback launcher support, remote/focus layout, view-only TV experience and device-code sign-in | Covered by Flutter analyzer/tests and Android APK build; no TV hardware in CI | Physical remote/focus and Play TV listing validation remain |
| Amazon Fire tablets / Fire TV | Android-compatible build; Amazon store selection uses `EDUOS_STORE=amazon`; TV mode uses device sign-in | Same Flutter/Android CI path; no Fire hardware in CI | Fire OS/device testing and Amazon Appstore submission remain |
| iOS / iPadOS | Flutter `ios/` project, bundle identifier `org.eduos.app`, URL scheme for native sign-in; tablet layout uses the responsive shell | Dart analyzer and Flutter tests run in Linux CI; no Xcode build is run | Requires macOS/Xcode build, signing/provisioning, physical-device testing and App Store Connect release |
| Windows desktop | Flutter `windows/` runner and device-code sign-in | Dart analyzer and Flutter tests run in Linux CI; native Windows compilation is not part of required CI | Manual MSIX workflow exists; first verified Windows build, production signing/store identity and device testing remain |
| Roku | Separate BrightScript/SceneGraph channel in `eduos/clients/roku/`; device-code sign-in; read-only family history and Time Capsule views | `roku-channel` CI job runs BrightScript lint and packages a ZIP artifact | No physical Roku validation; real channel artwork, developer account and publishing remain |

### Flutter capabilities

The Flutter app includes role-aware navigation, parent and family workflows,
student learning and history experiences, staff and school-leader workflows,
and SafetyOS views. Time Capsule and student-history screens include capsule
creation/detail, invitations, portfolio/timeline, family contributions,
teacher submissions and review, sharing, transfer flows, and photo viewing.
The family storage and preservation-related web experiences are separately
implemented in the server/web application; do not assume every web workflow
has a native Flutter screen.

The responsive shell uses the compact bottom navigation on narrower screens
and a navigation rail on wider screens. TV mode applies remote-friendly focus
and hides sensitive or operational workflows. TV and Roku device sessions are
read-only on the server; Windows device sessions are full sessions.

### Device sign-in and shared screens

The device authorization flow is implemented in the server and clients:
`POST /auth/device/code`, `POST /auth/device/token`, and authenticated
approval/denial routes. Codes are short-lived and single-use; approval is
audited and the approving membership is revalidated when the device redeems
its code. Device sign-in is **disabled by default** and requires district
configuration with `DEVICE_SIGN_IN_ENABLED=true`.

TV and Roku sessions are read-only. The optional local screen-lock PIN is a
shared-screen privacy measure, not a substitute for signing out or for
district identity-provider controls. Test the lock, sign-out and account
switching behavior on the actual target hardware before deployment.

## 2. CI and branch protection

The active default-branch ruleset currently requires these eight CI status
checks:

- `unit`
- `integration`
- `e2e`
- `edge`
- `flutter-mobile`
- `dependency-security`
- `source-and-container-security`
- `prometheus-rules`

The ruleset also enables CodeQL code-scanning enforcement, blocks branch
deletion and force-pushes, and requires pull requests. The current workflow
contains a ninth CI job, `roku-channel`, which runs BrightScript lint and
builds the Roku ZIP. **That job is not currently a required status check.**
The repository's ruleset must be updated by an administrator to add the exact
status context `roku-channel`; a green optional job does not block a merge if
it later fails.

The Windows MSIX workflow at
`.github/workflows/windows-msix.yml` is manual-only
(`workflow_dispatch`). It is not a required PR check and does not publish
packages. The iOS project has no macOS/Xcode build workflow. Linux Flutter
analysis and widget tests are useful shared-code checks, but do not validate
native iOS signing, Windows compilation, TV remote behavior, Fire OS behavior,
or Roku runtime compatibility.

## 3. Release and certification gates

### Android / Google Play

- Configure production application signing and Play App Signing.
- Supply production app icon, TV banner and store listing assets.
- Build a release APK/AAB from the production configuration.
- Validate installation, upgrade, deep links, device sign-in, offline behavior,
  media playback/viewing, accessibility and role-specific navigation on
  supported physical phones, tablets and TV devices.
- Verify Play Console declarations, privacy disclosures and target-device
  compatibility.

### Amazon Fire OS / Appstore

- Validate the Amazon build on Fire tablets and Fire TV hardware.
- Confirm the selected Amazon build does not depend on unavailable Google Play
  services; validate the actual distribution package and store requirements.
- Supply Fire TV artwork, listing metadata and developer-account details.
- Configure Amazon-specific push delivery only if/when that capability is
  implemented and approved; do not treat the current in-app notification
  behavior as ADM integration.

### iOS / App Store

- Run `flutter build ios` on a supported macOS/Xcode runner.
- Configure Apple Developer team, bundle signing, provisioning profiles and
  App Store Connect app record.
- Validate URL-scheme callback, system-browser authentication, secure token
  storage, camera/photo permissions where applicable, background/resume,
  accessibility and iPad layouts on physical devices.
- Produce and verify a signed release archive before submission.

### Windows / Microsoft Store or sideload

- Run `.github/workflows/windows-msix.yml` on Windows and retain the build
  logs and MSIX artifact as release evidence.
- For sideload distribution, configure a trusted production certificate using
  `WINDOWS_CERTIFICATE_PFX_BASE64` and
  `WINDOWS_CERTIFICATE_PASSWORD`; the workflow's test certificate is for
  development only.
- For Store packaging, configure the three `MSIX_STORE_*` repository
  variables from Partner Center and submit the package through the Store.
- Add the approved production app icon and validate installer, upgrade,
  uninstall, device-code sign-in, screen lock and accessibility on supported
  Windows hardware.

### Android TV / Google TV / Fire TV

- Test D-pad focus order, visible focus, back behavior, remote activation,
  text scaling, overscan/safe areas, screen lock and sign-out on each target
  TV family.
- Verify the leanback launcher/banner and store discoverability.
- Confirm read-only enforcement on the server, including attempts to submit
  unauthorized writes from a modified client.

### Roku

- Run the `roku-channel` CI job and retain the generated
  `eduos-roku-channel` ZIP artifact.
- Replace generated placeholder posters and splash images with approved
  production artwork in `eduos/clients/roku/art/`.
- Sideload and exercise setup, QR/code pairing, PIN lock, sign-out, capsule
  views, history pagination and photo viewing on physical Roku hardware.
- Validate API TLS, private signed-photo URLs, registry cleanup, remote
  navigation and error/recovery states.
- Complete Roku developer account, channel listing, content rating and
  publishing requirements. The repository does not sign or publish the
  channel automatically.

## 4. District production configuration and privacy

Before enabling device sign-in, configure the district's public origin and
identity-provider settings, then explicitly enable
`DEVICE_SIGN_IN_ENABLED=true`. Validate the approval page and rate limits
with the district identity provider. Do not enable it merely because the
feature is present in the code.

Production release also depends on district-approved retention and legal-hold
policies, private object storage, malware scanning and media processing,
backup/restore testing, incident response procedures, privacy/legal review,
and data-processing agreements. These are deployment and governance gates,
not things that a green CI run can certify.

## 5. Current owner-supplied inputs

The following external inputs are still needed for the relevant store releases:

- **Apple:** Developer Program membership, team identifier, App Store Connect
  record, signing certificate and provisioning profiles.
- **Google Play:** developer account, upload key / Play App Signing and store
  listing.
- **Amazon:** developer account, Fire tablet/TV listing and approved artwork.
- **Roku:** developer account, channel listing and production artwork.
- **Windows:** production code-signing certificate or Partner Center identity
  values.
- **Brand assets:** approved app icons, Android TV banner, Fire TV assets,
  Roku channel posters and splash screens.
- **District IT:** production public origin, identity-provider redirect
  configuration and explicit device-sign-in approval.

## 6. Audit conclusion

The repository contains client implementations for Android, iOS, Windows,
Android/Google TV, Amazon Fire devices and Roku. The degree of automated and
physical validation differs by platform. Required CI currently validates
Flutter shared code and Android debug packaging; Roku packaging is automated
but optional; native iOS and Windows builds and all physical TV/Roku
certification remain release gates.

Do not describe a platform as store-ready or production-certified until its
native build, signing, device tests, privacy review and store submission
evidence are recorded.
