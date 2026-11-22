# Time Capsules

A parent (or the student, a teacher, or a school lead) gathers items from a
student's history into a capsule, names who should receive it, and seals it.
It opens on a date, or when the school confirms a milestone, for recipients
who accepted.

## Lifecycle

| Status | Meaning |
|---|---|
| `draft` | The owner adds history items and recipients and edits the title and message |
| `sealed` | Locked; a milestone capsule waits here for the school |
| `scheduled` | Locked, with a release date |
| `released` | Recipients who accepted can open it |
| `cancelled` | Cancelled by the owner before release |

- **Consent first.** Nothing opens for anyone who hasn't accepted. On the
  release date, if nobody has accepted, the release is blocked (logged once a
  day) and retried by later runs. The date alone never releases a capsule.
- **Milestones** (finishing grade 5, finishing grade 8, graduation, turning
  18) are confirmed by a principal, vice principal or the district office of
  the student's school. They see only the student, the milestone, who made it
  and how many recipients accepted, never the title or contents.
- **Contents are frozen** when added: each item is the history entry's
  revision at that moment, so later edits don't change a sealed capsule. An
  entry later withdrawn (restricted, pending deletion, deleted) is withheld
  when the capsule is opened.
- **Recipients** must be related to the student (the student, guardians,
  teachers, school staff). They see who a capsule is from and when it opens,
  but not what's inside until it's released to them. They can withdraw
  consent at any time, which closes it to them again.
- **Owners** see their capsule, its recipients' answers and its event log.
  Nobody else can see a capsule unless it has been released to them.

## Enforcement

`db/091_time_capsule_lifecycle.sql` with the relationship rules in `db/088`.
Status changes go only through owner-run functions (`eduos_capsule_seal`,
`eduos_capsule_cancel`, `eduos_capsule_release_milestone`,
`eduos_capsule_release_due`); sealed capsules can't be edited or given new
recipients.

## Release sweep

The API releases due capsules every `CAPSULE_RELEASE_INTERVAL_SECONDS`
(default 300; 0 turns it off). Or run `node src/capsule-release-cli.js` from
cron with the runtime role's `DATABASE_URL`. Both are safe to run at once.

## API

- `GET/POST /api/history/capsules`, `GET/PATCH /api/history/capsules/:id`
- `GET /api/history/capsules/:id/candidates`, `POST /api/history/capsules/:id/items` `{ entryId }`
- `GET /api/history/capsule-recipient-options?studentId=`, `POST /api/history/capsules/:id/recipients` `{ userId, type }`
- `POST /api/history/capsules/:id/seal | cancel | release`
- `GET /api/history/capsule-invitations`, `POST /api/history/capsule-invitations/:capsuleId` `{ decision: approved | denied | withdrawn }`
- `GET /api/history/capsule-milestones` (school leads)

## Not in this step

Photos and video (waiting for private storage and scanning), notifications
when a capsule opens, legal holds, export, and creating capsules from the
student or teacher screens (the API allows it; the screens offer it to
parents).
