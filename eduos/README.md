# EduOS District Edition 37.7.2

**Package version: 37.7.2.** This README's detailed feature inventory below is historical context, not a complete inventory of changes through 37.7.2. Consult `RELEASE-NOTES-37.7.2.md` for the notification reliability and release-audit fixes, `RELEASE-NOTES-37.7.1.md` for district payment providers, and `RELEASE-NOTES-37.7.0.md` (plus `RELEASE-NOTES-37.5.0.md` for monitoring additions) for earlier changes and deployment requirements.
- **School node:** a small box at each school (Pi 5-class profile; arm64 not
  yet tested on hardware). It runs one school's EduOS, so attendance, bus
  check-ins, SafetyOS roll call, pick-up, Christie and gradebook reads keep
  working when the district uplink is down. Writes merge append-only, ordered
  by when they were observed.
- **Aggregation gate:** only allowlisted count tables leave a school. The
  minimum cell size is 5, with complementary suppression verified by linear
  algebra and an identifier scan. It is enforced at the single egress point
  and again at the hub, with leak tests. Consent-gated record transfers are
  off by default.
- **EDEN:** root → district → school under one trust root. Node identity is
  signed (Ed25519 certificates, signed and replay-proof requests); it is not
  mTLS. Versioned, signed bundles go down and gated aggregates go up.
- **DECN:** a partner school holds a sealed minimum continuity package. The
  superintendent authorizes a time-limited failover, handback is automatic,
  and the partner purges its copy. All of it is audited.
- **Phones:** an encrypted (non-extractable key) 24-hour queue for roll call,
  check-ins and attendance. Nothing else is cached.
- **Admin/IT:** a Nodes screen and a school-node status screen.
- Historical 32.7.0 documents: `FIX-REPORT-32.7.0.md`, **`docs/EDEN-32.7.0.md`** (design and
  what is simulated vs proven) and `docs/UPGRADING-32.7.0.md`. School-node
  install: `deploy/school-node/`. Local simulation: `make eden-sim`.

**32.6.0. Learning core, assessments and the first step of EDAL.**
- **Learning core:**
  - Courses, units and lessons tagged with standards.
  - Assignments with rubrics and teacher feedback.
  - A weighted gradebook. Ungraded work never counts as zero, and missing
    work is flagged.
  - An **explainable per-standard mastery model** that shows every piece of
    evidence and its share of the result. It makes no predictions or
    rankings.
- **Assessments:**
  - Multiple-choice, numeric and short-answer quizzes. They are auto-scored,
    and the teacher reviews anything that can't be.
  - Accommodations: extra time and on-device read-aloud.
  - Attempts and a retake policy. Keys are kept from learners until their
    last attempt.
- **Primary sources:** real public-domain items linked to the Library of
  Congress and the National Archives only, with guiding questions.
- **Christie** gives hints from approved lesson text only.
- **EDAL:** a tamper-evident, append-only hash chain for final grades,
  credentials and mastery milestones, with a verify endpoint, per-record
  proofs, checkpoints and a CLI (`npm run edal:verify`). **It is not a
  blockchain**, and external anchoring is a documented plan only.
- **Family "Grades & progress"** for linked children only.
- Documents: `FIX-REPORT-32.6.0.md` and **`docs/UPGRADING-32.6.0.md`**
  (migration 014, EDAL operations, the anchoring plan).

**32.5.0. SafetyOS (lockdown / emergency) and car pick-up verification.**
- **SafetyOS:** staff start a lockdown, shelter, evacuate or hold alert in two
  steps with a drill / real flag. Every role app at the school, bus drivers
  included, switches to a full-screen state. Teachers take roll call; leaders
  get a live accountability board, reunification and all clear. Families get a
  generic in-app notice about their own child only. The event log is
  append-only and audited. No location tracking, facial recognition, cameras or
  threat scoring.
- **Car pick-up:** guardian and authorized-adult passes (QR + code, hash only),
  staff verify the pass plus a photo ID, custody and do-not-release flags
  (do-not-release blocks and alerts the office), early dismissal, school
  approval of new adults and an audited release log.
