# TC-03 — Teacher contributions

Teachers add projects, achievements, coursework, events and reflections to a
student's history. The school reviews each item, then the family decides
whether it joins the child's history. Teacher-authored entries already support
secure photo attachments through the shared history-media pipeline (MEDIA-01);
this is not a guardian-only capability.

## Flow

| Step | Who | Result |
|---|---|---|
| Submit | A teacher who teaches the student (on a roster at that school) | `submitted`; only the teacher and reviewers can see it |
| Review | Principal, vice principal or superintendent (never the item's author) | approve → `approved`; ask for changes → back to the teacher as `draft`; reject → `restricted`. A reason is required to ask for changes or reject |
| Edit and resubmit | The teacher, while it's a `draft` | `submitted` again |
| Family decision | A parent or guardian linked to the student | accept → `published` (the student and family see it); decline → `restricted` (hidden from the family again) |

The first guardian to decide settles it. Once approved, the teacher can no
longer change the item. Every step is recorded in
`student_history_entry_decisions`, which can't be edited or deleted.

Reason codes: `needs_edits`, `inaccurate`, `privacy_concern`,
`other_students_identifiable`, `not_appropriate`, `duplicate`, `not_relevant`,
`family_preference`, `other`.

## Media

- Teacher-authored entries accept district-enabled JPEG, PNG and WebP photos through `POST /api/history/entries/:id/photos`.
- Uploads use the shared private-storage and ClamAV/image re-encoding pipeline, district per-entry and per-student quotas, idempotency keys, and short-lived authorized reads.
- Photos remain hidden until the entry is visible to the requesting audience. The teacher can see their own draft photos; the family sees them only after school approval and family acceptance.
- Integration coverage verifies teacher upload, malware and MIME rejection, quota enforcement, visibility before/after publication, and signed-link access.
- Plain-text documents and video are not yet supported on teacher-authored entries. PDF/DOCX remain out of scope until independently validated active-content sanitization exists.

## API

- `POST /api/students/:studentId/history/teacher-items` (teacher): `{ title, body, occurredAt, entryType }`
- `GET /api/teacher/history-items` (teacher): own items with their decisions
- `PATCH /api/teacher/history-items/:id` (teacher, drafts only): `{ title?, body? }`
- `POST /api/teacher/history-items/:id/submit` (teacher)
- `GET /api/history-review` (principal, vice principal, superintendent): items awaiting review
- `POST /api/history-review/:id`: `{ decision: approve | request_changes | reject, reasonCode?, note? }`
- `GET /api/family/children/:studentId/history-items/pending` (parent)
- `POST /api/family/children/:studentId/history-items/:id` (parent): `{ decision: accept | decline, reasonCode?, note? }`

## Enforcement

Who may do what is enforced in the database: the relationship rules from
`db/088_student_history_relationship_rls.sql` and the workflow functions in
`db/090_history_teacher_contributions.sql` (`eduos_history_submit`,
`eduos_history_review`, `eduos_history_family_decide`). The runtime role can't
change an item's status any other way.

## Not in this step

- Plain-text documents and video: not yet supported for teacher-authored entries. PDF/DOCX remain unsupported until active-content sanitization is independently validated; video requires safe transcoding.
- Screens in the web and mobile apps: this step adds the API; teacher-authored photos use the shared history-media endpoint and are exposed in supported portfolio views.
- Reassigning items when a teacher leaves, and district-configurable approver
  roles (roadmap items for a later step).
