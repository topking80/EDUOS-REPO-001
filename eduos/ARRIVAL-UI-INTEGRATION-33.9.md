# EduOS 33.9.0 — Authenticated arrival register UI

## Implemented
- Added an Arrival register tab to the authenticated API bridge for superintendent, principal, teacher, and bus-driver roles.
- Loads arrival records from `GET /api/arrival/today`.
- Loads actual student records and teacher choices for form selections.
- Loads today's assigned transport runs for bus-driver arrivals.
- Principals can record car-rider and walk-in arrivals and optionally assign a receiving teacher.
- Bus drivers can record bus arrivals only against a returned run.
- Teachers and principals can independently confirm receipt.
- Teachers can record present or tardy first attendance only after receipt.
- All mutations use the API bridge's session credentials and CSRF token.
- The old browser-local demo remains labeled as non-authoritative and is not used by the new register.

## Verification boundaries
- UI integration is source-level tested and JavaScript syntax checked.
- Live OIDC browser sessions, PostgreSQL migrations, role-by-role HTTP tests, and actual school-day operations have not been exercised in this environment.
- The current API returns only active/current day transport runs; a driver without a started run must start one in the existing transport workspace before recording a bus arrival.
- District-level superintendent may see arrival rows across the district; school staff are scoped to their school/roster.
