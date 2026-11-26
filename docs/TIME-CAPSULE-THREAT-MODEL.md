# Student History & Time Capsule: threat model and privacy controls (TC-05)

This document covers the controls that make Student History and Time Capsules
safe to expose. It records the threats considered, where each control lives,
the tests that prove it, and the risks that remain. It is a release gate for
the feature (roadmap TC-05).

## Where access is decided

Every read and write of `student_history_*` and `student_time_capsule_*` rows
goes through PostgreSQL row-level security (forced; the runtime role has no
bypass). The policies call one relationship function,
`eduos_history_relation` (db/088, extended in db/118). It works out how the
session relates to the student from the session's own active membership,
never from anything the caller sends.

| Relationship | Who | Notes |
| --- | --- | --- |
| guardian | active parent/guardian link | not while a custody restriction stands; not after the student holds their own rights |
| student | the learner's own pupil link | |
| teacher | on the teacher's roster at that school | ends when the roster or the membership ends |
| school_lead | principal / vice principal of that school | |
| district | superintendent | |

Two read-only paths sit beside it. Neither confers a relationship, so neither
can write records or create capsules:

* **sharing grant** (`eduos_history_granted`): published, non-private items of
  the granted kinds, while the grant is unexpired, unrevoked, the student still
  holds their rights, and the grantee isn't custody-restricted.
* **emergency access** (`eduos_history_emergency`): official records only, for
  a counselor, nurse or school resource officer at the student's school, for at
  most four hours, with a stated reason; the superintendent reviews every use.

A guardian also keeps seeing items they wrote themselves after the student
takes over their rights (`eduos_history_own_after_transition`).

## Threats and controls

| Threat | Control | Proof |
| --- | --- | --- |
| IDOR / BOLA: reading another student's history by changing an ID | RLS on every row; the route also requires a relationship (or grant/emergency) before reading and answers 404 otherwise | `student-history-privacy`, `history-privacy` (cross-student reads return 404) |
| Cross-tenant access | tenant policy on every table (`district_id = app.district_id`); relationship requires the student in the session's district | `history-privacy` (another district: 404, empty logs) |
| Privilege escalation: a pupil, parent or teacher writing an official record or publishing | `eduos_history_entry_writable` by relationship and classification; teachers can't publish | `student-history-privacy` |
| Grants used to write | grants aren't a relationship: writable/manageable functions see no relationship | `history-privacy` (grantee write refused) |
| Revocation not taking effect | grants and restrictions are checked on every read; nothing is cached or pre-issued | `history-privacy` (revoke and expiry take effect on the next read) |
| Custody order ignored, or the restricted guardian named a capsule recipient | `eduos_custody_blocked` in the relationship and in `eduos_history_user_is` (recipients) | `history-privacy` |
| Guardian access continuing after the student holds their own rights | relationship drops guardians once a rights transition is in effect; the student grants back what they choose | `history-privacy` |
| Staff offboarding | relationships require an active membership (and the roster for teachers) at read time | covered by the relationship function; no stored access to revoke |
| Break-glass abuse | reason (20+ characters), four-hour limit (database check), official records only, logged, visible to the student and family, reviewed by the superintendent | `history-privacy` |
| Silent access | every history read is written to `history_access_log`; the student, guardians (before the transition) and the records office can see who looked | `history-privacy` |
| Public or guessable links | there are no public links to history items or capsules; every route needs a session | route contract tests |
| Signed URL leakage | photos are shown only through `/api/history/photos/:id`, which checks that the viewer can see the item and redirects to a 60-second presigned link (`no-store`, `no-referrer`); storage keys and credentials never reach a browser; a changed link fails its signature | `history-media` |
| Malicious or tracking files | every photo is scanned by ClamAV (fails closed), decoded as its declared type, re-encoded from its pixels (EXIF/GPS and everything else dropped) and scanned again; only the processed copy is stored | `history-media`, `history-image` |
| Storage exhaustion | the district's limits (size, per item, per student) are checked in the database before anything is stored | `history-media` |
| Cache poisoning / shared caches | history routes send `Cache-Control: no-store` | route code |
| Bulk export abuse | export is one student per request, only by the student, guardians, a guardian the student shares with, school leaders or the superintendent (not teachers, not emergency access); 5 per person per student per hour and 20 per person per day (db/125, checked in the database) plus a route limit | `history-export` |
| Export leaking more than the viewer sees | the export runs the same visibility rules as the portfolio, published items only; the copy equals the view | `history-export` |
| Export links or stored copies | the file is made on request and sent as a download (`Content-Disposition: attachment`, `Cache-Control: no-store`); nothing is stored and there is no link | `history-export` |
| Script in a downloaded page | every field is HTML-escaped and the page carries `Content-Security-Policy: default-src 'none'` | `history-export` (unit and integration) |
| Silent export | every download is written to `history_access_log` (`export_history`) and the audit log; it shows under "Who looked" | `history-export` |

## Residual risks and operational controls

* **Rights transitions and custody orders are recorded by people.** EduOS has
  no birth dates or court feeds; the records office must record them. Each
  carries who recorded it and why; reversing one needs a note.
* **Approvals after the transition.** Teacher items awaiting a family decision
  (TC-03) still go to guardians' review queue; after the transition the
  student should decide. Until that's changed, the records office should
  handle those items for students who hold their own rights.
* **Media files.** Student-history photos (MEDIA-01), guardian-contributed
  family photos (MEDIA-02), Time Capsule photos (MEDIA-03), and guardian
  plain-text `.txt` documents use the private S3-compatible storage described
  in `eduos/docs/MEDIA-STORAGE.md`. Photos are ClamAV-scanned, decoded,
  re-encoded and stripped of metadata; `.txt` documents are strict-UTF-8
  validated and ClamAV-scanned, then forced to download as attachments rather
  than rendered. Guardian document support is district-opt-in and shares the
  student storage quota. The 60-second photo link can be passed on within its
  minute; that window is the residual. TC-08's integrity verification and
  restore drill are documented for photos; do not assume those checks cover
  document objects until document-specific verification is implemented and
  tested. PDF/DOCX and video remain unsupported; video metadata alone must
  never be treated as proof that media is safe.
* **Exports.** Built (db/125): per student, by the people listed above,
  logged and limited, no links. A downloaded file is outside EduOS's control
  once saved; the page says so, and records offices should treat a copy like
  a printout. Photos are listed by their descriptions; the image files
  aren't included.
* **Capsules.** Sealed Time Capsule contents are not part of an export; they
  stay sealed until released (TC-07).
* **Telemetry and analytics.** No history content is sent to analytics. Any
  future telemetry needs a privacy review first.
* **Encryption.** Data is encrypted in transit and at rest by the database
  deployment; history rows aren't separately encrypted at the application layer.
