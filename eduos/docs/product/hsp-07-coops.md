# HSP-07 (part 1) — Homeschool co-ops

Status: built (migration `db/166_hsp07_coops.sql`, routes `src/homeschool-coop-routes.js`).
Part 2 (library and reading lists, and family communication integrations) comes next. Private schools
don't join co-ops in this slice.

## What a co-op is

A group of homeschool families that meet for sessions and share announcements and resources. It's reached
from a family session (**Co-ops** on the family page) and belongs to no single family.

## Safety rules

- **Invite-only.** An organizer makes a one-time code for one family (shown once, 14 days, only its hash
  stored). That family's **owner** enters it. There's no directory or search of co-ops.
- **Adults only.** Only a member family's owners and co-educators see the co-op. Guardian viewers and
  learner accounts never reach it. Only owners act for their family; co-educators read.
- **No messaging with children, and no direct messages.** Announcements and resources are posts to the whole
  co-op. A member family's posts wait for an organizer or moderator to approve them; organizers' and
  moderators' posts publish directly, and no one approves their own family's post. Any member family can
  flag a published post; moderators see flags and remove posts with a reason. Links must be `https://`.
- **Minimal learner data.** A family's owner signs up only their own learners. Other families see how many
  signed up. Organizers, moderators and the session's leading family see **first names only** (that's all the
  co-op stores), with the family name, for headcount and supervision.
- **Families keep their records.** The co-op never reads or writes a family's learners, courses, work or
  attendance. A session leader marks who was there; the family then chooses **Add to log**, which writes a
  `co_op` entry to its own attendance log, once. A row-level policy stops a family from claiming another
  family's co-op attendance.

## Roles

| | Organizer | Moderator | Member family |
|---|---|---|---|
| Invite families, change roles, remove a family (with a reason), close the co-op | yes | — | — |
| Schedule and cancel sessions | yes | yes | — |
| Approve, reject and remove posts; see flags | yes | yes | — |
| Lead a session (see its roster, mark attendance) | when chosen as its leading family | when chosen | when chosen |
| Sign up own learners, post (moderated), flag | yes | yes | yes |

A co-op always keeps an active organizer: the last one can't step down or leave (checked in the API and by
a trigger). A family that leaves has its sign-ups to future sessions withdrawn.

## Data and audit

Tables: `coops`, `coop_members`, `coop_invitations`, `coop_sessions`, `coop_signups`,
`coop_session_attendance`, `coop_posts`, `coop_post_flags`, `coop_audit_events` (append-only). All have
forced RLS keyed on the family in context's co-op role (`eduos_coop_role()`); districts, private schools
and non-member families see nothing. Co-ops are created and joined only through `eduos_coop_create()` and
`eduos_coop_join()`. Every action is written to `coop_audit_events`, which organizers and moderators can read.
