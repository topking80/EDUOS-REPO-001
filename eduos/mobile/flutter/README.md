# EduOS mobile app (Flutter)

The native EduOS app for Android (iOS later). **Phase 1** ships sign-in, role
navigation, the offline write queue and the full **parent app**: children,
library books, arrival (bus check-ins), pick-up (passes, approved adults,
early dismissal), messages and alerts, plus the SafetyOS takeover during a
live incident. Messages and alerts also work natively for staff roles.

**Phase 2** adds the offline-critical staff screens: the bus driver's route
(stop-by-stop check-ins, start and finish run), the teacher's class register
(attendance) and the teacher's safety roll call.

**Phase 3** adds school leaders: the principal's school overview (and the
superintendent's district overview) with announcements, the pick-up desk
(pass check, photo-ID and custody acknowledgement, release or refuse) with
approvals and restrictions, the accountability board during an incident
(missing, injured, roll calls, responders, reunification, all clear) and
starting an alert in two confirmed steps, plus debriefs.

**Phase 4** adds learners: Home (what to practise next, courses, my bus,
school news), Courses (grades, standards mastery, lessons with primary
sources, quizzes with a timer and answers saved as you go, results and
classwork feedback), Christie practice chats, My path, My library and News.
Quiz answers are never queued offline; the app says when one isn't saved.
Other staff tabs open the EduOS web app until their phase ships.

## How sign-in works (RFC 8252)

District identity providers block sign-in inside embedded WebViews, so the app
uses the system browser:

1. The app makes a PKCE pair and opens
   `https://<server>/auth/login?next=native&app_challenge=…&app_redirect=org.eduos.app:/oauth2redirect`.
2. After district sign-in, the server returns to `org.eduos.app:/oauth2redirect?code=…`
   with a single-use code (60 s).
3. The app redeems it at `POST /auth/native/token` with its PKCE verifier and
   receives a normal EduOS session (same expiry, idle timeout and revocation as
   the browser). It's kept in the Android Keystore (`flutter_secure_storage`)
   and sent as `Authorization: Bearer`, with the CSRF token on every write.

**Server setup:** set `NATIVE_APP_REDIRECT_URIS=org.eduos.app:/oauth2redirect`
on the EduOS server. Native sign-in is off until this is set.

## Offline

The same small allowlist as the web app (safety roll call, bus check-ins,
attendance) is queued on the phone when the network or server is down. Queued
writes are re-sent with their original `Idempotency-Key` and
`X-EduOS-Queued-At`, kept at most 24 hours (200 entries), and wiped on sign-out.
Pick-up actions are always online, because identity is checked live. School
records are never cached on the phone.

## Run and test

```bash
cd mobile/flutter
flutter pub get --enforce-lockfile
flutter analyze --fatal-infos
flutter test
flutter run            # Android device or emulator; enter your district's EduOS address
```

`lib/branding/branding_demo.dart` is the mascot and brand designer preview
(`flutter run -t lib/branding/branding_demo.dart`).

**Release builds** use debug signing until the district adds its own key
(`android/key.properties`, never committed). Application ID: `org.eduos.app`.

## Layout

- `lib/core/`: API client (bearer + CSRF + offline routing), sign-in (PKCE),
  session storage, offline queue, models
- `lib/app/`: app controller (session, branding, safety polling), role tabs
- `lib/ui/`: sign-in, shell, parent screens
- `test/`: core unit tests and app widget tests against a fake EduOS server

# School branding + mascot

This isolated Flutter module provides tenant-replaceable brand tokens, a locally bundled mascot illustration, and a lifecycle-aware Rive controller. The bundled SVG is a usable static fallback and an art-direction/source reference; it is **not** a compiled `.riv` animation file.

## Run

```bash
cd mobile/flutter
flutter pub get
flutter run
```

## Local assets and Rive contract

