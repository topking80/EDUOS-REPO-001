# Enrollment funnel (37.6.0 candidate)

Families apply for a seat for a new child. School leaders review, offer,
waitlist and enroll within the seats they set. When an offer is accepted and
enrolled, EduOS creates the student record and links the applying guardian.

## Stages

`inquiry -> applied -> documents -> review -> offered -> accepted -> enrolled`,
plus `waitlisted`, `declined` and `withdrawn`.

| Who | Can move |
| --- | --- |
| Family (parent account) | inquiry -> applied, documents -> review, offered -> accepted/declined, withdraw any open application |
| Principal (own school), superintendent (all schools) | applied -> documents/review, review -> documents/offered/waitlisted/declined, waitlisted -> offered/declined, offered -> accepted/declined/waitlisted, accepted -> enrolled (via **Enroll** only) |

The same rules are enforced twice: in `src/enrollment-model.js` and in the
`eduos_enrollment_guard` trigger (`eduos_enrollment_transition_ok`). A unit test
checks that the two lists match.

## Seats and the waitlist

A principal sets new-student seats per school year and grade (superintendents
can set any school's). An offer is refused with `no_seats_left_use_waitlist`
when offers + accepts + enrollments already fill the seats. A waitlisted family
sees its position. No seat limit set means no limit.

## Who sees what

- A family sees only applications it created from its own parent account.
- A principal sees its own school's applications; a superintendent sees the
  district's. Teachers, pupils and other staff roles have no access.
- Row-level security enforces this in PostgreSQL (`scope_*` policies on all
  four tables), on top of the route checks.
- Families new to the district, with no parent account yet, are entered by the
  school office as an inquiry (`POST /api/enrollment/inquiries`). After
  enrollment, invite the guardian from Students > Guardian invitations.

## Documents

PDF, PNG or JPEG, at most 2 MB. The file's first bytes must match one of these
types (the declared header is ignored). Downloads are `attachment`, `nosniff`
and sandboxed. Documents can be verified or rejected but never edited, and the
runtime role cannot delete them.

## Retention and FERPA

- `RETENTION_ENROLLMENT_DOCUMENT_DAYS` (default 90): documents are deleted this
  many days after the decision (enrolled, declined or withdrawn).
- `RETENTION_ENROLLMENT_CLOSED_DAYS` (default 365): declined and withdrawn
  applications, with their history, are deleted after this many days.
- `npm run db:retention` runs `eduos_retention_feature_enrollment` for each
  district. (37.6.0 adds a generic hook: every
  `eduos_retention_feature_<name>(jsonb)` function is called with the
  `RETENTION_*_DAYS` settings.)
- `eduos_purge_student` also deletes the learner's application, history and
  documents.
- The status history (`enrollment_events`) is append-only.

## Settings

- `ENROLLMENT_RATE_LIMIT_PER_MIN` (default 30) per user for enrollment writes.

## API

| Method | Path | Who |
| --- | --- | --- |
| GET | `/api/enrollment/options` | parent |
| GET | `/api/enrollment/mine` | parent |
| POST | `/api/enrollment/applications` | parent |
| GET | `/api/enrollment/applications/:id` | the applying parent, school leaders |
| POST | `/api/enrollment/applications/:id/status` | the applying parent, school leaders |
| POST | `/api/enrollment/applications/:id/documents` | the applying parent, school leaders (raw body) |
| GET | `/api/enrollment/documents/:id` | the applying parent, school leaders |
| POST | `/api/enrollment/documents/:id/review` | school leaders |
| GET | `/api/enrollment/board` | school leaders |
| PUT | `/api/enrollment/capacity` | school leaders |
| POST | `/api/enrollment/inquiries` | school leaders |
| POST | `/api/enrollment/applications/:id/enroll` | school leaders |

## Screens

The mobile web app (`/app/`) has an **Enrollment** card on the family Children
tab and on the principal and superintendent overview, leading to the family
application view and the leaders' board (seats, columns per stage, application
detail with documents, history and next steps).

**Not included:** Flutter screens. They are a follow-up.
