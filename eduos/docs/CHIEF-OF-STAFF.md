# Chief of Staff (COS-01)

A district role in the superintendent's office, for coordination only. The Chief of Staff sees the district at a glance in counts, runs a follow-up tracker, and sees what waits for a decision. They don't read student, staff-record or family records, and they don't decide anything: approvals, grades, transfers and settings stay with the superintendent and school leaders.

## Appointing one

Only the superintendent can create the account or membership (`POST /api/users` with `role: "chief_of_staff"`). The role has no school; a membership with a school is refused by the API and by the database (`memberships_chief_of_staff_no_school`). District IT and principals can't assign it.

## What the role can do

| Screen (web) | API | What it shows |
|---|---|---|
| **District** | `GET /api/cos/overview` | Per school: today's attendance totals (any total under 5 is withheld), active safety alerts, open work orders, substitute coverage still needed, and requests waiting for a decision (access, app, enrollment review, coverage) with the oldest one's age. Follow-up totals: open, overdue, due this week, done this week. No names and no ids of people. |
| **Follow-ups** | `GET/POST /api/cos/followups`, `PATCH /api/cos/followups/:id`, `GET /api/cos/staff` | A follow-up has a title, optional detail, an owner (a staff member, never a family or learner account), an optional school and due date, and a status: open, in progress, done or cancelled. |

The superintendent has the same two screens (the Follow-ups tab and `/api/cos/*`).

**Owners.** A staff member assigned a follow-up sees it under "Follow-ups for you" on their Account page. They can start it or mark it done with a note. They can't change what it says, who owns it or when it's due, and they can't cancel it. The API refuses this, and so does a database trigger (`cos_followup_guard`).

**No casework.** Text that names a district student in full, or gives a student number, is refused (`follow_up_names_a_student`). A first name on its own is allowed, because a colleague may share it.

## How it is kept to coordination (db/186)

- **Closed by default.** Every table with row security gets a restrictive `no_chief_of_staff` policy that admits nobody acting as the role. That covers every student table, plus staff, safety, health, counseling, finance and integration records. Several existing policies admit any staff role, so a new role would otherwise inherit them.
- **The reviewed exceptions**, listed in `COS_OPEN` in `test/integration/rls-coverage.test.js`:
  - its own follow-ups;
  - district and school names;
  - branding;
  - its own preferences and notifications;
  - staff accounts and memberships only (`users`, `memberships` and `district_users` now have row security; a permissive policy keeps every other role exactly as before);
  - writing, not reading, its own audit rows.
- **Counts through definers.** The overview and the staff list come from `eduos_cos_overview()` and `eduos_cos_staff()`. These run as the table owner, answer only the office, and return counts, or names of staff.
- **A guard for later tables.** A table created after db/186 must call `eduos_close_to_chief_of_staff('<table>')` in its migration, or be reviewed in `COS_OPEN`. The coverage test fails until one of the two happens. The SEC-02 per-student check ignores `no_chief_of_staff`, because shutting out one role doesn't narrow reads per student.
- **Audit.** Each follow-up created or changed is audited by field name and status, not content.

## Mobile

The Flutter app has no native Chief of Staff screens yet. Like meal service, the whole role opens the web app.

## Not in this version

- Notifications when a follow-up is assigned or falls overdue.
- Board-meeting agendas.
- Department roll-ups beyond the overview's counts.
- Native mobile screens.
