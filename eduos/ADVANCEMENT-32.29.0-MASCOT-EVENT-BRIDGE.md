# EduOS 32.29.0 — Privacy-safe Mascot Event Bridge

## Scope
Adds a typed Flutter `EduOsMascotSignal` stream contract so an authenticated host workflow can trigger mascot feedback only after it receives a successful, authorized result. Attendance, rider arrival, staff handoff, and task completion map to celebration; safety/workflow exceptions map to help; welcome maps to greeting.

## Privacy and trust boundary
The bridge accepts semantic enum values only. It does not accept or retain student IDs, names, notes, API response bodies, or arbitrary event maps. The host app must emit signals only after server authorization and successful completion; UI taps or locally simulated records are not proof of an operational event. The widget cancels its subscription on disposal and ignores events while backgrounded.

## Runtime
Works with the existing Rive triggers and SVG motion fallback. No new network client or server authority is introduced. The Rive `.riv` file still must be authored and added locally.

## Validation
Focused Node contract tests and JS syntax checks are run for this package. Flutter SDK compilation/device profiling and end-to-end connection to authenticated EduOS APIs remain unverified in this environment.

## Host integration example

```dart
final mascotEvents = StreamController<EduOsMascotSignal>.broadcast();
// Call only after a successful authenticated API response:
mascotEvents.add(EduOsMascotSignal.attendanceRecorded);
// Render: EduOsMascot(events: mascotEvents.stream)
```

The host application owns the stream controller and must close it when its scope ends. This bridge is intentionally a presentation adapter, not an attendance, transportation, safety, or authorization service.
