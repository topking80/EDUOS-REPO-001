# EduOS 32.6.0: learning core, assessments and the first step of EDAL

What was asked: build the learning core from the Series B deck (pages 16-17,
24-25 and 29-30, plus the PSLN primary-source idea). That means:
- courses, units and lessons tagged with standards
- assignments with rubrics, submissions and teacher feedback
- a gradebook, a learner path, and an explainable per-standard mastery model
  that replaces the 32.4 practice estimate
- quizzes (multiple choice, short answer, numeric) with auto-scoring, teacher
  review, extra-time and read-aloud accommodations, and a retake policy
- Christie hints drawn from approved lesson content
- a small set of curated, public-domain primary sources
- the first step of the EDAL academic ledger: tamper-evident and append-only,
  with a verify endpoint, a CLI and a plan for anchoring
- a family "Grades & progress" view
- phone screens in the 32.4 style

Operator steps are in `docs/UPGRADING-32.6.0.md`.

Hard rules kept:
- **EDAL is not a blockchain.** It is a SHA-256 hash chain stored in
  PostgreSQL. That makes it tamper-evident, not tamper-proof: anyone who can
  rewrite the whole database could rebuild the chain. Checkpoints kept outside
  EduOS are what catch that case. Every EDAL screen, API answer and CLI help
  text says this. External anchoring is a plan only and is off (see UPGRADING §4).
- **Primary sources are real and public domain.** The API and a database CHECK
  only accept `https://loc.gov/...` or `https://archives.gov/...` links. Each
  item records its rights statement. The three demo items were checked against
  the live archive pages:
  - the 1903 first-flight photograph: <https://www.loc.gov/item/00652085/>
  - Orville Wright's telegram, as quoted on the LoC "Today in History,
    December 17" page: <https://www.loc.gov/item/today-in-history/december-17/>
  - the Declaration transcription at the National Archives:
    <https://www.archives.gov/founding-docs/declaration-transcript>
- **No student data leaves EduOS. There are no external AI calls by default.**
  - Christie is still the local, deterministic provider.
  - Read-aloud uses the browser's speech engine and only accepts an
    **on-device** voice (`localService`). If no such voice exists, it reads
    nothing rather than fall back to a cloud voice.
  - Email, SMS and push stay off.
- **No profiling of minors.** Mastery describes work that was done: weighted
  evidence with its sources listed. It makes no predictions, rankings, risk
  scores or comparisons between learners.
- Kept from earlier releases:
  - RLS (FORCE, tenant isolation and restrictive role policies), OIDC, CSRF on
    every write, and an audit row for every read and write of learning data.
  - FERPA export and deletion cover the new data.
  - Rate limits, and axe at 0 violations.

## 1. Courses, units, lessons, standards
- `learning_standards` holds 6 demo CCSS entries with short summaries:
  4.NF.A.1, 4.NF.A.2, 4.NF.B.3, RI.4.3, RI.4.6 and RI.4.7. Each links to
  thecorestandards.org. The text is summarised, not copied.
- Courses belong to a teacher and a school, have enrollments and grade
  weights, and are active or archived. Units are ordered, and lessons carry
  an objective, content, standards and primary sources with guiding
  questions.
- **Lesson approval:** a school leader approves the lesson text before
  Christie may use it.
  - A trigger lets only leaders set the approval.
  - If a teacher edits an approved lesson's text, the approval is cleared.
- API (all under `/api/learning`):
  - `GET/POST courses`, `GET courses/:id`
  - `POST courses/:id/enrollments`, `POST courses/:id/units`
  - `POST lessons`, `PATCH lessons/:id`, `POST lessons/:id/approve`,
    `GET lessons/:id`
  - `GET standards`, `GET/POST sources`, `POST sources/:id/approve`
  - `GET approvals`

## 2. Assignments, rubrics, gradebook
- Assignments are either `work` (with a rubric, or plain points) or `quiz`.
  Each has a category (Classwork / Quizzes), a due date and standards.
- **Rubric grading:** `POST assignments/:id/grade` takes one level per
  criterion, plus feedback.
  - Returned work, its rubric rows and the feedback become visible to the
    learner and the family.
  - Rubric rows tied to a standard become mastery evidence.
- **Gradebook:** `GET courses/:id/gradebook`.
  - The course grade is weighted by category.
  - A category with no graded work yet is left out and the weights are
    rescaled. Ungraded work never counts as zero.
  - Missing work (past due, not handed in) is flagged separately.
  - Letter grades use the usual A-F scale.
- **Final grades:** `POST courses/:id/final-grades`.
  - The grade is written to EDAL first, then to `course_final_grades`.
  - A correction needs a reason of 10 or more characters. It adds a new
    record that supersedes the old one, and nothing is overwritten.
- The legacy `/api/assignments/:id/submit` still works for `work`
  assignments and refuses quizzes.

## 3. Quizzes and accommodations
- **Item types:**
  - multiple choice
  - numeric: accepts fractions, mixed numbers and decimals, with a tolerance
  - short answer: auto-scored against accepted answers, otherwise left for
    the teacher
  - source: an open response about a primary source, always teacher-scored
