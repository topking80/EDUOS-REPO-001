# Clubs, Sports & Classrooms: audit and plan (Nov 25, 2026)

Base: origin/main @ 783935c (includes #174 Teacher Dashboard).

## What already exists (do not duplicate)
**Clubs & sports (db/051–060, 105, 115, 116; src/clubs-sports-routes.js, sports-eligibility*.js, coach-routes.js, sports-sharing/connector routes)**
- `school_activities` (kind club|sport, grade range, meeting details, draft/published/archived), `activity_staff` (advisor/coach, cross-school coaches in 105), `activity_memberships` (pupil joins).
- Sports rosters (`activity_roster_entries`, jersey/position), results with approval, `school_events` per activity, ticketing (sandbox commerce), streams, media with guardian media consent.
- Eligibility pass/fail by district rule from real grades + attendance (coach/AD only), athletic directors, guardian e‑sign permission slips bound to text hash.
- MaxPreps/Hudl connectors and athlete sharing consents.
- Web: Clubs & Sports view for every role, coach "My teams" view, eligibility + slips panels. Flutter: coach/teams screens exist.

**Classrooms (db/006, 009, 014, 104, 108–112, 119)**
- `courses` + `course_enrollments` (sections/rosters), `teacher_student_rosters`, `class_day_plans`, `classroom_rooms`/devices/pairing/commands, room check-in codes, remote lessons, safety room status.
- Teacher Dashboard: classroom operations (rooms, devices, today's timetable slots), courses with work queue.

## Gaps found
1. No attendance for club meetings, practices or games (the biggest operational gap for advisors/coaches).
2. No athletic physical clearance status (coaches can't see who is cleared to play).
3. Club join is immediate with no guardian consent step (permission slips exist only for rostered sport learners).
4. Teacher Dashboard had no advisor/coach block.
5. Classrooms: no seating chart; no bell/period schedule table separate from timetable slots.

## Built (branch feat/clubs-sports-classrooms)
- Migration **152_activity_attendance_physicals.sql**: `activity_event_attendance`, `student_physical_clearances` (dates only, append-only), forced RLS + restrictive role policies, grants only in runtime_grants.template.sql.
- API: GET/PUT `/api/events/:id/attendance`; GET `/api/activities/:id/physicals`; POST/GET `/api/students/:id/physical-clearance`. EDAL audit on every write and on physical status views (counts only).
- Teacher Dashboard `activities` block (my clubs/teams, next event, attendance due) + web card; web Attendance and Physicals panels in Clubs & Sports and My teams.
- Tests: unit test/activity-operations.test.js, integration test/integration/activity-operations.test.js.

## Next (not built; budget)
- Guardian consent for club sign‑up (pending membership until a guardian approves) — needs Mathew's decision.
- Classroom seating charts (per course section, teacher‑only) and a school bell schedule.
- Flutter screens for attendance/physicals and the dashboard activities block.
