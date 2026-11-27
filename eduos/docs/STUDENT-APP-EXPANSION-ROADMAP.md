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

- [ ] Define a student-scoped schedule read model that combines class periods, approved room/location details, and school-approved activity sessions.
- [ ] Display today's schedule and a week view, with clear timezone and schedule-update timestamps.
- [ ] Show teacher/school-published changes and cancellations without exposing staff-only notes or other students' schedules.
- [ ] Add accessible reminders only after district notification preferences and quiet-hour rules are applied.
- [ ] Test schedule changes, no-school days, daylight-saving transitions, stale/offline state, and student transfer/withdrawal.

### Phase C — Progress and feedback

- [ ] Create a learner-facing progress overview combining course grades, standards mastery, returned work, teacher feedback, and credentials already available through existing APIs.
- [ ] Clearly distinguish official/final grades, current calculated grades, mastery evidence, and practice estimates.
- [ ] Show missing/ungraded work without treating ungraded work as zero.
- [ ] Support accessible progress explanations and links back to the source course/assessment.
- [ ] Verify accommodations, retakes, corrected grades, and term rollover.

### Phase D — School day services

- [ ] Consolidate the learner's own library loans, bus rider status, approved clubs/sports participation, and school announcements in a student-friendly "Today" view.
- [ ] Add a student-facing attendance summary only after a dedicated self-only endpoint is verified; do not expose class rosters, other learners, discipline records, or private staff notes.
- [ ] Add meal/menu information only when the school menu and student dietary privacy boundaries are supported by a suitable API.
- [ ] Keep transport status event-based (boarding / stop check-in), not GPS or continuous location tracking.

### Phase E — Student support and accessibility

- [ ] Add a student help center for approved school resources, assignment instructions, and how to ask an adult for help.
- [ ] Add language, reading, contrast, text-size, reduced-motion, and screen-reader improvements throughout student workflows.
- [ ] Ensure Christie remains constrained to approved instructional content, hints rather than answer-giving, and the existing teacher visibility notice.
- [ ] Do not add unsupervised direct messaging, public student directories, targeted advertising, or external AI transmission of student personal data.

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
