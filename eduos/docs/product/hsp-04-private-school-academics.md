# HSP-04 — Private school admissions and academics

Status: built on HSP-03.

Code:
- migration `db/163_hsp04_private_school_academics.sql`;
- `src/private-school-academics-routes.js`;
- the school workspace, class page and report card page in `public/app/app.js`.

Tests: `test/integration/private-school-academics.test.js` (real PostgreSQL, non-owner runtime role) and the private-school case in the browser smoke test.

## Admissions

The lifecycle, one step at a time. Anything else is refused (`not_a_next_step`):

```
inquiry → applied → under review → offered | waitlisted | not offered
waitlisted → offered | not offered            offered → accepted | declined
accepted → enrolled (the applicant becomes a learner)
any open step → withdrawn
```

- **Who runs it:** the school administrator, the registrar, or a campus administrator for their campus, and only in a **verified** school. Teachers, finance and guardians don't see applicants.
- **Applicants aren't learners.** Their name, grade, school year, campus, guardian contact, document checklist (received or not) and notes stay in admissions. Only **enrolling** an accepted applicant creates the learner record, with an optional student number. The registrar then invites the guardian, whose email is already on the application.
- **Decisions:** offered, waitlisted and not offered record who decided and when.
- **Waitlist:** positions are kept per campus and year (next in line unless a position is given).
- **Re-enrollment:** a current learner can apply for another school year (one open application per year).
- **History:** every change is in an append-only history.

## Classes, schedules and rosters

- **Classes:** a name, subject, grade, school year and term, on a campus, with an optional teacher from that campus.
- **Schedule:** weekly meeting times with rooms.
- **Rosters:** learners from the class's campus.
- **Who changes them:** the school administrator, the registrar, or the campus's administrator.
- **This week:** each person sees the meetings they can see. A teacher sees their own classes; a guardian sees their children's classes.

## Attendance

- **Per class:** marked by its teacher or the campus's administrators.
- **Daily:** marked by the registrar or the campus's administrators.
- **Marks:** present, tardy, absent or excused, with a note.
- **Rules:**
  - no future dates;
  - only learners on the class roster;
  - one live mark per learner, day and class.
- **Changes:** a changed mark voids the old one (kept, with its reason); unchanged marks are left alone.
- **Summary:** a learner's daily totals.

## Report cards

- **Drafts:** the registrar, school administrator or campus administrator starts a learner's card for a term (one per learner, year and term).
- **Lines:** each class's teacher writes their own line (grade and comment) for learners on their roster while it's a draft. The page lists classes still to write.
- **Publishing:** the registrar, school administrator or campus administrator publishes the card; after that it can't change.
- **Families:** **guardians see a card only once it's published**, and only for their own children.

## Who sees what

Everything builds on HSP-03's scopes:
- school administrator and registrar: the whole school;
- campus administrator, teacher and staff: their campus;
- guardian: their own children, including only their child on a class roster;
- finance: no learner or academic records.

Row-level security enforces the same, keyed to the session's own membership. A district, a family or another school sees none of it, which the tests check as the runtime role.

## Not yet

- A public admissions form for families: inquiries are entered by staff for now.
- Assignments and a gradebook for private schools; report-card grades are entered per term.
- Transcripts, and moving records to another school (HSP-06).
- Tuition, deposits and fees (HSP-05).

Nothing here claims accreditation or compliance with any rule on attendance or reporting.
