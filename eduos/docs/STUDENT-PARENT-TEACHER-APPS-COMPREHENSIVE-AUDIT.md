# Student, Parent, and Teacher Apps — Comprehensive Repository Audit

**Audit date:** 2026-11-27  
**Repository:** `topking80/EDUOS-REPO-001`  
**Audited base:** `main` (the repository snapshot referenced by commit `819451455d139478cc9e7177906e9596a6404f27`)  
**Scope:** Web role experiences, Flutter navigation/screens, APIs, database authorization, offline behavior, tests, and product-roadmap coverage.

## Executive assessment

EduOS has substantial working foundations across all three role apps. The Flutter app has native role navigation and a broad set of student, family, and teacher screens. The teacher experience is the most operationally dense; the student experience has a clear learning journey; and the parent home consolidates several high-value family tasks.

**The three apps should not yet be described as fully complete or release-certified.** The current repository still has material privacy/grade-release concerns, uneven web/mobile parity, and roadmap gaps. This is a source-level audit, not a production penetration test or a claim that CI was run during this review.

### Overall status

| App | Current strengths | Overall finding |
|---|---|---|
| Student | Home, My work, Schedule, courses/quizzes, library, Christie, mastery/path, news, activities, history and Time Capsules | Strong core; Grades/progress expansion is in open PR #228, not part of the audited `main` snapshot. Reminders and broader school-day services remain. |
| Parent / guardian | Multi-child home, attendance summaries, due/overdue work counts, bus status, library, arrival, pick-up, messages, alerts, Time Capsules and tickets/receipts | Useful core family hub; missing native schedule/progress views and family-mode sign-in for homeschool workflows. Cross-school continuity remains dependent on unproven federation/portable identity. |
| Teacher | Dashboard, classes/register, lesson planner, courses/gradebook, grading, Christie, staffing, school-day coordination, messages and history contributions | Broad daily-operations foundation; remaining gaps include full master/substitute scheduling, media capture/scanner workflow, guest speakers and federated teacher collaboration. |

## Findings requiring action

### P1 — Privacy and data correctness

#### F-01. Unreturned grades can flow into learner and family progress

**Evidence:** `src/learning-routes.js` supports `returnToStudent: false` and writes `returned_at` only when the teacher chooses to return the grade. However, `src/learning-service.js` → `courseGradeData()` selects graded submissions and treats any `graded_at` row as status `graded`; it does not require `returned_at IS NOT NULL`. The grade/progress paths reuse this helper.

**Impact:** A teacher's explicitly unreturned grade and feedback may be visible to the learner/family and included in the learner's calculated grade before the teacher has returned it.

**Required fix:** Make learner/family views return-aware at the query/service layer. Keep teacher/authorized-lead views able to inspect unreturned work. Define whether unreturned scores affect the learner's displayed current grade; default should be no until released. Add tests for both `returnToStudent=true` and `false` across learner, linked guardian, teacher, and school-lead roles.

#### F-02. Assignment submission row-level security needs a student-specific policy

**Evidence:** PR #228 explicitly records that `assignment_submissions` has district-level row security but no per-student database read policy comparable to sibling learner tables. The learning routes filter submissions by learner/course, but route filtering is not a substitute for database-enforced row-level authorization. The core learning migration's restrictive policy loop does not include `assignment_submissions`; the table is separately granted to the runtime role.

**Impact:** A future route/query mistake or direct runtime-role query could expose submissions across learners within the same district.

**Required fix:** Add forced RLS and restrictive policies for the learner's own submission, the linked guardian under current relationship/custody rules, the managing teacher/course roster, and authorized school/district leads. Include negative direct-SQL tests using the non-owner runtime role, cross-school and cross-district tests, revoked-link tests, and teacher-not-on-roster tests. Verify insert/update paths remain least-privilege.

### P2 — Product completeness and role parity

#### F-03. Student Grades is not on audited main

**Evidence:** Main's Flutter pupil tabs include Home, My work, Schedule, Courses, Library, Christie, My path, News, Clubs & Sports, My history and Time Capsules; no Grades tab is present. PR #228 adds the Grades view to web and Flutter and extends progress data, but remains a separate, unmerged change in the open-PR listing.

**Required action:** Review PR #228 only after F-01/F-02 are fixed or explicitly gated. Validate the new progress view against the current API contract and update the roadmap only after merge and CI evidence.

#### F-04. Parent mobile experience lacks schedule and a consolidated progress view

**Evidence:** Parent Flutter tabs are Children, Library books, Arrival, Pick-up, Messages, Alerts and Time Capsules. The Children screen shows each linked child's school, grade, attendance summary, work-due counts and bus status. The student schedule API supports a linked parent, but the documented planner says the parent's Schedule view is not yet built. The parent progress endpoint is available through the web learning experience, but there is no native parent Grades/Progress destination in the current tab list.

**Impact:** Families must switch between views or use the web app for important academic context; the family home does not yet deliver one consistent weekly view per child.

**Required action:** Add a child-scoped Schedule and Grades/Progress view with an explicit child switcher, school timezone, clear distinctions between official grades/current grades/mastery/practice, and relationship/custody rechecks on every request. Do not copy data into a separate family gradebook.

#### F-05. Homeschool family workspace is not fully native