- **Answer keys** are in `quiz_item_keys`, which learners can't read under
  RLS.
  - Learners never get keys while a quiz is open.
  - Keys are shown after the **last** allowed attempt is scored or returned.
  - A security-definer function scores the attempt on submit. Learners
    cannot write scores.
- **Attempts:**
  - The teacher sets the number of attempts (1-10).
  - The retake policy is highest, latest or average. The gradebook uses the
    effective score.
  - The time limit is stretched by the learner's **extra time**. The server
    enforces the deadline with a 60-second grace period, and late
    submissions are marked.
- **Teacher review:**
  - `GET review` lists the attempts that need review.
  - `POST attempts/:id/review` takes points and comments per item, then
    returns the attempt to the learner. Reviewed items become mastery
    evidence.
- **Accommodations:** `GET accommodations?courseId`,
  `PUT accommodations/:studentId`.
  - Extra time: 0-200%.
  - Read-aloud flag.
  - Teachers set these from the course screen.

## 4. Explainable mastery (replaces the 32.4 estimate)
`src/mastery-model.js` is pure and unit-tested:
- **Evidence:** quiz items per standard, rubric rows, and Christie practice.
- **Weights:** quiz and rubric evidence weigh 1. Christie practice weighs 0.5.
- **Recency:** the 8 newest pieces count, each worth 0.8 of the next newer
  one.
- **Levels:**
  - Mastered: ≥ 80%, **and** at least 3 pieces of evidence, **and** at least
    1 quiz or rubric piece. Practice alone can't confirm mastery.
  - Developing: ≥ 50%.
  - Emerging: below 50%.
  - Not started: no evidence yet.
- `GET mastery/:standardId` returns every piece of evidence used, with its
  score and its share of the result, a plain-language explanation, and the
  rules. The "Why?" / "How is this calculated?" screens show the same data.
- The first time a learner reaches Mastered on a standard, a **mastery
  milestone** is recorded on EDAL.
- **Christie's path:**
  - A skill linked to a standard shows the standard's mastery, labelled
    "standard mastery".
  - Other skills keep the old estimate, labelled "practice estimate".

## 5. Christie on lesson content
- A skill can link to a lesson and a standard.
- **Lesson text:** Christie's hint source includes the lesson text only if
  the lesson is published **and** approved.
- **Answer-leak guard:** the local provider drops any passage that contains
  the current answer.
- **Greeting:** names the standard being practised.
- **Hints:** still hint-first; Christie never gives the answer.

## 6. EDAL: tamper-evident academic records ledger (first step)
- **Tables:**
  - `edal_entries`: append-only. A trigger refuses UPDATE and DELETE, and the
    app role has no UPDATE, DELETE or TRUNCATE grant.
  - `edal_payloads`: canonical JSON. FERPA deletion erases the payload.
  - `edal_heads`: a per-district head, behind a lock.
  - `edal_checkpoints`.
- **Hashes:**
  - `entry_hash = sha256("EDAL1|district|seq|kind|school|subject|payload_hash|prev_hash|recorded_at")`
  - `payload_hash = sha256(canonical JSON)`
  - Erasing a payload keeps the hash, so the chain still verifies after a
    FERPA deletion (covered by an integration test).
- **Kinds:** `final_grade`, `credential`, `credential_revoked`,
  `mastery_milestone`.
- **Endpoints:**
  - `GET /api/edal/verify` (superintendent, principal, IT admin): walks the
    chain, checks the head and every checkpoint, and lists any problems.
  - `GET/POST /api/edal/checkpoints`: saves the current head and returns a
    JSON copy to keep outside EduOS.
  - `GET /api/edal/records/:id` (also for the learner and family): a per-record
    proof showing that the entry hash matches, the payload matches, and the
    links to the previous and next entries hold.
  - `GET /api/edal/export` (district roles only): hashes and opaque ids only,
    for verifying offline.
- **CLI:** `npm run edal:verify` / `make edal-verify`, with options
  `--file export.json`, `--checkpoint cp.json`, `--district` and `--json`.
  - Exit codes: 0 ok, 1 problem, 2 error.
  - It runs as the owner role and only reads.
- **Credentials:** `POST /api/learning/credentials` (leaders) records course
  completion, standard mastery or an award on EDAL. Revoking a credential
  appends a revocation entry.

