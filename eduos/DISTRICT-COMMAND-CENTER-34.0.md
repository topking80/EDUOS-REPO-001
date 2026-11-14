# EduOS 34.0.0 — District Command Center

## Scope
Adds a Command center workspace for superintendent and principal roles. It composes existing authenticated API read paths for arrival handoffs, transportation runs and teacher accounts, plus the already-loaded attendance and intervention-case records.

## Operational view
- Arrival handoffs pending independent receipt and received.
- Active transport runs returned by the current account's transport API.
- Teacher accounts returned by the scoped user API.
- High/urgent open intervention cases and overdue follow-ups.
- Absence events in the currently loaded attendance window.
- Priority queue linking users to existing workspaces.

## Security and data handling
- Navigation is restricted to superintendent and principal roles; server APIs remain the authorization boundary.
- No new write endpoints, role elevation, or browser-side authoritative records were added.
- All requests use the existing API bridge, session and CSRF handling.
- Feed failures are isolated with `Promise.allSettled`; the screen displays a partial-data warning.
- Counts explicitly describe returned records, not a guaranteed district-wide total. Existing API scope determines visibility.

## Verification
- JavaScript syntax check and focused regression tests recorded in the release validation.
- No live district database, HTTP session, browser E2E, or deployment test was run. Feed payloads and role-level data scope still require verification against a live configured district.
