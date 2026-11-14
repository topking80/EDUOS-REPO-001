# Getting started with EduOS 32.7.0

This runs the complete platform on your machine with **synthetic data only**:
PostgreSQL, migrations, the API, the Caddy HTTPS edge, a local sign-in provider
and a seeded demo district. Nothing is published to the internet.

## Requirements
- Docker Engine 24+ with the Compose plugin (v2.20+)
- `curl`
- Node.js 22+ (only for the smoke tests)
- Free local ports 8443 (HTTPS), 8088 (HTTP) and 9400 (sign-in provider).
  To use other ports, set `EDUOS_HTTPS_PORT`, `EDUOS_HTTP_PORT` or
  `EDUOS_DEV_IDP_PORT` before the first `make up`.

## Start
```sh
make up            # or ./scripts/dev-up.sh
```
The first run builds the images. It also writes `.env.dev` with random
secrets (mode 600, git-ignored) and picks an unused internal subnet for the
edge network. Then it starts the stack, migrates, seeds the demo district and
prints the URL and the demo accounts. Running it again is safe: data is kept and
the seed is idempotent.

Open **https://localhost:8443/**. The certificate comes from Caddy's local CA,
so either accept the browser warning or run `make trust-ca` and import
`caddy-local-root.crt` into your OS or browser trust store.

## Sign in
Click **District sign-in**. The local provider at http://localhost:9400 lists the
demo accounts; click one. EduOS still runs the full OpenID Connect code flow
(PKCE, nonce, signed ID token), and only provisioned accounts get in.

Everyone lands on **Home**, a summary of what needs their attention.

| Account | Role | Try |
|---|---|---|
| Dr. Maya Chen | superintendent | Home; **Apps** (district catalog: licenses, who can use each app, usage); **App requests**; **District settings** (optional caps, blank = no limit); Administration, SIS import, Webhooks, Audit, FERPA export/delete in a student profile |
| Jamie Rivera | IT admin | Integration health on Home; register an app under Apps; accounts and schools under Administration; no student records |
| Samuel Okafor | superintendent | second approver for access requests |
| Elena Ruiz | principal, Riverside Elementary | Home; Apps (request "Story Builder" from the district); People, Rosters, Guardian invitations, Audit |
| Marcus Bell | principal, Lincoln Middle | his school owns "Lincoln Lab Notebook" and shares it with Riverside teachers; sees only his school's records and usage |
| Jordan Lee | teacher (4 students) | Home launcher (open MathQuest); Assignments: save a draft, publish, grade; attendance; cases |
| Priya Natarajan | teacher (2 students) | roster scoping |
| Alex Morgan | parent of Ava | family view: children, assignments, attendance acknowledgement |
| Taylor Brooks | parent, not linked yet | guardian invitation flow (below) |
| Ava Morgan | student, grade 4 | Home, My apps, My work (Submit work) |
| Leo Park | student, grade 1 | the simplified home for young learners: big buttons and app tiles |
| Dana Whitfield | bus driver, Riverside | the mobile app only: Bus 7 route, stop-by-stop check-ins |

To try **another account**, create it as Dr. Chen under Administration.
Choose any subject, for example `new-teacher`. Then sign in with that subject in
the "Another provisioned account" box on the sign-in page.

**Apps bought once, used everywhere:** as Dr. Chen open **Apps** and click
**Manage** on an app to add a license (blank seats = unlimited) and give access
to the whole district, or to chosen schools, grades or roles. Teachers,
students and families then see the app on their Home. Sharing an app lets
people open it; it never shares student records between schools.

**School branding:**
1. As Elena Ruiz, open **School branding**. Riverside Elementary comes seeded
   with the Otters: blue, teal and gold.
2. Try a preset or edit one tile, and switch the previews between Teacher,
   Student, Young student and Parent.
3. Set a tile's label color to white on the gold accent. The accessibility
   check flags it, and **Publish** is refused until you click
   "Use suggested shade".
4. Publish, then sign in as Jordan Lee, Ava Morgan, Leo Park or Alex Morgan to
   see it. Lincoln Middle (Marcus Bell) has its own Lynx branding.
5. **High contrast** in the header switches any user to a black-and-white theme.
6. A branded sign-in page:
   `https://localhost:8443/?school=00000000-0000-4000-8000-000000000001.00000000-0000-4000-8000-000000000101`.

