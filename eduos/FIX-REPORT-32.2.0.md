# EduOS 32.2.0: no product limits, district resource mesh, a home for every role

What was asked: remove limits; let a district mesh its school resources so that
an app bought once can be used across the whole system; improve the experience
for every role. This report covers what changed, how it was checked, and what
was not checked. Operator actions are in `docs/UPGRADING-32.2.0.md`. The full
limits inventory is in `docs/LIMITS.md`.

## 1. Limits

There are no plan tiers and no fixed maximum number of schools, students,
users, webhooks or apps. Every remaining limit is one of three kinds:
- an **opt-in district cap** (unlimited by default);
- **paging** (large lists come back in pages instead of being cut off);
- a **security or reliability limit**. These stay on purpose and can be configured.

| Limit before (32.1.0) | Now (32.2.0) |
|---|---|
| 13 list endpoints silently cut off at 25–2,000 rows | Paged with `?limit`/`?offset` (default 200, maximum 1,000) and `page.nextOffset`. Students add `page.total` and `?q=` search; users add `?q`, `?role` and `?schoolId` |
| Audit CSV export: newest 5,000 events | Streams every event in keyset chunks of 2,000, with backpressure |
| SIS import: 5,000 students and 10,000 attendance rows per batch; 5 MB body | No row cap. Rows are written set-based in chunks of 2,000. The body is bounded by `SIS_IMPORT_MAX_MB` (50) and parsed only after the session, CSRF token and permission checks |
| 10 active webhooks per district | Unlimited. Optional district cap `max_active_webhooks` |
| Webhook fan-out: 10 subscriptions per event; deliveries **dropped** above 16 in flight | Every subscription receives the event. Deliveries queue behind `WEBHOOK_MAX_IN_FLIGHT` instead of being dropped |
| Guardian invitations: 20 per hour per IP | 1,000 (`GUARDIAN_INVITE_RATE_LIMIT_PER_HOUR`) |
| Webhook admin: 40 per 15 minutes | 200 (`WEBHOOK_ADMIN_RATE_LIMIT_PER_15M`) |
| Flow-event counters at most 100,000 | 1e9 |
| `SESSION_MAX_PER_USER` range 1–50 | 1–1000 |
| (none) | District caps `max_schools`, `max_students`, `max_users`, `max_active_webhooks` and `max_apps`. All are NULL (unlimited) by default. Set them under **District settings** or with `PATCH /api/district/settings` |

**Kept as security limits, configurable:**

| Limit | Default | Why it stays |
|---|---|---|
| Login rate limit (`LOGIN_RATE_LIMIT_PER_15M`) | 600 per IP | Slows guessing attacks |
| Invitation accept (`GUARDIAN_ACCEPT_RATE_LIMIT_PER_15M`) | 10 per IP | Protects one-time tokens. It triggered during repeated test runs on this box and returned 429 as designed |
| Flow events (`FLOW_EVENT_RATE_LIMIT_PER_MIN`) | 120 | Stops one client from flooding feeds |
| JSON body (`JSON_BODY_LIMIT`) | 256kb | Memory DoS protection |
| SIS body (`SIS_IMPORT_MAX_MB`) | 50 MB | Memory DoS protection; only authorized importers can reach it |
| Page size (`PAGE_SIZE_MAX`) | 1000 | Bounds the cost of one request |
| Sessions (`SESSION_MAX_PER_USER`, `SESSION_CACHE_MAX`) | 5 and 5000 | Containment for a stolen account; memory bound |
| CSRF, session idle timeout and TTL, OIDC state, webhook SSRF guards | unchanged | |

**Measured on a seeded large district.** The demo district was grown to 50
schools and 50,024 students through the real API with `node dev/seed-large.mjs`
(local dev stack, one app container, PostgreSQL 16 in Docker, 8 vCPU box; run on
Nov 10, 2026, about 10:50 EST). Timings are client-side through the Caddy HTTPS
edge.

| Operation | Time |
|---|---|
| 50 SIS CSV batches: 50,000 students + 50,000 attendance events | 9.4–11.6 s total; median 238 ms per 1,000-student batch, max 280 ms |
| One SIS batch of **50,000 students** (1.7 MB CSV, more than 10× the old cap) | 2.5 s |
| Re-import of 1,000 existing students (updates) | 41–47 ms |
| `GET /api/students?limit=1000`, first page with total (50,024) | 55–88 ms |
| Same, deepest page (offset 49,024) | 81–103 ms |
| Walk all 51 pages (50,024 rows) | 4.5–4.7 s |
| Search by name or student-number prefix | 30–36 ms |
| Superintendent home dashboard | 17–46 ms |
| `/api/users`, `/api/attendance`, `/api/apps-usage`, teacher launcher | 5–7 ms each |
| App launch (seat claim + launch row + audit) | p50 6 ms, max 9 ms |
| Audit export (streamed) | 14 ms for 721 events |

