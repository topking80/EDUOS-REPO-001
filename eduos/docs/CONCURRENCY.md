# Concurrency: the same request, many times at once (SEC-07)

A double tap, a client that retries, two staff on one record, or a script firing requests in parallel all send the same request several times together. Each must do its work once. The losers get a clear 4xx or the same answer, never a 500 and never a second copy.

## How EduOS holds the line

- **Row locks on the thing being used up.** `FOR UPDATE` on the ticket type (capacity), the ticket (check-in), the invitation (accept) and the payment (confirm). Waiters re-read the row after the first commits.
- **State re-checked where it changes.** An UPDATE that moves something on (`in_progress` → submitted, `approved` → consumed) carries the expected state in its own WHERE clause, so a waiter that re-reads the row matches nothing. Example: the device code is consumed with `DELETE … WHERE status='approved' RETURNING`.
- **Advisory locks where there is no row yet.** These cover a ticket order's idempotency key and, since SEC-07, a learner starting a quiz.
- **Unique indexes as the backstop.** Examples: one open attempt per quiz and learner, one order per idempotency key.

## Covered by tests

`test/integration/concurrency.test.js` sends each request 8 times at once through the real server and PostgreSQL:

| Race | Expected |
|---|---|
| Starting a quiz | one attempt; every caller gets it (201 once, 200 resumed) |
| Submitting an attempt | one 200, the rest 409 `attempt_not_open`; scored once; mastery evidence and the audit event recorded once |
| Starting the last allowed attempt, then past the limit | one new attempt; then every start is 409 `no_attempts_left`; the count never exceeds `max_attempts` |
| Buying from a capacity of 3 | exactly 3 sold, the rest 409 `ticket_capacity_exceeded` |
| One order, same idempotency key | one order, one payment, seats held once; the rest are replays |
| Confirming a payment | one 200, the rest 409; one settlement in the ledger, one ticket, one EDAL entry |
| Scanning a ticket at the gate | admitted once, the rest 409 |
| Accepting a guardian invitation | one link, the rest 409 |
| Approving and redeeming a device code | one approval; one session, the rest `invalid_grant` |

Other suites already cover:
- payment webhooks: concurrent workers, lease expiry and distinct notifications for one capture, in `commerce-providers.test.js`;
- AI budgets: 20 simultaneous requests, in `ai-external-privacy.test.js`;
- the first attendance mark of the day, in `morning-sequence.test.js` and `release-gate.test.js`;
- the webhook outbox, in `webhook-outbox.test.js`;
- webhook creation limits, in `audit-hardening.test.js`;
- weather-alert decisions, in `safety-nws.test.js`.

## Fixed by SEC-07

- **Quiz submit ran more than once.** `eduos_quiz_submit` checked the attempt was open, then updated it by id alone. A submit that waited on the row lock still updated it, moving `submitted_at`, and went on to add the attempt's mastery evidence again. All 8 of 8 simultaneous submits returned 200 before the fix. `db/185_quiz_submit_once.sql` adds `status='in_progress'` to the UPDATE.
- **Quiz start failed on a double tap.** Two starts both found no open attempt, and the second failed on the unique index with a 409 `already_exists`. Starts for one learner and quiz now take an advisory lock, so the second resumes the first's attempt.

## Adding a feature that uses something up

Lock the row, or for a new row an advisory lock on its natural key. Re-check the state in the statement that changes it. Back it with a unique index. Add a case to `concurrency.test.js` that fires the request 8 times and counts what was created.