- School time zones, retention for the role-app tables, in-app dialogs.
- Documents: `FIX-REPORT-32.5.0.md` and **`docs/UPGRADING-32.5.0.md`**
  (migration 013, school time zone, new env vars, qrcode dependency).

**32.4.0. Mobile role apps, real transport, the Christie tutor and the Comms Hub.**
- An installable, dark, phone-first app at `/app/` for students, teachers,
  families, administrators and the new **bus driver** role, with bottom tabs
  and per-school branding.
- **Transport:** drivers record check-ins at stops, and guardians see their own
  children's check-ins and get alerts. There is no GPS or location tracking.
- **Christie:** a hint-first tutor that uses approved content only. Turns are
  stored and audited, and teachers review sessions. It runs a local
  deterministic provider by default; an external adapter is optional, gated
  by env vars, and redacted. No external AI calls by default.
- **Comms Hub:** announcements, family and staff threads with read receipts,
  moderation, and a notification outbox. Email, SMS and push adapters are off
  by default. Students have no private messages with adults.
- Documents: `FIX-REPORT-32.4.0.md` and **`docs/UPGRADING-32.4.0.md`**
  (migration 012, driver role, optional env vars, notify job).

**32.3.0. School branding: mascots, school colors and icon displays.**
- Each school designs its own look in the **School branding** tab (principals
  for their school; superintendents and IT admins for any school and a
  district default):
  - mascot upload (PNG/JPG/WebP/SVG, re-encoded or strictly sanitized);
  - primary, secondary and accent colors, a safe font and a motto;
  - tile presets (Mascot classic, Bold colors, Minimal) and per-tile shape,
    colors, icon, label and visibility;
  - live previews for teacher, student, young student (K-2) and parent;
  - draft, publish, version history, restore and reset.
- **WCAG AA guardrails:** live contrast checks with suggested shades. The
  server refuses to publish text that fails AA. There is a per-user
  high-contrast theme, and `prefers-contrast`, `forced-colors` and
  reduced motion are respected.
- The published branding appears in the header, on every Home, on launcher
  tiles, in the K-2 view, in the guardian portal and on the sign-in page, and
  provides the per-school favicon and PWA manifest. People in several schools
  see the school they have selected.
- Documents: `FIX-REPORT-32.3.0.md` (what changed and how it was verified) and
  **`docs/UPGRADING-32.3.0.md`** (operator actions: migration 011, sharp, two
  optional env vars).

**32.2.0. No product limits, district resource mesh, and a home for every role.**
- **No product limits.** There is no fixed maximum number of schools, students,
  users, webhooks or apps. Lists are paged, and the audit export streams every
  event. SIS imports have no row cap: 50,000 students import in one batch in
  about 2.5 s. Districts can set their own caps, which are unlimited by default.
  Security limits (sign-in, invitation, body size, session) are kept and
  configurable. See `docs/LIMITS.md`.
- **Apps bought once, used everywhere.** The district app catalog records each
  app's licenses (seat-limited or unlimited, with terms) and who can use it:
  the whole district, or chosen schools, grades and roles. Schools can share
  apps they bought. Principals request apps and the district decides. A
  launcher serves teachers, students and families and supports web links,
  OIDC SSO and **LTI 1.3**. Privacy gates check the DPA status and COPPA
  flag. PostgreSQL RLS keeps sharing from ever widening student-data access
  across schools.
- **New IT admin role** for district systems, without student-record access.
- **A Home screen for every role.** Superintendent, IT admin, principal,
  teacher, student (a simplified version for grades K–2) and guardian each get
  a Home with "What needs attention". The layout is responsive, and axe-core
  WCAG 2.1 AA scans pass with 0 violations.

Documents for this release:
- What changed, measured and verified: `FIX-REPORT-32.2.0.md`
- **Operator actions**: `docs/UPGRADING-32.2.0.md`

