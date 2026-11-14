# EduOS 32.22.0 — Arrival workflow demo safety gate

## Purpose
This release hardens the arrival and classroom-handoff experience so a browser-local simulation cannot reasonably be mistaken for a live district record.

## Changes
- Renamed the browser storage namespace to `eduos_arrival_handoff_demo_v2`; earlier demo state is not silently imported into the new release.
- Added a prominent, persistent `DEMO ONLY — NOT AN AUTHORITATIVE STUDENT RECORD` warning above the arrival workflow.
- Explicitly states that the screen is not connected to SIS roster, transportation manifest, staff identity, attendance database, emergency roll call, or student-release controls.
- Clarified that persona selection is a presentation control and not an authentication or authorization mechanism.
- Updated the application/PWA cache version to 32.22.0.

## Important limitation
This is a safety hardening release, **not** the server-backed arrival integration previously identified as the next major capability. The arrival assignments, car-rider check-ins, bus handoffs and first-attendance actions remain browser-local demo behavior. They must not be used for real student supervision, attendance, custody, transportation dispatch or emergency accountability. Server-side persistence and role authorization remain future work.

## Validation
- JavaScript syntax checks: run before packaging.
- Focused arrival/connection/product tests: run before packaging.
- Database-backed arrival workflow: not implemented or tested in this release.
