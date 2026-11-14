# EduOS 32.5.0: SafetyOS (lockdown / emergency) and car pick-up verification

What was asked: build SafetyOS from the Series B deck (pages 34-35) and the
page-21 trust promises: a staff-started, two-step lockdown / shelter /
evacuate / hold flow with a drill flag, a full-screen state in every role app
(bus driver included), teacher roll call, a live accountability board,
reunification and all clear, generic family notices, an append-only audited
log; and car pick-up verification with passes, a photo-ID check,
custody / do-not-release flags, early dismissal and a release log. Also fix
the cheap 32.4 leftovers (school time zone for "today", retention for the new
tables, in-app dialogs instead of browser prompts). Operator steps are in
`docs/UPGRADING-32.5.0.md`.

Hard rules kept:
- **No location tracking, facial recognition, cameras or threat scoring.** A
  unit test fails the build if migration 013 has a location, photo, face,
  biometric, threat, risk or score column, or if the phone app calls
  `getUserMedia` / geolocation. The edge keeps `camera=(), microphone=(), geolocation=()`.
- **No student data leaves EduOS.** Families get in-app notices only. Email,
  SMS and push adapters are still off / dry-run. Family notices never name other
  learners or show roll-call data (checked in the HTTP and phone smoke tests).
- RLS (FORCE, tenant + restrictive role policies), OIDC, CSRF on every write,
  audit rows for every action, FERPA export/deletion coverage, rate limits,
  and axe at 0 violations.

## 1. SafetyOS incidents
- **Start (step 1):** `POST /api/safety/incidents {kind, isDrill, instructions?}`
  makes a *pending* incident; nothing is broadcast. Kinds: lockdown, shelter,
  evacuate, hold.
- **Confirm (step 2):** `POST /:id/confirm` must repeat the same kind *and* drill
  flag within 2 minutes (410 if late, 400 if different). Only then do staff,
  students, drivers and families at that school get the in-app alert. One live
  incident per school (409). Cancel is `POST /:id/cancel`.
- **Full-screen state:** every role app polls `/api/safety/status` (every 15 s
  and on focus). While an incident is live the app shows a colour-coded banner
  with a DRILL / NOT A DRILL ribbon and role-specific instructions, hides the
  tabs, and sends every other screen back to it. Staff can still reach
  pick-up and the safety screens; families reach pick-up once reunification
  starts. Opening the app during an alert always lands on it.
- **Roll call (teachers):** their roster with Present / Missing / Injured,
  plus "Also in my room" to add a learner from another class (search is
  limited to that school, live incidents, 5 results). Missing or injured
  alerts the school leaders. The log is append-only; the latest report per
  learner wins.
- **Accountability board (leaders):** accounted vs enrolled, present /
  missing / injured / not reported / extra / released, missing and injured
  names, roll call by class, not-reported list, incident log. Actions: First
  responders, Log a note, Start reunification (point), All clear (two-step;
  the API wants the kind repeated). It refreshes itself.
- **Reunification:** families see the point and only their own children, with
  "With staff" or "Released to <adult> · time". Releases go through pick-up
  verification and are logged to the incident.
- **After:** history of incidents and drills, and a debrief note (closed only).
- Desktop site: unchanged. The SafetyOS full-screen state lives in the mobile
  role apps at `/app/`.

## 2. Car pick-up verification
- **Families (Pick-up tab):** who can collect each child (guardian row is
  automatic), add an adult (pending until the school approves), remove an
  adult (revokes their passes), "Show my pick-up pass" (QR + 10-character code,
  shown once), one-day passes for authorized adults, early-dismissal requests,
  recent pick-ups.
- **Staff (teachers and leaders):** type the code or use a handheld scanner,
  Check pass, see the adult and eligible learners, tick "I checked a photo ID"
  (and the custody acknowledgement when an order is on file), Release or
  Refuse (reason). A do-not-release match shows **DO NOT RELEASE**, has no
  release button, and alerts the leaders. Waiting / released today queue.
- **Leaders (Approvals):** adults to approve or decline, early-dismissal
  requests, custody and do-not-release restrictions (add / lift), release log.
- Guardians get "Ava was picked up by Ruth Morgan (Grandmother) at 3:52 PM".
- Codes: Crockford-style alphabet (no I/L/O/U), case and O/0, I/L/1 forgiving,
  stored only as SHA-256; re-issuing revokes the old pass.

## 3. 32.4 leftovers fixed
- Bus-run "today" and pick-up dates use `schools.timezone` (`eduos_school_today`).
- Retention covers notifications, Christie, transport, comms, pick-up passes
  and closed incidents (env-tunable; see UPGRADING).
- Browser `prompt()`/`confirm()` replaced by an accessible in-app `<dialog>`
  (lock conversation, report message, all the SafetyOS confirmations). A unit
  test keeps them out.
- Header: no stray "null" text when the SOS button is absent.
- `npm audit`: 0 vulnerabilities (compression advisory fixed).

## 4. Demo data (`make up`)
- Ava Morgan: guardian Alex Morgan, approved grandmother **Ruth Morgan**
  (pass `RTHM2-AVA4K`), pending **Sam Rivera**, early dismissal tomorrow 13:30.
- Noah Brooks: approved Chris Brooks (pass `CHR1S-N0AH7`) with a custody order
  on file, and Pat Brooks (pass `PATB7-N0AH5`) under a do-not-release order.
- A closed, debriefed lockdown drill from last week. No live incident.
- Fixed demo pass codes exist only in the dev seed (refused in production).

## Results
- Unit: **324/324** (`npm test`; 11 new in `test/safety-32500.test.js`).
- PostgreSQL integration: **63/63** (7 new in `test/integration/safety-pickup.test.js`:
  two-step confirm and who may start, per-role and cross-school visibility,
  roll call and the board, reunification release, do-not-release and custody,
  early dismissal, school time zone, retention and FERPA coverage).
- HTTP smoke: **38/38** (2 new: pick-up end to end; SafetyOS drill end to end).
- Browser: desktop **34/34**, 32.4 phone pass **12/12**, new SafetyOS phone pass
  **20/20** (`dev/safety-smoke.mjs`, `make smoke-safety`); re-runnable.
- axe-core WCAG 2.1 A/AA: **0 violations** on 79 scans (19 new SafetyOS / pick-up
  screens including the dialogs).
- Screenshots: `/workspace/eduos-screens/32.5/` (21 phone screens, plus
  regression sets for the desktop and 32.4 phone passes).

## Still a demo / not included
- No real email, SMS or push. In-app only.
- No camera QR scanning in the app (typed code or a handheld scanner).
- No 911 / first-responder system integration; "First responders" is a log entry.
- Parents with children at several schools: school-leader alerts for their
  requests go to the session's school.
- The desktop site does not show the SafetyOS banner (mobile apps do).
- Roll call is per teacher roster; schools without rosters rely on "extra" adds
  and the leader board's "not reported yet" list.