**Mobile role apps (32.4.0):** open `https://localhost:8443/app/` (best in a
phone-sized window or the browser's device mode) and sign in.
1. **Ava Morgan:** Home, then **Christie**. Start a practice and answer
   wrong: you get a hint, never the answer. Ask "just tell me the answer" and
   Christie refuses.
2. **Jordan Lee:** Grading queue, Courses > My roster, and the **Christie** copilot. Use
   "Read conversation" to review Ava's session.
3. **Dana Whitfield (driver):** Route shows today's AM run for Bus 7. Tap
   **Boarded** for a rider at a stop. No location is ever collected.
4. **Alex Morgan:** **Arrival** shows Ava's check-ins, **Alerts** shows
   "Ava boarded Bus 7", and **Messages** has a thread with Jordan Lee with
   read receipts.
5. **Elena Ruiz:** Overview, Transport, and moderation of reported messages.
Email, SMS and push are off; `make notify` shows the dry-run dispatcher.

**SafetyOS and car pick-up (32.5.0):** in `/app/` (try several phone windows).
1. **Alex Morgan:** **Pick-up** lists who can collect Ava (Ruth Morgan approved,
   Sam Rivera waiting). Tap **Show my pick-up pass** for a QR and code.
2. **Jordan Lee:** **Classes > Pick-up duty**. Type `RTHM2-AVA4K` (Ruth), Check
   pass, tick the photo-ID box, Release. Try `PATB7-N0AH5`: **DO NOT RELEASE**.
3. **Jordan Lee:** the shield button in the header > Lockdown > Drill >
   Continue > **Yes, start drill**. Ava, Dana (driver) and Alex now see the
   full-screen LOCKDOWN (DRILL). Mark the roll call and **Send roll call**.
4. **Elena Ruiz:** the accountability board. Start reunification ("Gym"); Alex
   shows a pass, Jordan releases Ava through **Pick-up line**, Alex sees
   "Released to ...". Then **All clear** and write a debrief from the shield
   button. Elena's **Pick-up > Approvals** has adults, early dismissals and
   custody / do-not-release orders.
`make smoke-safety` runs this whole walkthrough headless with screenshots.

**School nodes, EDEN and DECN (32.7.0):** after `make up`, run `make eden-sim`.
- It starts two simulated school nodes:
  - Riverside Elementary at <http://localhost:8501/app/>;
  - Lincoln Middle at <http://localhost:8502/app/>.
- It walks through the whole story headless, with screenshots: enrollment,
  gated aggregates, a phone losing signal, a district uplink partition, a
  node failure with failover to the partner, and automatic handback.
- Afterwards, explore by hand:
  - **Dr. Maya Chen** on the main site: `/app/` > **Nodes**.
  - **Elena Ruiz** on <http://localhost:8501/app/>: **School** > **Node
    details**.
- `make eden-sim-down` stops the nodes.
- How it works, and what is only simulated: `docs/EDEN-32.7.0.md`.

**Learning core and EDAL (32.6.0):** in `/app/`.
1. **Ava Morgan:** go to **Courses** > Grade 4 Math: Fractions.
   - Tap **How is this calculated?** next to a standard to see the evidence
     behind it.
   - Open **Quiz: Comparing fractions**. The timer includes Ava's +25% extra
     time, and **🔊 Read aloud** uses an on-device voice only. Answer and
     submit to see the results.
   - In Grade 4 Reading, open *The first flight* for the Library of Congress
     photograph and telegram.
2. **Jordan Lee:**
   - **Courses > Gradebook** shows Noah's missing poster in red. Post a
     final grade from there.
   - **Grading** has the quiz review and the rubric grading queues.
   - **Courses > Open course** has per-learner accommodations. **My roster**
     is under Courses now.
3. **Alex Morgan:** **Children > Grades & progress** shows Ava's grades,
   standards ("Why?"), teacher feedback, last year's final grade and
   credential. **Check record** shows the EDAL proof.
4. **Elena Ruiz:** the **Learning** card on the overview.
   - **Approvals** has a lesson waiting before Christie may use it.
   - **Records ledger** verifies the chain. **Save checkpoint** gives you the
     JSON to keep outside EduOS.
`make smoke-learning` runs this walkthrough headless with screenshots.
`make edal-verify` checks the ledger from the command line. EDAL is a hash
chain in PostgreSQL, not a blockchain.

**LTI 1.3 demo:** `make up` puts an LTI key in `.env.dev`. Run
`node dev/lti-tool.js`, then open "Science Lab (LTI demo)" as Jordan Lee. The
tool shows the signed claims EduOS sent.

**Guardian invitation:**
1. As Elena Ruiz, open Guardian invitations, choose a student and enter
   `parent-invitee@riverside-usd.example`.
2. Copy the one-time link.
3. Sign out, open the link, sign in as Taylor Brooks and accept.

## Stop
```sh
make down            # stop, keep data
make down-volumes    # stop and delete the database, the local CA and .env.dev
```

## Check it
```sh
make smoke           # 39-step HTTP end-to-end test against the running stack
make smoke-mobile    # phone-viewport (390x844) pass over every role app, axe on each screen
make smoke-browser   # desktop + mobile headless Chrome pass: screenshots per role (desktop and 390px) to artifacts/screens,
                     # plus an axe-core WCAG 2.1 AA scan if axe-core is installed next to playwright-core
node dev/seed-large.mjs   # grow the demo district to 50 schools / 50,000 students and time the API
make test            # unit tests (no database needed)
```
`make smoke-browser` needs Chrome or Chromium, and `playwright-core` installed
*outside* the repo:
```sh
npm i --prefix ~/tools/pw playwright-core axe-core
EDUOS_PLAYWRIGHT_DIR=~/tools/pw make smoke-browser
```

Other shortcuts are `make logs`, `make ps`, `make seed` and `make retention`.
`make metrics` prints the Prometheus metrics. They are served only on the app's
internal port, with the `METRICS_TOKEN` from `.env.dev`.

## Troubleshooting
- **"address already in use"**: another service has 8443, 8088 or 9400. Run
  `make down-volumes`, set the `EDUOS_*_PORT` variables and run `make up` again.
- **Pool overlaps with other one on this address space**: a Docker network
  already uses the edge subnet. `make down-volumes && make up` picks a free one.
  For a real deployment, set `EDUOS_EDGE_SUBNET`, `EDUOS_EDGE_IP` and `EDUOS_EDGE_IP_RANGE`.
- **Sign-in says "account is not provisioned"**: that identity has no EduOS
  account. Create it under Administration first.

## This is not production
The local sign-in provider lets anyone sign in as anyone. It ships only in the
`devtools` image target, and it refuses to start with `NODE_ENV=production`.
The API refuses it in production, and production also requires an https issuer.
The seed needs `EDUOS_ALLOW_DEMO_SEED=true` and also refuses production.

For a real deployment see README.md, section "Deploy with Docker Compose", and
`docs/UPGRADING-32.7.0.md`, `docs/UPGRADING-32.6.0.md` (and earlier `docs/UPGRADING-*.md`).
