# HSP-01 — Homeschool family workspace

Status: built, following the reviewed HSP-00 design (`docs/product/hsp-00-architecture-and-tenancy.md`).

Code:
- migration `db/160_hsp01_family_tenancy.sql`;
- `src/homeschool-routes.js`;
- the context switch and family sessions in `src/auth.js`;
- `withFamilyTransaction` and `withUserTransaction` in `src/db.js`;
- the workspace in `public/app/app.js`.

Tests: `test/integration/homeschool.test.js` (real PostgreSQL, non-owner runtime role) and the homeschool case in `test/browser/app-smoke.test.js`.

## What's here

- **A family is its own tenant** (`tenants.kind = 'homeschool_family'`). Every district got a `tenants` row too, and nothing about districts changed.
- **Starting a family.** Anyone signed in with a verified email can create one (`POST /api/homeschool/families`, up to 5 owned). They become its owner.
- **Members.**
  - **Roles:** owner, co-educator and guardian (view only).
  - **Joining:** the owner invites by email. The link is shown once and lasts 7 days. It works only for someone signed in with that verified email, only once, and only until it's withdrawn.
  - **Managing:** the owner can make others owners or hand ownership over. A family always keeps at least one owner. Removing a member ends their family sessions at once and revokes their learner relationships.
- **Learners** belong to the family. They aren't district students and have no sign-in. Each learner has a name, a grade band and an optional birth year.
- **Authority per learner:**
  - the owner has full authority over every learner;
  - an invited co-educator *teaches* (educational authority) only the learners named in the invitation;
  - a guardian *views* only theirs;
  - the owner can add or revoke relationships later.
- **The dashboard** shows each learner the person can see, with their events this week, plus family-wide events.
- **The calendar** holds lessons, field trips, co-op days, appointments and breaks, for the whole family or for one learner.
  - The owner writes anything.
  - A co-educator writes only for learners they teach.
  - Viewers read only.
  - Each person sees family-wide events plus events for learners they have authority over.
- **The audit trail** (`family_audit_events`, append-only) records every family action. The owner sees all of it; others see their own.
- **Environments.**
  - `GET /api/session/contexts` lists the person's school roles and families.
  - `POST /api/session/context` opens a new session for one of them.
  - The app's Account page has a **Homeschool** card to start or open a family, and the workspace has a switcher back to school roles.
  - Someone who belongs only to a family signs in straight into it.

## Isolation (the HSP-00 test plan)

- **One context per session.** A family session sets `app.family_id` and an empty `app.district_id`, so every district table's RLS matches nothing.
- **District routes are refused** in a family session (`district_context_required`). Family routes are refused in a district session (`family_context_required`), except creating a family and accepting an invitation.
- The family comes only from the session. A `familyId` in the request is ignored; the tests check this.
- Every family table has forced RLS: isolation by family, plus restrictive policies for role and per-learner authority. These are checked as the runtime role from both directions.
- `tenants` is owner-only. Families are created by `eduos_create_family()` and joined by `eduos_accept_family_invitation()`, both checking the session's user.
- IDOR: IDs from another family give 404. A revoked member's session stops working at once.

## Not yet (later HSP slices)

- **HSP-02:** learning plans, attendance and instructional time, parent-entered work and grades, progress reports and transcript or portfolio exports.
- Learner sign-ins. Signing in to a family from the native app; native sign-in still opens a school role.
- Account recovery or ownership disputes beyond sharing ownership.
- Family retention settings.
- **HSP-06:** moving a learner between a family and a school.
- **HSP-07:** co-ops.

No compliance or accreditation is claimed. The workspace says its records are family records, and that EduOS files nothing with any agency.
