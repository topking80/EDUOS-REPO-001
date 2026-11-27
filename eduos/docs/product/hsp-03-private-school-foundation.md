# HSP-03 — Independent private school foundation

Status: built, on the HSP-00 tenancy design.

Code:
- migration `db/162_hsp03_private_school_foundation.sql`;
- `src/private-school-routes.js`;
- `src/private-school-verify.js` (`npm run ps:verify`);
- private-school sessions in `src/auth.js` and `withPrivateSchoolTransaction` in `src/db.js`;
- the workspace in `public/app/app.js`.

Tests: `test/integration/private-school.test.js` (real PostgreSQL, non-owner runtime role) and the private-school case in the browser smoke test.

## What's here

- **A private school is its own tenant** (`tenants.kind = 'private_school'`). It is never a district or a district's school, and no district or family table changed.
- **Registering.**
  - Anyone signed in with a verified email can register a school: its legal name, the name families see, a first campus, an optional website domain and jurisdiction. They become its first **school administrator**.
  - The school starts **waiting for verification**. It can set up campuses, staff and its profile, but holds **no learner records**: enrolling learners and inviting guardians wait until it's verified. The database enforces this as well.
  - Each person can have at most 3 schools waiting.
- **Verification by the platform.** Someone on the platform checks the school's identity out of band (state registry, incorporation papers, the domain), then runs:

  ```
  DATABASE_URL=<owner URL> npm run ps:verify -- --school <id> --ref "<evidence reference>" --by "<reviewer>" [--domain-verified]
  ```

  - The same command suspends (`--suspend`), reactivates (`--reactivate`) or closes (`--close`) a school. It closes only after the school asks, or after it was suspended.
  - Suspending or closing ends the school's sessions.
  - Each action is written to the school's audit trail as the platform.
  - Changing the website domain later makes it unverified again.
- **Campuses:** one or more, added and closed by the school administrator. A campus with enrolled learners can't be closed.
- **Roles**, one per membership (a person may hold several; each session is for one):
  - **School administrator:** everything; the school always keeps at least one.
  - **Campus administrator:** their campus's learners, guardian invitations and calendar.
  - **Registrar:** every learner (enrolling, changing and withdrawing them), and guardian links.
  - **Teacher** and **staff:** their campus's learners, read only for now (class rosters come in HSP-04).
  - **Finance:** no learner records, a deliberate separation of duties; billing comes in HSP-05.
  - **Guardian:** only the children linked to them, and only themself in the people list.
- **Invitations:**
  - bound to an email, single-use, 7 days, shown once;
  - the school administrator invites anyone;
  - the registrar and campus administrators invite guardians, naming their children.
- **Learners:** name, grade, campus, optional student number (unique in the school), and enrollment and withdrawal dates and reasons.
- **Calendar:** term dates, holidays, closures, events and meetings, for everyone or staff only, school-wide or per campus. Written by the school or campus administrators.
- **Branding:** colors and a mascot name. **Time zone and jurisdiction** are profile settings. No rules are inferred from the jurisdiction.
- **Lifecycle:**
  - the school administrator can **export** the school's records as one file;
  - and **ask to close** the school; the platform confirms and closes it.
  - Removing a member ends their school sessions, and a guardian's links with them.
- **Audit:** append-only `private_school_audit_events` for every action, including the platform's. The school administrator sees everything; others see their own actions.

## Isolation

- **One context per session.**
  - A private-school session sets `app.private_school_id` and the session's membership (`app.ps_membership_id`), with empty district and family settings.
  - District routes answer `district_context_required`. Private-school routes from other sessions answer `private_school_context_required`, except registering and accepting an invitation.
  - Rules read only the session's own membership. A membership ID with someone else's user matches nothing.
- **Every private-school table has forced RLS:** isolation by school, membership required, and restrictive policies per role and campus. They're checked as the runtime role from another school's context and a district's.
- **The runtime role can't change a school's status**, verification or domain verification; only the owner (`ps:verify`) can.

## Not yet

- **HSP-04:** admissions (inquiry, application, offer, waitlist), class rosters and schedules, attendance, learning and report cards.
- **HSP-05:** tuition and fees, with finance's billing records.
- Linking a private school to a district or state program; that needs an explicit agreement, as in FED-06.
- Automated domain checks: the platform confirms the domain by hand with `--domain-verified`.

Nothing here claims accreditation or compliance. The workspace says EduOS doesn't accredit schools or file anything with any agency.