**32.1.0, working platform.** One command (`make up`) now
starts the complete stack with a local sign-in provider and a seeded demo
district. **Start here: `GETTING-STARTED.md`.**
- Every core flow works end to end in the browser and is covered by an automated
  smoke test (`make smoke`, `make smoke-browser`, and CI in `.github/workflows/ci.yml`).
  Covered flows: sign-in, administration (schools, people, roles), rosters,
  draft/publish assignments, guardian invitations, SIS CSV import, webhooks, audit,
  FERPA export/delete, retention and metrics.
- Production setup: `npm run db:bootstrap` creates the district and the first
  superintendent. Administration API and UI; configurable edge network and ports.
- Fixes: impossible dates are rejected; the login rate limit no longer locks out
  a school behind one NAT address; pg 9 client concurrency; the parent "Submit
  work" button is gone; guardian invitation links now work.

Documents for this release:
- What changed: `FIX-REPORT-32.1.0.md`
- **Operator actions**: `docs/UPGRADING-32.1.0.md`

**32.0.54, edge hardening follow-up.**
- Edge images no longer contain committed password hashes or SSH keys. They
  are supplied at build time, and the build fails on missing values or
  placeholders.
- The student kiosk account has no admin rights.
- The un-hardened `platform/edge-runtime-reference` copy is deprecated.
- The API refuses to start against an unmigrated database.

Documents for this release:
- What changed: `FIX-REPORT-32.0.54.md`
- **Operator actions**: `docs/UPGRADING-32.0.54.md`

**32.0.53, security and privacy fixes.** This release fixed
all 24 findings of the 32.0.52 review: database role separation so RLS is
enforced, complete runtime grants, school and roster scoping, FERPA read
auditing, export/delete and retention, session hardening, edge security
headers, demo-mode gating and edge-platform provisioning.
- What changed and why: `FIX-REPORT-32.0.53.md`
- **Operator actions before upgrading**: `docs/UPGRADING-32.0.53.md`
- How it was tested (including live PostgreSQL): `VALIDATION-32.0.53-SECURITY-PRIVACY.md`

The rest of this file is the 32.0 integration overview. Per-release notes
are in the `README-32.0.*` / `VALIDATION-32.0.*` files at the repository root.

## 32.0 integration overview

This release incorporates the uploaded Phase 32.0 Performance & Efficiency
standalone interface into the authenticated Phase 28 server foundation.

## Included
- Phase 32.0 district interface at `public/index.html`.
- Original Phase 32.0 standalone HTML preserved in `demo/`.
- Authenticated same-origin API bridge and OIDC session foundation.
- Server-backed student directory/profile, assignments, submissions/grading,
  attendance and family acknowledgement.
- PostgreSQL-backed access requests, superintendent approval/denial,
  expiring permission grants and revocation.
- District RLS policies, CSRF protection and server audit.
- Earlier Phase 25 UI preserved in `demo/`.

## Data boundary
The Phase 32.0 interface retains local synthetic demonstration data and
localStorage-based editing. The Connected Services bar is a separate,
authenticated server workspace. It does not silently synchronize local demo
records to PostgreSQL. Persona switching in the demonstration UI is not
authentication or authorization. Only authenticated server APIs enforce
server-side permissions and database tenant policies.

The standalone screen includes synthetic examples and illustrative metrics.
Do not treat these as real district/student data or production performance
claims.

## Run

### Local evaluation (one command)
Requirements: Docker with Compose v2.20+, curl, Node.js 22+ (only for the smoke tests).
`make up`, then open https://localhost:8443/ and pick a demo account. Details,
demo logins and troubleshooting: `GETTING-STARTED.md`. `make down` stops it.

### Deploy with Docker Compose
1. `cp .env.example .env`. Set `NODE_ENV=production`, the three database
   passwords (`openssl rand -hex 24`), `PUBLIC_ORIGIN=https://<your host>`,
   `EDUOS_SITE_ADDRESS=<your host>`, and the `OIDC_*` values from your district's
   identity provider (the issuer must be https).
   Optional: `WEBHOOK_SIGNING_KEY`, `METRICS_TOKEN`.
2. `docker compose --profile edge up -d --build`. This creates the roles, runs the
   migrations as the owner and starts the API as the runtime role behind Caddy.
