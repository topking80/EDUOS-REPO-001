# HSP-06 (part 2) — Compliance profiles

Status: built (migration `db/168_hsp06b_compliance_profiles.sql`, routes `src/compliance-routes.js`,
platform tool `src/compliance-template.js`, shared checks `src/compliance-requirements.js`).
Transfers to and from districts remain open.

## What it is, and isn't

A **planning aid** for homeschool families and private schools. It tracks instructional days and hours,
dates, documents and assessments against requirements the family or school chose. It **doesn't**
decide whether anyone complies, give legal advice, delete records, or file or send anything to any agency.
Every response and screen carries that disclaimer.

## Templates (platform-published, reviewed)

- Only the platform publishes templates, as the migration owner:
  `DATABASE_URL=<owner URL> npm run compliance:template -- publish --file <template.json>` (and `retire --id`, `list`).
- The tool refuses a template without:
  - one or more `https` sources;
  - the responsible authority's name and `https` URL;
  - an effective date;
  - a last-reviewed date, no more than 18 months old;
  - a named reviewer;
  - valid requirements.
- A published template never changes (a trigger enforces it). Corrections are a new version. Retired templates
  stay readable to anyone who adopted them.
- The runtime role can only read templates.
- **No real templates ship in this PR.** `docs/compliance-templates/EXAMPLE-not-a-real-requirement.json`
  shows the format for a fictional jurisdiction (`US-ZZ`). Writing real ones needs the official sources
  and a reviewer.

Requirements format (`src/compliance-requirements.js`):

```json
{ "instruction": { "days": 180, "hours": 900, "note": "…" },
  "subjects": ["Reading"],
  "deadlines": [{ "key": "notice_of_intent", "label": "Notice of intent", "month": 8, "day": 15 }],
  "documents": [{ "key": "attendance_record", "label": "Attendance record", "perLearner": true }],
  "assessments": [{ "key": "annual_assessment", "label": "Annual assessment", "grades": ["3", "5", "8"] }],
  "retentionYears": 3 }
```

## Profiles (per family or school, per school year)

- Adopted by a family's **owner** or a school's **school admin**, either:
  - from a template (copied, so later template changes don't alter a year already planned), or
  - as their own targets, labelled "Set by your family/school. Not reviewed by EduOS."
- One active profile per tenant per school year (July–June). It can be ended.
- **Progress:**
  - Families: days and hours per learner, from the family's own attendance log.
  - Schools: days with attendance taken.
- **Dates:** each deadline falls on its date within the school year and is flagged "past due" or "coming up" (30 days)
  until it's marked done.
- **Checklist:** done, doesn't apply, or to do, with an optional date, a note on where the evidence is kept, and a free note.
  Per-learner documents are tracked per learner.
  - Families: the owner and co-educators update it.
  - Schools: school admins and registrars update it.
- **Retention:** a number of years the family or school intends to keep records. A reminder only; nothing is deleted
  automatically.
- **Who sees it:**
  - Families: owners and co-educators. Guardian viewers and learner accounts don't.
  - Schools: school admins, registrars and campus admins.
- Adoption, checklist changes, retention and ending are audited in the family's or school's audit trail.

Forced RLS keys profiles and checklist rows on the family or school in context and the reader's role.
Districts and other tenants see nothing.