## 7. Phone screens (`/app/`)
- **Student:**
  - The tab bar is Home, **Courses**, Christie, My path, News.
  - Courses: course cards with grade and standards mastered.
  - Course: standards with level chips and "How is this calculated?", units,
    lessons, and assignments with status.
  - Lesson: goal, standards, text, primary-source cards (excerpt, rights,
    guiding questions, "See it at the Library of Congress / National
    Archives"), and "Practice with Christie".
  - Quiz: a "Before you start" screen (questions, time including extra time,
    attempts and policy). The taking screen has a `role=timer` countdown with
    5- and 1-minute announcements, radio fieldsets, answers that save as you
    go, **🔊 Read aloud** (on-device voice only), and submit with an in-app
    dialog.
  - Results: score and per-item results. Keys appear only after the last
    attempt. Retake button.
- **Teacher:**
  - The tab bar is Classes, **Courses**, Grading, Christie, Messages. Roster
    moved under Courses → **My roster**.
  - Gradebook: a scrollable, keyboard-focusable table with missing work in
    red, plus post or correct final grade.
  - Course: accommodations (extra time and read-aloud per learner).
  - Grading: queues for **Quizzes to review**, **Rubric grading** and
    hand-ins. The review screen takes points and comments, and the rubric
    screen has one radio group per criterion plus feedback.
- **Family:**
  - Each child card has **Grades & progress**: courses, grade with category
    breakdown, standards with "Why?", recently graded work with teacher
    feedback, final grades and credentials, and accommodations on file.
  - **Check record** shows the EDAL proof.
  - Families see only their own linked children (RLS, plus a 403 for any
    other id).
- **Principal / superintendent:**
  - The overview has a **Learning** card: items waiting for approval and the
    ledger status.
  - **Approvals:** lessons for Christie and draft sources.
  - **Records ledger:** verify status, counts by kind, checkpoints (Matches /
    Broken), and Save checkpoint with a JSON copy.
  - Leaders can post final grades and issue credentials from the gradebook.
- The service worker cache is now `eduos-app-shell-32.6.0`.

## 8. Demo data (`make up`)
- **Courses** (Jordan Lee), with Ava, Noah, Liam and Sofia enrolled:
  - Grade 4 Math: Fractions (2 units, 3 lessons)
  - Grade 4 Reading: Primary Sources (2 lessons, 3 real sources)
  - Ava's archived Grade 3 Math course
- **Work:**
  - Quiz: Equivalent fractions (2 attempts, highest score, 15 min). Ava
    scored 4/5 with a retake left.
  - Quiz: Comparing fractions (1 attempt, 10 min), not yet taken.
  - Rubric poster: Ava 11/12, with Noah's missing.
  - A primary-source quiz waiting for review.
  - A rubric chart.
- **Accommodations:** Noah +50% and read-aloud; Ava +25% and read-aloud.
- **EDAL:** Ava's Grade 3 Math final grade (B, 88.5%), the credential
  "Completed Grade 3 Math", mastery milestones, and a seed checkpoint.
- Lesson "Add fractions with like denominators" is left unapproved so the
  approvals queue has an item.

## Results
- Unit: **337/337** (`npm test`). 13 are new in `test/learning-32600.test.js`:
  - the mastery model and its explanation
  - gradebook weighting and the rule that ungraded work isn't zero
  - quiz scoring, including fractions and tolerance
  - EDAL hashing, chain and checkpoint verification
  - migration 014 RLS and append-only grants
  - phone screens present, no `prompt`/`confirm`/camera/geolocation, and
    on-device voice only
- PostgreSQL integration: **75/75**. 12 are new in
  `test/integration/learning-edal.test.js`:
  - source domains
  - course scope across teachers and schools
  - the lesson approval guard
  - key secrecy
  - attempts, deadlines and review
  - retakes and the highest-score policy
  - rubric feedback reaching the family
  - mastery milestones
  - Christie lesson content
  - final grades, corrections and credentials
  - EDAL verify, checkpoints, proof and permissions
  - tamper detection, the CLI and the offline export
  - FERPA erasure with the chain still verifying
- HTTP smoke: **39/39**. One step is new: courses, key secrecy, family
  progress and its 403, fake-archive refusal, EDAL verify, proof and
  permissions, and the CLI in the ops container.
- Browser:
  - desktop **34/34**
  - 32.4 phone pass **12/12** (the teacher roster step now goes through
    Courses)
  - SafetyOS **20/20**
  - new learning phone pass **18/18** (`dev/learning-smoke.mjs`,
    `make smoke-learning`)
- axe-core WCAG 2.1 A/AA: **0 violations** on 101 scans, 22 of them on new
  learning screens.
- Screenshots: `/workspace/eduos-screens/32.6/` (21 phone screens).

## Still a demo / not included
- **EDAL is a hash chain in PostgreSQL, not a blockchain, and nothing is
  anchored externally.** RFC 3161 / OpenTimestamps anchoring is a plan only
  (UPGRADING §4). Checkpoints have to be copied out by a person.
- **Credentials can't be verified by outside parties.** They are not W3C
  Verifiable Credentials or Open Badges, and there is no public verify page.
- **Standards:** 6 demo entries with summaries, and no standards import (CASE
  / OpenSALT).
- **Primary sources:** 3 curated items. No archive search or API import, and
  images aren't embedded: the app links to the archive, because the CSP only
  allows same-origin images.
- **Authoring:** teachers create courses, units, lessons and quizzes through
  the API. The phone app only has screens for using them, not authoring
  screens; desktop authoring screens come later.
- **Read-aloud** depends on the device having an on-device voice. Many
  desktop Linux browsers have none, and the app says so.
- **Short-answer auto-scoring** only credits the teacher's accepted answers,
  normalised the same way as Christie's checker. Anything else goes to the
  teacher, and wrong-looking answers are never marked wrong automatically.
- Learning records are not purged by the retention job. Academic records are
  kept until a FERPA deletion or a district policy says otherwise.