3. Create the district and its first superintendent (once):
   `docker compose run --rm migrate node src/bootstrap-district.js --district "<name>" --sub "<their OIDC sub>" --name "<full name>" --email <email>`
4. The superintendent signs in and adds schools, principals, teachers, families
   and students under **Administration**, or imports students with **SIS import**.
5. Schedule `docker compose --profile ops run --rm retention` nightly.
   Webhooks (`WEBHOOK_SIGNING_KEY`) are sent by the API on its own every
   `WEBHOOK_DISPATCH_INTERVAL_SECONDS` (default 60); scheduling
   `docker compose --profile ops run --rm webhooks` is optional (docs/WEBHOOKS.md).

### Without Docker
Requirements: Node.js 22+, PostgreSQL 15+.

1. `npm ci`
2. Copy `.env.example` to `.env` and configure database, session and OIDC values.
3. Create an owner role that owns the database, and a runtime role
   (`NOSUPERUSER NOBYPASSRLS`, not an owner). Compose does this for you
   (`db/init/00-eduos-roles.sh`).
4. Run migrations as the owner: `DATABASE_URL=<owner url> EDUOS_APP_ROLE=eduos_app npm run db:migrate`.
   This also applies `db/runtime_grants.template.sql` to the runtime role.
5. `npm test` (unit). Optionally run
   `EDUOS_TEST_PG_URL=postgres://<superuser>@host/postgres npm run test:integration`
   for the live PostgreSQL suite.
6. `npm start` with `DATABASE_URL` set to the **runtime** role. The server refuses
   to start as a superuser, a BYPASSRLS role or the table owner, and (32.0.54)
   against a database with missing migrations.
7. Create the district and first superintendent with the owner role:
   `DATABASE_URL=<owner url> npm run db:bootstrap -- --district "<name>" --sub <sub> --name "<name>" --email <email>`.
   (Before 32.1.0 this step was missing: nobody could sign in to a fresh install.)
8. Open the configured service URL and use district OIDC sign-in.
9. Schedule `npm run db:retention` (owner role) for data retention.
   With webhooks enabled the API sends due webhooks itself every minute; `npm run webhooks:dispatch` (owner role) is optional (docs/WEBHOOKS.md).

## Validation
32.7.0: see "Results" in `FIX-REPORT-32.7.0.md`: 375 unit tests, 81 PostgreSQL
integration tests (6 for EDEN/DECN with a hub and two nodes), 39 smoke steps, 34
desktop, 12 mobile, 20 SafetyOS and 18 learning phone steps, a 10-step EDEN
simulation (partition, failover, handback), and axe WCAG 2.1 AA with 0
violations on 112 scans.
32.6.0: see "Results" in `FIX-REPORT-32.6.0.md`: 337 unit tests, 75 PostgreSQL
integration tests (12 for the learning core and EDAL), 39 smoke steps, 34
desktop, 12 mobile, 20 SafetyOS and 18 learning phone browser steps, and axe
WCAG 2.1 AA with 0 violations on 101 scans.
32.5.0: see "Results" in `FIX-REPORT-32.5.0.md`: 324 unit tests, 63 PostgreSQL
integration tests (7 for SafetyOS and pick-up), 38 smoke steps, 34 desktop, 12
mobile and 20 SafetyOS phone browser steps, and axe WCAG 2.1 AA with 0
violations on 79 scans.
32.4.0: see "Results" in `FIX-REPORT-32.4.0.md`: 313 unit tests, 56 PostgreSQL
integration tests (7 for role apps), 36 smoke steps, 34 desktop and 12 mobile
browser steps, and axe WCAG 2.1 AA with 0 violations on 60 scans.
32.3.0: see "Results" in `FIX-REPORT-32.3.0.md`: 303 unit tests, 49 PostgreSQL
integration tests (7 for branding RLS, lifecycle, the AA gate and uploads), 31
smoke steps, 34 browser steps, and axe WCAG 2.1 AA with 0 violations on 38
scans, including branded screens.
32.2.0: see "Results" in `FIX-REPORT-32.2.0.md`. That covers 296 unit tests and
42 PostgreSQL integration tests (including cross-school isolation for the app
mesh), 30 smoke steps, 24 browser steps, axe WCAG 2.1 AA with 0 violations, the
large-district load check and the edge checks.
32.1.0: see "Results" in `FIX-REPORT-32.1.0.md`. Covers unit and PostgreSQL integration tests,
the edge checks, and the full-stack HTTP and headless-browser smoke tests run against `make up`.
32.0.54: see the "Results" section of `FIX-REPORT-32.0.54.md`: 271 unit tests,
26 PostgreSQL integration tests, and the edge lint plus `butane --strict` check.
32.0.53: see `VALIDATION-32.0.53-SECURITY-PRIVACY.md`. It covers unit tests and
24 integration tests against a real PostgreSQL 16 server, a mock OIDC provider
and the API running as a non-superuser role. Live third-party IdPs (Entra ID,
Google), Docker Compose itself and full browser end-to-end testing were not
run. This is not a production certification.

