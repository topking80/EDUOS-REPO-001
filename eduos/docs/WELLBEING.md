# Well-being check-ins and the crisis hook (37.6.0 candidate)

A learner can tell a school counselor how they are doing. A person reads
every check-in. Nothing is scored, predicted or ranked (p21 promises).

## Turning it on (opt-in, with notice)

1. A superintendent turns check-ins on and edits the notice to families
   (`/app/` > District > Well-being check-ins). They are **off** by default.
2. Each guardian reads the notice and opts each child in (Children > Well-being
   check-ins). An opt-in records the notice version that was shown. If the
   notice text changes, a new version is issued and families must opt in again.
3. A learner can check in only when the district switch is on AND their
   guardian's latest decision is "opted in" under the current notice. This is
   enforced in PostgreSQL (`eduos_wellbeing_allowed`, in the RLS insert
   policy) as well as by the API.

## Who sees what

| Role | Access |
| --- | --- |
| Pupil | sends check-ins; sees their last 5 (mood, and "a counselor saw it") |
| Parent | the notice and their own children's opt-in status |
| Counselor | their school's check-ins, actions log and crisis alerts |
| Superintendent | district switch, notice, retention. **No** check-in access |
| Principal, teacher, others | none |

Row-level security enforces this on all five tables. The actions log and the
consent history are append-only.

## Crisis language (the "crisis hook")

`src/wellbeing-model.js` has a fixed, published phrase list (for example
"kill myself", "want to die", "someone is hurting me"). It is a rule anyone
can read, not a model or a score. When a learner's words match, in a
check-in note OR in a Christie chat (question or answer box):

- The learner sees the **988 Suicide & Crisis Lifeline** (call or text 988),
  "call 911 if in immediate danger", and that a counselor has been told.
- The school's counselors get an immediate in-app notification. If the school
  has no counselor, its principal gets a generic notice with no content.
- An **URGENT** item opens in the existing counseling queue
  (`school_service_work`, domain `counseling`, kind `wellbeing_crisis`).
- In Christie, the session is flagged for an adult, and nothing is sent to any
  tutor provider for that turn.
- This happens even when the learner is not opted in. In that case the text is
  not stored; only an alert with the learner's id is created. Safety comes
  before data collection.

A check-in that asks to talk, or ticks "I don't feel safe", opens a **high**
priority counseling-queue item (`wellbeing_talk`).

Queue items carry fixed text only: no student name, id or words. That queue
is also visible to school and district leads. The counselor opens Well-being
to see who it is. Acknowledging an alert moves the item to in progress.
Closing a check-in completes it.

## Retention and FERPA

- Check-ins and their actions are deleted after the district's
  `retention_days` (default 365, 30-2555) by `npm run db:retention`
  (`eduos_retention_feature_wellbeing`). Unacknowledged crisis alerts are
  kept until a counselor acknowledges them.
- `eduos_purge_student` deletes the learner's check-ins, actions, alerts and
  consents.

## Settings

- `WELLBEING_RATE_LIMIT_PER_MIN` (default 20) for learner check-ins.

## Limits, stated plainly

- A phrase list misses things and sometimes fires on false alarms. It does not
  replace adults who know the student. The list is deliberately broad.
- In-app notifications reach counselors who have the app. Push delivery
  depends on the district's notification setup.
- Flutter screens are not included and remain a follow-up.