**Evidence:** HSP-01 documents family tenants, owner/co-educator/guardian roles, learner-scoped authority, calendar/dashboard and forced RLS. It also explicitly states that signing into a family from the native app is not yet built; native sign-in still opens a school role. HSP-02 adds family learning operations, but the native-context gap remains in HSP-01.

**Required action:** Complete native account/context switching for family sessions and test family-to-school switching, revocation, cross-tenant denial and offline behavior. Keep family records isolated from district records.

#### F-06. Teacher workspace still has original-vision gaps

**Evidence:** Current native teacher tabs and dashboard cover core teaching/grading and school-day operations. The requirements traceability document still marks the unified teacher workspace partial; global teacher directory/resource exchange and federated moderation are unverified, guest-speaker workflow is not evidenced, and camera/document-scanner/media-capture workflow is incomplete. The clubs/sports audit also records classroom seating charts and some staff-facing Flutter operations as not built at that audit point.

**Required action:** Prioritize (1) master schedule and substitute coverage with collision checks and change fan-out, (2) consent-aware class photo/document capture and review, (3) teacher-controlled guest-speaker invitations with time-limited access and moderation, and (4) federated teacher collaboration only after identity, contact-relay and moderation controls are approved.

#### F-07. Student day-planner reminders and school-day expansion remain incomplete

**Evidence:** The Student Day Planner document marks reminders not built and explicitly conditions them on district notification preferences and quiet hours. Rotating A/B schedules are also not yet supported beyond calendar-day bell schedules. The Student App Expansion Roadmap has additional school-day service work beyond the existing My work and Schedule slices.

**Required action:** Implement reminders only through district-controlled notification preferences, quiet hours, deduplication and opt-out. Treat A/B schedules and additional school-day services as separate, tested roadmap items.

#### F-08. Offline capability is intentionally narrow and must be communicated clearly

**Evidence:** Flutter README documents a small offline write allowlist (safety roll call, bus check-ins and attendance), 24-hour/200-entry queue bounds and no caching of school records. Pick-up requires a live connection; quiz answers are not queued offline.

**Impact:** This is a sound privacy posture, but users must not mistake the apps for fully offline-capable. Screens need clear stale/unavailable states and safe retry behavior.

**Required action:** Preserve the narrow allowlist unless a feature receives its own threat model, idempotency/replay design, retention rule and offline integration tests. Add explicit UX copy for unavailable grades, schedules, pick-up and quiz submission.

## Positive controls and foundations observed

- Flutter navigation tests assert that each configured role tab opens its intended native screen rather than silently falling back to web.
- The parent Children screen uses the signed-in user's `/api/home`, then child-specific summary and transport endpoints; optional failures are handled without turning a transient summary failure into an unauthorized state.
- Student schedule documentation describes a database function that checks learner/linked-parent authority and withholds staff-only notes and other learners' schedules.
- Student-history migration 088 replaces broad district/school visibility with relationship-based access (active guardian, learner, rostered teacher, school lead or district role) and audience-aware visibility.
- HSP-01 documents forced RLS, family-session context isolation, per-learner authority, IDOR denial and immediate session invalidation after member removal.
- Teacher dashboard aggregates operational information and links to existing operational screens rather than creating parallel write systems.
- Offline queue constraints are documented and deliberately exclude sensitive school-record caching.

## Test and evidence limitations

This review inspected repository source, migrations, tests, and product documentation through GitHub. **No Flutter analyzer, Flutter test suite, Node test suite, browser smoke, PostgreSQL integration suite, migration-upgrade test, or CI workflow was executed as part of this audit.** Existing test files and roadmap statements are evidence of intended/previous validation, not proof that the current branch passes today.

Before release, run at minimum:
1. `cd eduos/mobile/flutter && flutter pub get --enforce-lockfile && flutter analyze --fatal-infos && flutter test`.
2. The full Node unit and integration suites against a real PostgreSQL instance using the non-owner runtime role.
3. Browser smoke/accessibility checks for all three roles, including keyboard and screen-reader paths.
4. Cross-role authorization tests for student, guardian, teacher, school lead and district administrator, including cross-tenant, cross-school, revoked-link, custody restriction and IDOR cases.
5. Offline/retry/replay tests for every queued write and explicit unavailable-state tests for non-queued workflows.
6. Upgrade-path tests from the supported prior migration baseline.

## Recommended remediation order

1. **Close F-01 and F-02 first.** These are release-blocking grade privacy/database authorization issues.
2. Review and validate student Grades PR #228 against those fixes; only then merge the student Grades capability.
3. Build parent native Grades/Progress and Schedule views on the existing authorized APIs; complete native family-session context switching.
4. Close teacher schedule/substitute, media-capture and guest-speaker workflows; defer federated collaboration until safeguarding is complete.
5. Complete student reminders and remaining school-day roadmap items with district-controlled notification policy.
6. Run the full cross-role, mobile, browser, database and offline release gates and publish a fresh evidence-based audit.

## Release decision

**Not yet release-certified as a complete three-app suite.** The current codebase is a strong foundation, but F-01 and F-02 must be fixed and the role-specific P2 gaps must either be completed or explicitly excluded from the release scope. No merge or deployment is implied by this audit document.
