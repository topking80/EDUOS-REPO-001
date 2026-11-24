# EduOS client platforms plan: Time Capsule on phone, tablet, desktop, TV and Roku

Requested by Mathew (Nov 23, 2026): "Mobile screens should be extensive and include android/google tv, Roku, Amazon, iOS, and windows."

## 1. What exists today (inventory of origin/main)

**Flutter app:** `eduos/mobile/flutter` (package `eduos_mobile_branding`, v32.32.0, Flutter 3.24.5 in CI)
- **Platforms enabled:** Android only (`android/`). There's no `ios/`, `windows/`, `web/`, `macos/` or `linux/` folder, although `.metadata` already lists `ios/Runner.xcodeproj` as unmanaged.
- **State:** a hand-rolled `AppController` (ChangeNotifier) exposed through `AppScope` (InheritedNotifier). No provider, riverpod or bloc. Screens use `Loader<T>` / `InlineLoader<T>` (FutureBuilder + retry + pull-to-refresh) and `TabVisit` keep-alive.
- **API client:** `lib/core/api_client.dart`, `package:http`. Bearer session token plus `x-csrf-token` on writes, CSRF auto-refresh, an offline write queue (allowlist), in-flight GET de-dup and isolate JSON decode over 48 KB. It had no PATCH, no raw-bytes upload and no redirect-free GET; branch 01 adds those three.
- **Sign-in:** RFC 8252 PKCE through the system browser (`flutter_web_auth_2`), redirect `org.eduos.app:/oauth2redirect`, then `POST /auth/native/token`. The server only allows reverse-domain or https redirects (`NATIVE_APP_REDIRECT_URIS`), with no loopback, so Windows desktop and TVs can't use this flow as-is (see section 4).
- **Navigation:** `lib/app/role_tabs.dart` mirrors `ROLE_TABS` in `public/app/app.js`. `Shell` shows a bottom NavigationBar (4 + "More"), a profile switcher (`ui/profile_switcher.dart`) and a SafetyOS takeover. There's no tablet or desktop layout.
- **Time Capsule screens:** none. The web app has `capsules`, `portfolio` ("My history"), `contributions` ("History items") and others, but the Flutter app has no history or capsule screen at all.
- **Push:** no FCM in main (the `feat/fcm-device-push` branch belongs to someone else, and I'm not touching it).
- **Tests:** 13 files, 111 tests, `FakeServer` (MockClient) in `test/operations_screens_test.dart`.
- **CI:** the `flutter-mobile` job (ubuntu-24.04) runs `pub get --enforce-lockfile`, `analyze --fatal-infos`, `flutter test` and `build apk --debug`, then uploads the APK. It's one of the 8 required checks in the main ruleset.

**Time Capsule and student-history API on main (all `requireSession`; writes need `requireCsrf`):**

| Area | Endpoints |
|---|---|
| Capsules | `GET/POST /api/history/capsules`, `GET/PATCH /api/history/capsules/:id`, `GET …/:id/candidates`, `POST …/:id/items {entryId}`, `POST …/:id/recipients {userId,type}`, `POST …/:id/seal|cancel|release`, `GET /api/history/capsule-recipient-options?studentId=`, `GET /api/history/capsule-milestones` (school leads), `GET /api/history/capsule-invitations`, `POST /api/history/capsule-invitations/:capsuleId {decision: approved|denied|withdrawn}` |
| Portfolio / timeline | `GET /api/history/portfolio?studentId&type&kind&year&q&cursor` (50 per page, facets, photos, transferredFrom) · `GET /api/history/export?studentId=` |
| Guardian contributions | `GET/POST /api/family/children/:studentId/history-contributions`, `PATCH …/:contributionId {decision:"withdraw"}` |
| Teacher contributions | `POST /api/students/:studentId/history/teacher-items`, `GET /api/teacher/history-items`, `PATCH /api/teacher/history-items/:id`, `POST …/:id/submit`, `GET /api/history-review`, `POST /api/history-review/:id`, `GET /api/family/children/:studentId/history-items/pending`, `POST /api/family/children/:studentId/history-items/:id {decision: accept|decline}` |
| Photos / media | `GET/PUT /api/history/media-policy`, `POST /api/history/entries/:id/photos`, `POST /api/family/children/:sid/history-contributions/:cid/photos`, `POST /api/history/capsules/:id/photos` (raw image body), `GET /api/history/photos/:assetId`, which returns a **302 to a 60-second signed URL** (the client must not forward its Bearer token to the storage host) |
| Transfers / imports | `POST/GET /api/students/:id/history-transfers`, `POST /api/history-transfers/:id/cancel`, `GET …/:id/package`, `GET /api/family/history-transfers`, `POST /api/family/history-transfers/:id {decision: approve|decline}`, `POST/GET /api/history-imports…` (district IT) |
| Privacy / sharing | `GET /api/students/:id/history-privacy`, custody restrictions, rights transition, `GET/POST /api/history/sharing`, `POST /api/history/sharing/:id/revoke`, emergency access, `GET /api/students/:id/history-access-log` |
| **TC-08** (branch `tc/08-archival-storage-v2`, unmerged) | `GET /api/history/preservation`, `PUT /api/history/preservation-policy`, `GET/POST /api/students/:id/legal-holds`, `GET /api/history/legal-holds`, `POST /api/legal-holds/:id/release` (records office only) |
| **TC-11** (branch `tc/11-family-storage-dashboard`, unmerged, stacked on TC-08) | `GET /api/history/storage?studentId=` (family storage dashboard: limits, usage, items, capsules, retention, export, guidance, donation note) |
| Device pairing (#124, DEV-02) | `POST /api/classroom-agent/code` (room display with a district-issued `cdk1.` device key), `POST /api/rooms/:id/pair {code}` (teacher), `GET /api/my/rooms`, `POST /api/pairings/:id/end`. This is **room-display ↔ teacher** pairing, and it doesn't sign a person in on a family TV. |

**Stacking decision:** the client branches build on **main only**. The storage dashboard and records-office screens call the TC-08/TC-11 endpoints and show "not available on this server yet" on a 404, so they light up as soon as those TC branches merge. Nothing stacks on unmerged TC branches.

## 2. Flutter: phone, tablet, desktop (branch `clients/01-flutter-time-capsule`)

- **Responsive shell:** under 840 dp keeps today's bottom bar. From 840 dp (tablet landscape, desktop) it uses a NavigationRail, extended from 1200 dp. Content gets a max width with two-pane list/detail where it helps (capsule list + detail, timeline + item).
- **New tabs, mirroring web ROLE_TABS:**
  - parent: "Time Capsules"
  - pupil: "My history" and "Time Capsules"
  - teacher: "History items"
  - principal / superintendent: "Time Capsules"
  - vice principal: added on the leader side
- **Screens:**
  1. **Time Capsules hub:**
     - invitations "Capsules for you" (accept, decline, withdraw)
     - milestone confirmations (leaders)
     - "My capsules" and "Opened for you"
     - family: per-child entry points to history, family memories, teacher items, transfers and storage
  2. **New capsule:** child, title, message, a date (09:00 local on that day) or a milestone (grade 5, grade 8, graduation, 18).
  3. **Capsule detail:**
     - status, opens-when, message, items with photos, own photos
     - owner only: recipients with consent, event history, edit title and message, add items from history (candidates), add recipients (eligible options), seal, cancel (with confirmation)
     - leaders: release a milestone capsule
  4. **History timeline / portfolio:** grouped by school year, filters (year, kind, type), search, cursor paging, photo thumbnails, "transferred from", full-screen item and photo viewer.
  5. **Family memories:** guardian contributions list, add (title, story, date) and withdraw while waiting.
  6. **From teachers:** teacher items waiting for the family, keep or decline (with a reason).
  7. **Teacher "History items":** my submissions with status and decision trail, a new item for a student on my roster (`/api/rosters`), edit and resubmit when changes are requested.
  8. **Leaders' review queue:** approve, request changes or reject, with a reason.
  9. **Transfers:** family approval of history transfers to a new district.
  10. **Sharing:** pupils who hold their own rights see grants and can revoke them; parents see grants to them.
  11. **Storage:** the TC-11 family storage dashboard (usage bar, limits, items, capsule opening dates, retention text, export link, "donations never change limits").
- **Photos:** `ApiClient.location()` makes a redirect-free authorized GET, then `Image.network` loads the signed URL with no auth header, with a cache of signed URLs under 60 seconds.
- **Platforms:** add `ios/` (bundle id `org.eduos.app`, the URL scheme for sign-in) and `windows/` via `flutter create --platforms=ios,windows`. Android stays as it is.
- **Tests:** widget tests for each screen against `FakeServer`, wide-layout tests (rail at 1280 px), and the photo redirect test.

## 3. Amazon Fire tablets (Fire OS = Android) and Android TV / Google TV / Fire TV (branch `clients/02-tv`)

- **Build flavors** (`android/app/build.gradle` `productFlavors`, dimension `store`):
  - `play`: Google Play, Android phones, tablets and Android/Google TV.
  - `amazon`: Amazon Appstore, Fire tablets and Fire TV. No Google Play Services: the app uses none today, and it must stay that way in the `amazon` flavor. When push lands (FCM branch), the `amazon` flavor uses **Amazon Device Messaging (ADM)** or falls back to the existing in-app notifications poll (`GET /api/notifications` on resume and on a timer). Custom Tabs may be missing on Fire OS, so sign-in falls back to the device-code flow below.
  - CI builds `flutter build apk --debug --flavor play` (the required check keeps its name and outcome) plus a non-blocking amazon build step.
- **TV manifest:**
  - `<uses-feature android:name="android.software.leanback" android:required="false"/>` and `android.hardware.touchscreen required="false"`, so one APK serves phones and TVs
  - an activity intent-filter with `LEANBACK_LAUNCHER`
  - `android:banner="@drawable/tv_banner"` (320×180 placeholder drawn as a vector; Mathew supplies the final art)
  - Fire TV: `amazon.hardware.fire_tv` handled via the same leanback filter
- **10-foot UI:**
  - TV detection: `UiModeManager` (`UI_MODE_TYPE_TELEVISION`), or the leanback feature, through a method channel. A `--dart-define=EDUOS_FORM_FACTOR=tv` override covers emulators.
  - 1.5× type scale, 48 dp+ focus targets, a visible focus ring, overscan-safe 5% margins
  - `FocusTraversalGroup` + `Shortcuts`/`Actions` for D-pad (arrows, select/enter, back), and a horizontal rows layout (Netflix-style rails: capsules, opened for you, recent history, photos)
  - read-mostly: no free-text entry on TV
- **Sign-in on TV (no browser on most TVs):** a new **device sign-in** (RFC 8628 device authorization):
  - `POST /auth/device/code` (no session, IP-rate-limited) gives `{deviceCode, userCode "ABCD-EFGH", verificationUri, expiresIn 600, interval 5}`
  - the person approves in the EduOS app or website they're already signed in to: `POST /api/device-sign-in/approve {userCode}` (session + CSRF, not from another device session)
  - the TV polls `POST /auth/device/token`
  - device sessions are flagged `client_kind` (android_tv, fire_tv, roku, windows) and are **read-only for TV/Roku** (a session guard refuses writes except sign-out), with a shorter TTL
  - codes are stored hashed, single-use, and every step is audited
  - a new migration, numbered high (150) to avoid TC's 135+ range, to renumber at merge time if needed
  - the classroom pairing from #124 stays for room displays, because it authenticates a room device key, not a person
- **Shared-screen privacy (TV, Roku, family Windows PC):**
  - nothing about a student shows before sign-in
  - after sign-in, a **profile picker with a 4–6-digit PIN** (kept only on the device, hashed with a per-device salt in secure storage)
  - **auto-lock** after 10 minutes idle (configurable 5–30), back to the picker, and on app background
  - "Sign out of this TV" is always reachable
  - photos are only fetched while unlocked, and signed URLs are never cached past their 60 seconds

## 4. Windows desktop (branches 01 and 04)

- 01 enables the `windows/` platform. Sign-in: `flutter_web_auth_2` on Windows can't receive `org.eduos.app:` redirects without an embedded WebView (which RFC 8252 and our code comments forbid), and the server refuses loopback redirects. So Windows uses the **device sign-in** from 02 ("Sign in with your phone"). Allowing the RFC 8252 §7.3 loopback is a later option.
- `clients/04-windows-msix`: the `msix` dev dependency and `msix_config` in pubspec (display name EduOS, publisher placeholder `CN=EduOS District`, identity `org.eduos.app`, capabilities `internetClient` only, no `runFullTrust` beyond Flutter's default), plus a README section. Building the MSIX needs a Windows runner: an optional `workflow_dispatch` workflow on `windows-latest`, non-required. **Signing needs Mathew's or the district's code-signing certificate**, stored as a GitHub secret, never in the repo.

## 5. iOS / iPadOS (branch 01)

- `ios/` platform, bundle id `org.eduos.app`, minimum iOS 13, `CFBundleURLTypes` `org.eduos.app`. iPad gets the tablet layout (rail).
- CI: macOS runners cost about 10× Linux minutes, so **no iOS build is added to the required checks**. I'll note it and offer an optional manual `workflow_dispatch` job (`flutter build ios --no-codesign`) only if Mathew wants it.
- Releasing needs an Apple Developer Program account ($99/year), signing certificates and provisioning profiles, and App Store Connect.

## 6. Roku (branch `clients/03-roku`)

- Flutter can't target Roku, so it's a separate BrightScript/SceneGraph channel in `eduos/clients/roku/`:
  - `manifest`, `source/main.brs`, `components/*.xml|brs`
  - `ServerScene` (district server URL, entered once with the on-screen keyboard)
  - `PairScene`: device sign-in from section 3, showing the user code and the verification URL (plus a QR), and polling `/auth/device/token` on a Task node
  - `ProfileLockScene` (PIN + auto-lock)
  - `HomeScene`: rows of capsules, opened for you, history by year
  - `CapsuleScene` (message, items, photos), `TimelineScene`, `PhotoScene` (full-screen photo with left/right)
- Read-only: Roku sessions are read-only server-side.
- Photos: the Task node does an authorized request to `/api/history/photos/:id` without following redirects (`roUrlTransfer` `EnableFreshConnection`, `SetRedirect`…), then the Poster loads the signed URL.
- Token storage: `roRegistrySection`, cleared on sign-out.
- **Tooling:** `package.json` in `eduos/clients/roku` with `brighterscript` (`bsc`) + `@rokucommunity/bslint`, and its `lint` and `build` package scripts (`build` makes `out/eduos-roku.zip`, git-ignored). A **non-required** CI job `roku-channel` (ubuntu) runs lint + package. The 8 required checks are unchanged.
- Publishing needs a Roku developer account, a channel listing and artwork (focus/side posters, splash).

## 7. Order and branches

1. `clients/01-flutter-time-capsule`: Time Capsule screens, responsive shell, ios + windows platforms, tests.
2. `clients/02-tv`: device sign-in (server + Flutter), TV/leanback layout + focus, manifest, `play`/`amazon` flavors, PIN/auto-lock.
3. `clients/03-roku`: Roku channel + lint/package script + non-required CI job (depends on 02's device sign-in).
4. `clients/04-windows-msix`: MSIX config + optional Windows workflow.

Each branch keeps the 8 required checks green. No PRs, merges, pushes to main or force-pushes.

## 8. What Mathew must provide

- **Apple:** Developer Program membership, team ID, App Store Connect app record, signing certificate and profiles.
- **Google Play Console:** developer account, upload key / Play App Signing, store listing.
- **Amazon Appstore:** developer account, Fire TV / Fire tablet listing, and ADM credentials if push is wanted.
- **Roku:** developer account, channel listing, channel artwork.
- **Windows:** a code-signing certificate (OV/EV) or a Microsoft Store (Partner Center) account, and the publisher name for the MSIX identity.
- **Art:** app icons (1024 px master), an Android TV banner (320×180), Fire TV assets, Roku focus/side posters (HD 336×210 / FHD 540×405) and splash (1280×720 / 1920×1080).
- **District config:** the `NATIVE_APP_REDIRECT_URIS` value for the store apps, and turning on device sign-in (`DEVICE_SIGN_IN_ENABLED`).