- Static fallback: `assets/branding/eduos_mascot.svg`
- Rigging/state-machine specification: `assets/branding/eduos_mascot.rig.json`
- Authored animation destination: `assets/branding/eduos_mascot.riv`
- Artboard: `EduOS_Mascot`
- State machine: `Character_Controller`
- Triggers: `onGreet`, `onSuccess`, `onError`
- Numbers: `mood` (0 neutral, 1 happy, 2 surprised), `lookX`, `lookY` (-100..100)

The Rive file must be authored/exported in Rive Editor and placed in the local Flutter bundle. Do not rename the expected artboard, state machine, or inputs without updating the Dart controller and tests. The widget falls back to the bundled SVG if the `.riv` file is unavailable or malformed.

## Rigging hierarchy

The machine-readable authoring contract is in `assets/branding/eduos_mascot.rig.json`. Use logical groups `Head`, `Torso`, `Arm_L`, `Arm_R`, `Leg_L`, `Leg_R`; a `Root` at the feet; `Hip` as the center-of-gravity pivot; spine chain `Spine_01`, `Spine_02`, `Neck`, `Head`; and named left/right limb chains. `Look_Target` is an external non-deforming target. Constrain pupil groups and head aim toward it rather than mapping screen coordinates directly to geometry.

## Parallel state-machine layers

| Layer | Contract |
|---|---|
| `Base_Body` | `Idle_Breathing` default; `Wave`, `Jump`, `Sad`; triggers `onGreet`, `onSuccess`, `onError` |
| `Face_Expressions` | `mood` 0/1/2; 0.2-second blend |
| `Eye_Blink` | Open/Blink loop; randomized 3–5 second exit |
| `Eye_Tracking` | 2D blend driven by `lookX` and `lookY` |

Blink timing and animation blending belong in the Rive state machine, not Flutter timers. Flutter sends semantic triggers and clamped numeric inputs.

## Lifecycle and performance

The widget loads the Rive asset once per state, observes Flutter lifecycle, pauses the artboard while backgrounded, and resumes it when foregrounded. Use local assets to avoid network dependency during first render. Profile actual draw calls, battery use, frame pacing, and rapid trigger interruption on a physical mid-range phone before release; this repository does not claim a single draw call or 60 FPS without device profiling.

## Branding governance

The included mascot is a generic EduOS character concept. District deployments must use approved school/district logos, colors, and character adaptations supplied by that district. Do not infer or invent district identities, partners, endorsements, or testimonials.

## Privacy-safe app outcome bridge (32.29.0)

`EduOsMascot` accepts an optional `Stream<EduOsMascotSignal>` through `events:`. Emit only after an authenticated EduOS API operation has returned a successful, authorized result:

```dart
final mascotEvents = StreamController<EduOsMascotSignal>.broadcast();
// After the server confirms attendance was recorded:
mascotEvents.add(EduOsMascotSignal.attendanceRecorded);
// After the server confirms an adult-to-adult arrival handoff:
mascotEvents.add(EduOsMascotSignal.staffHandoffConfirmed);

EduOsMascot(events: mascotEvents.stream);
```

Other signals include `riderArrivalConfirmed`, `taskCompleted`, `safetyAttentionRequired`, `workflowNeedsHelp`, and `welcomeUser`. Do not emit from a button tap before the server confirms the operation. The signal enum intentionally has no fields, so student names, IDs, notes, and raw API responses cannot be passed through the mascot event channel. Close the host-owned `StreamController` when its app scope ends.

## Server-confirmed mascot event gateway

Use `EduOsMascotEventGateway` as the only app-level publisher for workflow
feedback. Call `publishConfirmed` only after the authenticated API call has
completed and the response has passed both HTTP and business-rule validation.
For example, a successful HTTP response that reports a rejected or pending
handoff must not trigger `staffHandoffConfirmed`. Pass only the allowlisted
`EduOsConfirmedOperation`, status code, and boolean confirmation; never pass
response bodies, student identifiers, names, notes, or API tokens. Provide
`gateway.signals` to `EduOsMascot(events: ...)` and dispose the gateway with
the owning application scope. This adapter does not itself authenticate API
requests or prove that a backend workflow is implemented; those guarantees
remain the responsibility of the API client and server.
