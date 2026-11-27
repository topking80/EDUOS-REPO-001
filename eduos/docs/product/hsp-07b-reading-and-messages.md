# HSP-07 (part 2) — Reading lists and private school messages

Status: built (migration `db/167_hsp07b_reading_and_school_messages.sql`, routes
`src/homeschool-reading-routes.js` and `src/private-school-messages-routes.js`).

## Homeschool reading lists

Each learner has a reading list on their page: title, author, status (to read, reading, finished, set
aside), minutes logged, notes and an optional course. It's kept like the family's other learning records:

- Anyone with authority over the learner reads it.
- The owner, or an adult with educational authority, adds books, logs minutes and marks books finished.
- The page shows books finished this school year (from July 1), books in progress and hours logged.
- Changes are written to the family audit trail. Other families, schools and districts see nothing.

## Private school messages

Conversations about one learner, between that learner's guardians and the staff who work with them.

**Who can be in a conversation** (`eduos_ps_contacts()`; fixed by the learner, never free-form):

- A guardian of the learner can include the staff who teach them (an active class roster), the
  campus admin of their campus, the registrar and school admins.
- Those staff can include the learner's linked guardians.
- No one else, so no one can message a stranger. Private schools have no learner accounts, so a child
  is never in a conversation.
- A guardian's conversation includes only that guardian and the staff they chose. Staff choose which
  linked guardians to include.
- A teacher taken off the learner's roster can't start new conversations about them.

**Rules**

- Messages are never edited or deleted (a trigger enforces it).
- A school admin can hide a message with a reason. Others then see that it was hidden and why; the
  admin still sees the text.
- School admins can read every conversation for oversight. The app tells them when they're reading
  one they're not in, and they can't reply to it.
- Any participant, or a school admin, can close a conversation. A closed conversation takes no replies.
- Opening a conversation marks it read and shows unread counts in the list.
- Opening, closing and hiding are written to the school's audit trail. The message text isn't copied
  into the audit trail.
- No email or push notifications are sent in this slice.

All three tables have forced RLS: conversations, people and messages are visible only to participants
and school admins of that school. The runtime role can't delete them.