App container memory after the run: 66 MiB; the database used 69 MiB.
The raw numbers are in `/workspace/review/large-district-32200.json`.
After the single 50k batch the demo district holds about 100k students. The
browser smoke then ran against it and passed: the directory loads the first 100
students by name, and search finds the rest.

## 2. District resource mesh (apps bought once, used everywhere)

**Model** (migration `db/010_district_resource_mesh.sql`, all tables under RLS with FORCE):
- **`apps`** is the catalog: name, vendor, category, launch URL, and how it connects (`link`, `oidc_sso`, `lti13` or `api`, plus up to 8 KB of config; keys mentioning secrets are refused). It also records:
  - privacy data: `data_sharing_scope` (none, identity, roster_basic, roster_full, grades or attendance), DPA/SDPC status and expiry, a COPPA flag and a FERPA school-official flag;
  - `owner_school_id`, which is NULL when the district owns the app and set when a school bought it.
- **`app_licenses`**: seat-limited or unlimited (`seat_limit` NULL), with start and end dates and the purchasing school.
- **`app_assignments`** say who can open an app. The scope is the whole district or one school, optionally narrowed to grade levels and to roles (principal, teacher, parent, pupil). A school that owns an app can share it with other schools (`shared_by_school_id`).
- **`app_requests`**: principals and teachers request a catalog app or a new one, and the district approves or denies. Approving a catalog app assigns it to the requesting school.
- **`app_seats`** (one seat per person per license, claimed by the SECURITY DEFINER `eduos_claim_seat`) and **`app_launches`** (append-only).
- **IT admin role (`it_admin`)**: district-wide for schools, accounts, SIS, webhooks, audit and apps, but with **no student-record permissions**. IT admins cannot create, grant or edit superintendents or other IT admins, and they cannot grant themselves anything.

**Isolation rules.** These are enforced in PostgreSQL, not only in the API:
- Sharing an app grants the right to **launch** it and nothing more. It never grants access to student records at another school.
- Launches, seats and requests have RESTRICTIVE `own_scope` policies:
  - district roles see the whole district;
  - a principal sees their own school;
  - everyone else sees only their own rows.
- Cross-school usage is visible only as **aggregate counts** through `eduos_app_usage()`:
  - district roles and the principal of the owning school see every school;
  - any other principal sees only their own school.
- Launch checks, in order:
  1. The app, a current license and a matching assignment (role, school, grade) must all exist.
  2. Students and families cannot open an app that shares student data unless there is a current signed DPA.
  3. Students in grade 7 or below cannot open apps that are not marked COPPA-compliant.
  4. A seat must be free (`409 no_seats_available` when the license is full).
- Every launch is audited with the app's data-sharing scope. Catalog, license, assignment, request and decision changes are audited and emitted as webhook events: `app.registered`, `app.licensed`, `app.assigned`, `app.unassigned`, `app.retired`, `app.requested` and `app.request.decided`.

**LTI 1.3.** EduOS acts as the platform:
- RS256 key from `LTI_PLATFORM_PRIVATE_KEY`; the public key is published at `/.well-known/jwks.json`.
- Third-party-initiated login with an HMAC-signed `lti_message_hint` (5 minutes, single use) and `/lti/authorize`, which accepts registered redirect URIs only. URLs must be https, except loopback for development.
- Claims follow the data-sharing scope. `none` sends a pairwise `sub` and roles only; `identity` adds name and email. No roster, grade or attendance data is ever sent.

**Verified:**
- PostgreSQL integration test `test/integration/mesh.test.js`: 9 tests against real PostgreSQL 16, as the non-owner runtime role. They cover:
  - the IT admin role;
  - webhooks with no cap;
  - district caps;
  - seat exhaustion and the privacy gates;
  - **cross-school isolation**: direct SQL through the app role under each actor shows no foreign launches, seats or requests and no foreign students, and cross-district reads return nothing;
  - requests;
  - LTI end to end, verified with `jose` (a forged hint, a wrong redirect and a reused hint are all refused);
  - home dashboards;
  - paging and the uncapped SIS import.
- Live stack (`make smoke`, 30 steps):
  - the IT admin cannot read students or create a superintendent;
  - the district-bought MathQuest is open to every school; Lincoln Middle's own app is shared with Riverside teachers only, and Riverside students cannot open it;
  - the Lincoln principal still gets 404 for a Riverside student and sees usage for their own school only;
  - LTI launch through `dev/lti-tool.js`: the tool verifies the signature against the JWKS, and a reused hint is refused;
  - a principal's request is approved by the district;
  - the grade-1 learner gets the simplified home.

## 3. Experience for every role

