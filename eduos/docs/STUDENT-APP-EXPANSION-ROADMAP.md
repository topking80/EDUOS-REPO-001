# Student App Expansion Roadmap

**Branch:** `feature/student-app-expansion`  
**Target:** Native EduOS Flutter app for the `pupil` role  
**Rule:** Build on existing learner APIs and screens. Do not create duplicate grade, attendance, library, or history systems.

## Product outcome

Make the Student App the learner's daily home for school, learning, activities, and their own records. It should answer four questions quickly:

1. What do I need to do today?
2. How am I progressing, and what feedback has my teacher given me?
3. What is happening at school and in my activities?
4. Where can I get help, practice, and access my own learning history?

The student experience must remain age-appropriate, accessible, privacy-preserving, and usable on phones, tablets, and supported desktop clients. K–2 / young learners should receive larger, simpler controls and reading-friendly presentation.

## Existing capabilities to preserve

- Home: next practice, enrolled courses, own bus route/rider status, school news.
- Courses: lessons, approved learning resources, assignments, quizzes, accommodations, results, and feedback.
- Christie: school-approved practice with hints rather than answers.
- My path: standards-linked mastery and clearly labelled practice estimates.
- My library: the learner's own loans and renewals.
- News: school and class announcements. Student-to-student messaging is not enabled; family/staff communication boundaries remain in force.
- Clubs & Sports: activity discovery and learner participation.
- My history and Time Capsules: audience-filtered learner history and governed future-release memories.

## Delivery status

### Phase A — Student daily learning hub

- [x] Add a native **My work** destination to the pupil navigation.
- [x] Aggregate published assignments across the learner's currently enrolled courses.
- [x] Sort dated work by due date and group it into to-do, turned-in/awaiting-review, and graded work.
- [x] Show missing status and earned/possible points when the learning API supplies them.
- [x] Open the related native course screen from each item.
- [x] Keep work and course data server-authorized; use the existing learner-specific course endpoints and do not cache student records offline.
- [x] Run Flutter analyzer and the complete mobile test suite; verify the new integration test on the feature branch (Flutter 3.24.5: analyzer clean, 141 tests pass; every role tab opens a native screen; every server path the app calls exists, checked by `test/flutter-api-links.test.js`).

### Phase B — Student day planner

- [x] Define a student-scoped schedule read model that combines class periods, approved room/location details, and school-approved activity sessions (migration 172, `eduos_learner_schedule`; see `docs/STUDENT-DAY-PLANNER.md`).
- [x] Display today's schedule and a week view, with clear timezone and schedule-update timestamps (web Schedule tab and Flutter Schedule screen).
- [x] Show teacher/school-published changes and cancellations without exposing staff-only notes or other students' schedules.
- [ ] Add accessible reminders only after district notification preferences and quiet-hour rules are applied.
- [x] Test schedule changes, no-school days, daylight-saving transitions, stale/offline state, and student transfer/withdrawal (`test/integration/day-planner.test.js`, Flutter `learner_screens_test.dart`).

### Phase C — Progress and feedback

- [x] Create a learner-facing progress overview combining course grades, standards mastery, returned work, teacher feedback, and credentials already available through existing APIs (web Grades tab, Flutter Grades screen; `GET /api/learning/progress` now lists every piece of published work with its status and feedback).
- [x] Clearly distinguish official/final grades, current calculated grades, mastery evidence, and practice estimates (a "How to read this" key; Christie practice estimates listed apart and never part of a grade).
- [x] Show missing/ungraded work without treating ungraded work as zero (missing and waiting work is listed with "not counted yet"; the course grade is unchanged by it, tested).
- [x] Support accessible progress explanations and links back to the source course/assessment (Why? opens the mastery evidence; each item opens its quiz or course).
- [x] Verify accommodations, retakes, corrected grades, and term rollover (attempts used, attempts allowed and which attempt counts; a correction shows the grade it replaced; an archived course's final grade stays as a past course; tested in `test/integration/learning-edal.test.js`).

### Phase D — School day services

- [x] Consolidate the learner's own library loans, bus rider status, approved clubs/sports participation, and school announcements in a student-friendly "Today" view ("Today at school" leads the student's Home on web and Flutter: today's classes and changes, the school-day notice, club and team events, books due within three days or overdue, and the clubs and teams they belong to; the bus and school news cards stay below).
- [ ] Add a student-facing attendance summary only after a dedicated self-only endpoint is verified; do not expose class rosters, other learners, discipline records, or private staff notes. *(Waiting for that endpoint.)*
- [ ] Add meal/menu information only when the school menu and student dietary privacy boundaries are supported by a suitable API. *(No such API yet.)*
- [x] Keep transport status event-based (boarding / stop check-in), not GPS or continuous location tracking (the Today view adds no transport data; the bus card is unchanged).

### Phase E — Student support and accessibility

- [x] Add a student help center for approved school resources, assignment instructions, and how to ask an adult for help (web and Flutter Help: tell an adult, 911 and 988, the student's teachers, a counselor check-in, where assignment instructions and feedback are, the school's chosen digital resources).
- [ ] Add language, reading, contrast, text-size, reduced-motion, and screen-reader improvements throughout student workflows. *Done: text size (standard, large, larger), high contrast and reduce motion, saved with the account (`PUT /api/me/preferences`, db/175) and applied on web and Flutter on top of the device's own settings; new student screens checked with axe. Still to do: translations.*
- [x] Ensure Christie remains constrained to approved instructional content, hints rather than answer-giving, and the existing teacher visibility notice (unchanged; the Help page repeats the notice).
- [x] Do not add unsupervised direct messaging, public student directories, targeted advertising, or external AI transmission of student personal data (Help adds none; it says plainly there's no student-to-student messaging).

## Acceptance criteria

- Every student API read is scoped to the authenticated learner by the server and reinforced by database row-level security.
- No student can change another learner's work, grade, attendance, library record, or history.
- Offline UI clearly distinguishes data that is unavailable from data that is saved; quiz answers are never queued as offline writes.
- The app does not cache student records on the device beyond explicitly approved transient behavior.
- Young-learner presentation, keyboard navigation, screen readers, text scaling, and narrow phone layouts are tested.
- Each phase has positive, denied-access, cross-tenant, stale-data, and failure-path tests before it is called complete.
- No feature is marked complete solely because a route or database table exists.

## Current implementation note

Phase A adds the My work screen and pupil navigation entry. It uses `GET /api/learning/courses` followed by the existing learner-scoped `GET /api/learning/courses/:id` response, including each assignment's learner-specific status, missing flag, and earned points. This is a first implementation slice, not a claim that the full roadmap or Flutter release gate is complete.

Phase B adds the day planner: staff publish class times, one-day changes and school calendar days; `GET /api/learning/schedule` returns the learner's own week through a database function that checks the caller and leaves staff notes out. Reminders are not built yet.

Phase C turns the existing progress endpoint into the learner's Grades view. It doesn't change how grades are calculated; it shows every piece of work and labels each kind of number.

Phase D adds no new endpoint: the Today card is built from the learner's own schedule, loans and memberships, each of which the server already limits to the signed-in learner.

Phase E adds the student Help page and per-person display settings. Display settings are stored with the account rather than in the browser, which keeps the rule that the web app stores nothing on the device.
