# Student day planner (student app Phase B)

A learner's own week: their classes, any change to them, school calendar days, and the club and
sport events they belong to. On the web it's the student's **Schedule** tab; in the Flutter app
it's **Schedule** in the student's tab bar. Migration 172, `src/day-planner-routes.js`.

## Who publishes what

| Who | What | Where |
|---|---|---|
| A course's teacher, or the school's principal or vice principal | Class times: days, start and end, optional period name and room, starting date | Course page → Class times |
| The same | A one-day change: cancelled, a different room, or a different time, with a note students see and a separate staff-only note | Course page → Class times |
| Principal or vice principal | School calendar days: no school, early release, late start, modified day; optionally a bell schedule for that day | School overview → School calendar |
| Coaches and advisors (existing) | Club and sport events | Clubs & Sports |

When a calendar day points at a bell schedule, a class whose period name matches a period in that
schedule shows that period's times for the day, marked *New time today*. A one-day change for the
class takes priority.

## What a learner sees, and what they don't

`GET /api/learning/schedule?from=YYYY-MM-DD&days=1..42` (pupils; parents add `studentId` for their
own child). Without `from` it starts today where the school is.

- Only the learner's active enrollments in active courses at their **current** school. A dropped
  course or a move to another school removes those classes; an ended pupil or parent link returns 403.
- Only club and sport events from the learner's own active memberships, published or cancelled,
  at their school. Drafts never show.
- Never staff-only notes, other learners, or rosters. Students and families can't read the
  planner tables directly (row-level security); they only get the database function
  `eduos_learner_schedule`, which checks the caller is the learner or a linked parent.
- Times are the school's local time, and the response names the time zone. A 9:00 class stays
  9:00 across a daylight-saving change; events are converted into school time.
- Each response carries `updatedAt` (the last change to anything shown) and `generatedAt`.
  Nothing is saved on the device: offline, the app says it can't load the schedule.

Every change by staff is audited (`course_meeting`, `course_meeting_change`, `school_calendar_day`).

## Not yet

- **Reminders.** The roadmap allows them only after district notification preferences and quiet
  hours are applied; not built.
- A parent's Schedule view on the web and in the app (the API already serves a parent's own child).
- Rotating (A/B) day schedules beyond what calendar days with bell schedules cover.
