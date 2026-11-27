# HSP-02 — Homeschool learning operations

Status: built on HSP-01.

Code:
- migration `db/161_hsp02_homeschool_learning.sql`;
- `src/homeschool-learning-routes.js`;
- `src/homeschool-reports.js` (pure);
- the learner page in `public/app/app.js`.

Tests: `test/homeschool-reports.test.js`, `test/integration/homeschool-learning.test.js` (real PostgreSQL, non-owner runtime role), and the homeschool learner case in the browser smoke test.

## What's here

For each learner in a homeschool family:
- **Plan:** courses for a school year (like `2026-2027`) and learning goals, each optionally under a course.
  - A course is completed with a final grade, credits and a completion date.
  - A goal is open, met or dropped.
- **Attendance and instructional time:** sessions by day, with minutes and a kind: instruction, field trip, co-op, independent study, or absent with 0 minutes.
  - Totals give instructional days, absent days, minutes and hours, by kind.
  - Dates in the future are refused.
- **Work and evidence:** assignments, projects, tests, reading, activities and certificates, with an optional score out of a maximum or a grade label.
  - Each record carries its **provenance**: *entered by the family*, or *entered by the family from* a named outside source such as an online course or test.
  - EduOS doesn't verify either.
- **Corrections:** attendance and work are corrected by voiding with a reason, never deleted. Voided records stay on file, marked, and are left out of totals and reports.
- **Records:**
  - a **progress report** for a period: attendance totals, each course's work count and percent (scores over maximums), and goals;
  - a **transcript**: completed courses by school year with grades and credits, and total credits;
  - a **portfolio**: work in a period, with provenance.

  Each names its issuer (the family) and carries this statement: *Family record, entered by the family named here. Not verified by EduOS or any school, and not an official, state-approved or accredited transcript. Requirements vary by state; check with your education authority.*
- **Exports:** a progress report can be viewed by anyone with authority over the learner. **Exporting** any record needs **full authority**, which means the owner or a guardian given full authority. Each export is logged in the append-only `family_exports` table with its SHA-256 and audited, and can be printed or downloaded as a file.

## Who can do what

| | Owner, or full authority | Co-educator (teaches the learner) | Guardian (view) |
|---|---|---|---|
| See the plan, attendance, work, progress | yes | yes | yes |
| Add or complete courses and goals, record attendance and work, correct | yes | yes | — |
| Export a progress report, transcript or portfolio | yes | — | — |

The same rules are enforced in row-level security: read needs authority over the learner, write needs full or educational authority, and an export insert needs full authority. Everything is isolated by family as in HSP-01. A district session sees none of it, and another family gets 404.

## Decisions

- **The records are family-owned.** HSP-00 left open whether HSP-02 would share the district learning core (assignments, gradebook) through `tenant_id` migrations. This slice keeps homeschool records in their own tables and doesn't touch any district table. Sharing parts of the learning core with families, such as Christie or the content library, stays a separate, reviewed step.
- **No state rules are built in.** Totals are just counts, not compliance checks. Jurisdiction templates and filing reminders come in HSP-06.

## Not yet

- File uploads as evidence: links and notes only for now. Media goes through the existing scanning and consent rules when added.
- Learner sign-ins to see their own work.
- Moving records to a school (HSP-06).