The 32.0 integration validation notes are in `docs/VALIDATION-32.0.md`. (Earlier
copies of this README pointed to `docs/VALIDATION-32.0-INTEGRATED.md`, which was
never shipped.)


Phase 32.0 adds Student 360, intervention cases, append-only case notes, and timeline APIs. See docs/VALIDATION-32.0.md for implementation scope and validation limits.


## Phase 32.0.1 quality update
- Student 360 family-facing case responses no longer include internal support-plan fields.
- Opening Student 360 from the intervention register keeps the workspace tabs available and adds a close-profile control.
- Added regression tests for both fixes.


## Latest quality update — 32.0.6

See `README-32.0.6-AGENT-ORCHESTRATION.txt` and `docs/VALIDATION-32.0.6.md` for the bounded local agent-orchestration update. The orchestration remains a synthetic browser demonstration, not an authenticated AI runtime.

## Latest quality update — 32.0.7 Operational Oversight
- Authenticated superintendent/principal agent-run metadata can be written to the append-only server audit register. Only the run ID, approved category, and exact specialist route are accepted; original questions and generated summaries are not sent.
- The Unified AI Command workspace distinguishes server-recorded runs from local-only or failed audit recording.
- The leadership audit view separates bounded agent orchestration metadata from general audit rows.
- Connected Services shows role-scoped operational notices for pending district access requests, denied actions, overdue visible intervention follow-ups, and high-priority visible cases.
- Missing operational data feeds are labeled as incomplete rather than a false all-clear.
- See `README-32.0.7-OPERATIONAL-OVERSIGHT.txt` and `docs/VALIDATION-32.0.7.md`.


## Latest security update — 32.0.10
- OIDC state cookies are now unique per authorization attempt, allowing parallel login flows in separate tabs without overwriting each other's browser binding.
- Pending OIDC transactions are expired and bounded to 1,000 entries to limit memory growth.
- Callback state is consumed once and oversized state values are rejected.
- ID-token authorized-party (`azp`) validation is enforced for multiple audiences and whenever the claim is present.
- See `README-32.0.10-SESSION-HARDENING.txt` and `docs/VALIDATION-32.0.10.md`.


Latest integrated UI update: EduOS 32.0.11. See `README-32.0.11-UI-REFRESH.txt` and `docs/VALIDATION-32.0.11.md`.


## Release 32.0.15 — Project Artwork Expansion
See `README-32.0.15-PROJECT-ARTWORK-EXPANSION.txt` and `docs/VALIDATION-32.0.15.md`.


## 32.0.23 deployment hardening

See `README-32.0.23-DEPLOYMENT-HARDENING.txt` and `VALIDATION-32.0.23.md` for edge network isolation, proxy trust, cache policy, and test limitations.


## Release 32.0.52 — Arrival & Transportation Handoff

See `README-32.0.52-ARRIVAL-TRANSPORTATION-HANDOFF.md` and `VALIDATION-32.0.52-ARRIVAL-TRANSPORTATION-HANDOFF.md` for details and test scope.