Everyone now lands on **Home**. Every role gets clear, role-specific tabs in
plain language and a "What needs attention" list linked to the right tab.
The launcher opens apps in a new tab with no opener.

| Role | Home | Other changes |
|---|---|---|
| Superintendent | Schools, students, people, catalog apps, launches in the last 30 days, absences; pending access and app requests; urgent cases | **Apps** (catalog with privacy badges, licenses, "available to", manage panel for licenses, assignments by school, grade and role, usage and retire), **App requests** (approve or deny), **District settings** (caps; blank means no limit). Student search and "Load more" |
| IT admin (new) | Schools, accounts, active apps, webhooks, SIS imports; integration health (webhooks, LTI, SIS failures); expiring licenses; apps missing a DPA | Administration for schools and school-level accounts at any school; SIS, webhooks, audit, apps. No student tabs |
| Principal | Students, teachers, absent today, open cases, apps available; overdue follow-ups, unaccepted invitations, pending app requests; app launcher | Apps: register an app the school bought, license it, share it with other schools (school directory picker), request district apps |
| Teacher | Roster size, published work, submissions to grade, absences this week; drafts to publish; launcher | "My apps", requests |
| Student (grade 3+) | Due this week, past due, recently graded; launcher | Tabs: Home, My apps, My work, Attendance |
| Student (K–2) | **Simplified**: "Hi, Leo!", one large "My work" button with a count, large app tiles without metadata | Same tabs |
| Parent/guardian | One card per child: due this week, past due, recently graded, absences, attendance notes to acknowledge, shared support plans; a "Link a child" call to action when no child is linked | Plain names: Schoolwork, Support plans, Link a child. Accepting an invitation lands on Home |

**Across the UI:**
- Friendly error messages: 401, 403, 409 and 429 errors, network failures, and specific codes such as `no_seats_available`.
- Loading state through `aria-busy`, with submit buttons disabled while saving; empty states for every table.
- Tabs live in a `nav` landmark with `aria-current`. The page has an `<h1>`, content updates are announced through `aria-live`, and focus returns to the content.
- Every input has a label; tables have `th scope` and captions; scrollable tables are focusable regions.
- Responsive tabs, grids and forms at 760 px and below; reduced motion is respected.

**Accessibility.** axe-core 4 (WCAG 2.0/2.1 A and AA rules) ran inside the
headless-browser smoke on 28 screen states: every role's home on desktop and
at 390 px, plus students, audit, apps, app management, requests, district
settings, assignments, rosters and people. The first run found 28 violation
groups: insufficient contrast in small table text and the notices heading,
and launcher buttons whose accessible name did not include their visible
text. Those were fixed. The final run had **0 violations**
(`/workspace/eduos-screens/32.2/axe-report.json` is `[]`).

## Results (Tuesday Nov 10, 2026, EST, on the box)

| Suite | Result |
|---|---|
| Unit (`npm test`) | 296/296 |
| PostgreSQL 16 integration (incl. mesh isolation) | 42/42 (9 new in `mesh.test.js`) |
| `make smoke` (live stack, upgraded in place from the 32.1.0 database) | 30/30 (5 new mesh/role steps) |
| Headless-browser smoke (Chrome, Playwright) | 24/24, no page errors |
| axe-core WCAG 2.1 A/AA | 28 scans, 0 violations |
| Large-district load check | see section 1 |
| Edge Python unit tests | 30/30 |
| `make -C edge-platform/eduos check` (butane --strict) | pass |

Screenshots are in `/workspace/eduos-screens/32.2/`. Files ending `m-…-mobile.png` are 390 px wide; `browser-smoke.log` and `axe-report.json` are alongside.

## Not verified
- LTI 1.3 with a real vendor tool. Only the bundled `dev/lti-tool.js` and the jose-based test were used. Deep linking, Names and Roles (NRPS) and Assignment and Grade Services (AGS) are not implemented.
- Real OIDC SSO sign-in to a vendor app. `oidc_sso` apps launch to the vendor URL and rely on the vendor federating with the district IdP.
- LTI login hints are single-use per API process. With several API instances, a hint could be replayed once on another instance inside its 5-minute life. Use sticky sessions or a single instance until a shared store is added.
- Student paging uses OFFSET. A deep page costs about 100 ms at 50k rows, which is fine but grows linearly. Keyset paging is used only for the audit export.
- Screen-reader walk-throughs (NVDA, VoiceOver) and manual keyboard-only testing were not done; axe covers only the automated rules.
- The demo catalog in the screenshots also contains apps created by repeated smoke runs ("Browser App …", "Dbg App …").
- Production-compose and non-Docker deployment of 32.2.0 were not re-run. The dev stack was upgraded in place: migration 010 applied cleanly over the 32.1.0 database.
