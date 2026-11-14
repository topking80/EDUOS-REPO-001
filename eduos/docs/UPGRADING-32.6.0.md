# Upgrading to EduOS 32.6.0

## 1. Run migration 014
`db/014_learning_core_edal.sql` adds the learning core and the EDAL ledger.
Run it with the owner role:
```sh
DATABASE_URL=<owner url> npm run db:migrate
```
The app refuses to start until the migration is applied ("ready 14"). The
migrator reapplies `runtime_grants.template.sql`, which grants SELECT and
INSERT plus column-limited UPDATEs on the new tables. The append-only tables
get no UPDATE, DELETE or TRUNCATE grant, and the app role gets no direct
access to `edal_heads`.

What it adds:
- **Learning tables:**
  - `learning_standards`
  - `courses`, `course_enrollments`, `course_units`
  - `lessons`, `lesson_standards`
  - `primary_sources` (with a CHECK allowing only loc.gov / archives.gov),
    `lesson_sources`
  - `assignment_standards`
  - `quiz_items`, `quiz_item_keys` (learners can't read these)
  - `student_accommodations`
  - `quiz_attempts`, `quiz_responses`
  - `mastery_evidence` (append-only), `standard_mastery`
  - `course_final_grades` (append-only; corrections supersede)
  - `credentials`
- `assignments` gains columns: course, lesson, kind, points, category,
  rubric, attempts, retake policy and time limit. Existing assignments
  become `kind='work'` and behave as before.
- **EDAL tables:**
  - `edal_entries` (append-only; a trigger refuses UPDATE and DELETE)
  - `edal_payloads`
  - `edal_heads`
  - `edal_checkpoints`
- **RLS:** FORCE RLS on every new table, with tenant isolation and
  restrictive per-role policies:
  - Learners see only their own data.
  - Families see only linked children.
  - Teachers see their own courses and learners.
  - Leaders see their schools.
  - IT admins can verify the ledger but cannot read student records.
- **Functions:**
  - Security-definer functions for quiz submission and scoring and for the
    EDAL head, chain and neighbours.
  - `eduos_owner_session()`, so owner-only shortcuts in policies are never
    true inside definer functions.
  - An updated `eduos_purge_student`: FERPA deletion removes the new rows and
    erases EDAL payloads while keeping the hashes.
- **Existing Christie skills** gain an optional `standard_id` and
  `lesson_id`.

## 2. Load standards and sources
The demo seed loads 6 summarised CCSS entries and 3 sources. For a real
district:
- **Standards:** insert into `learning_standards` (owner role, or an import
  job). Keep the descriptions summarised, or license the full text.
- **Primary sources:** teachers add them with `POST /api/learning/sources`.
  Only `https://(www.)loc.gov/...` and `https://(www.)archives.gov/...` items
  are accepted, each with a rights statement. A school leader approves them
  before lessons can use them.

## 3. EDAL operations
- **Verify from the app:** Records ledger (superintendent, principal, IT
  admin), or `GET /api/edal/verify`.
- **Verify from the command line** (owner role, read-only):
  ```sh
  make edal-verify                                 # dev stack
  DATABASE_URL=<owner url> npm run edal:verify     # any install
  npm run edal:verify -- --checkpoint saved-checkpoint.json
  npm run edal:verify -- --file export.json        # offline, no database
  ```
  Exit codes: 0 ok, 1 problem found, 2 error.
- **Checkpoints:** after each grading period, a leader taps **Save
  checkpoint**. Then copy the JSON somewhere EduOS can't change: print it, or
  have a person email it to an auditor, or file it in the records-management
  system. If the database were rewritten, the copy would stop matching.
- **Offline export:** `GET /api/edal/export` (district roles only) holds
  hashes and opaque ids only, no names or grades.

## 4. What EDAL is, and the anchoring plan
EDAL 1 is a **tamper-evident hash chain inside PostgreSQL. It is not a
blockchain**:
- There is no distributed consensus, no tokens and no public ledger.
- It detects an edit, deletion or reordering of any entry. That covers a
  changed payload, a broken link, a gap in the sequence, and a head that
  doesn't match.
- It cannot stop someone with full database control from rebuilding the
  whole chain. External checkpoints exist to catch that.

Planned, off by default, and not implemented in 32.6.0:
1. `EDAL_ANCHOR=rfc3161`: send only the checkpoint hash to a district-chosen
   RFC 3161 timestamp authority and store the signed token in
   `edal_checkpoints.anchor_kind` / `anchor_ref`.
2. `EDAL_ANCHOR=opentimestamps`: the same, with OpenTimestamps calendars.
   This is public-blockchain-backed, but only the hash is sent.
3. Verifiable Credentials or Open Badges 3.0 for credentials, signed by a
   district key.

Each option sends a 32-byte hash and no student data. Each needs district
approval because it contacts an outside service.

## 5. Phone app changes for users
- **Students:** a new **Courses** tab.
- **Teachers:** the tabs are now Classes, Courses, Grading, Christie,
  Messages. **Roster** moved to Courses → My roster.
- **Families:** the child card has **Grades & progress**.
- **Leaders:** the overview has a **Learning** card with Approvals and the
  Records ledger.
- The service worker cache is renamed (`eduos-app-shell-32.6.0`), so
  installed apps pick up the new shell on the next open.

## 6. No new dependencies or environment variables
`npm ci` is unchanged. Read-aloud uses the browser's own on-device speech
engine: nothing is sent to a speech service, and the app won't use a
network voice.
