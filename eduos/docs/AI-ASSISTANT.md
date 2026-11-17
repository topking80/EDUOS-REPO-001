# Staff assistant (AI gateway)

Ported from the EdOS `app` repository's AI gateway and rebuilt on EduOS
sign-in, roles and row-level security. Student tutoring stays with Christie
(its own controls); this is for staff.

| Tool | Who | Input |
|---|---|---|
| Lesson draft | teacher, principal, vice principal, superintendent | a topic |
| Summarize a resource | the above, counselor, librarian | pasted text |
| Writing feedback | teacher, principal, vice principal | pasted student writing |
| Operations brief | principal, vice principal, superintendent | none: counts EduOS computes |
| Leo lesson drafts (37.6.0) | teacher, principal, superintendent | the course's standards, approved lessons and approved primary sources; saved as a draft lesson for approval |
| Edison trends brief (37.6.0) | principal, vice principal, superintendent | none: counts released by the EDEN aggregation gate |

Leo and Edison run only through their own endpoints (`/api/leo/drafts`,
`/api/edison/brief`), never `/api/ai/run`; see `docs/LEO-EDISON.md`.

## Rules

- **Off until the superintendent turns each tool on** (District tab →
  Assistant settings). Students and families have none of these tools.
- **The AI never reads student records.** It gets the text the person typed,
  or for the operations brief only counts (attendance marked today, active
  safety incidents, open service work, substitute coverage needed) for the
  person's own school, or the district for a superintendent, computed under
  row-level security.
- **Budgets:** district tokens per day and tokens per person per day.
  - *Reserved first.* Before anything is sent, a request reserves the most it
    could use, one request at a time per district: the UTF-8 bytes of exactly
    what would be sent (system prompt, redacted text, framing; no tokenizer
    makes a token smaller than a byte) plus the 900-token output cap, which is
    sent to the model as `max_tokens`. A request that could never fit a budget
    is refused as such. The policy is read under the same lock a policy change
    takes, so a request can't reserve against a budget or tool that was just
    lowered or turned off.
  - *Settled conservatively.* With the provider's own usage report (two
    non-negative integers), the request settles to it. With no report, a
    nonsense one, an error or a timeout, the **full reservation stands**: the
    provider was sent the request and may bill it. The audit entry says which
    (`usage=reported`, `usage=reserved` or `usage=local`).
  - *Local answers* aren't tokenized or billed by anyone; EduOS meters them at
    one unit per 4 UTF-8 bytes, in and out, and cuts them to 900 units (3,600
    bytes), so they can't exceed the output cap or their reservation in any
    language.
  - *What it can't do:* stop a provider billing more than `max_tokens` allows.
    If a report exceeds the reservation it is recorded (it is what will be
    billed) and flagged `over_reservation` in the audit log.
  - *Never released after a provider call.* If recording the result fails
    after an external provider was called, the reservation is recorded as used
    in full; if that fails too, it stays reserved and keeps counting. A
    reservation never lapses on a timer: it counts until it is settled or
    given back, so a failure can over-count a day's budget but not under-count
    it. The provider call is cut off at AI_PROVIDER_TIMEOUT_MS (at most 120 s).
- **Kept:** use case, role, tokens and provider for each use; every use is in
  the audit log. **Not kept:** the prompt or the answer. (Exception by design:
  a Leo draft IS the answer, saved as a draft lesson the teacher asked for.)

## Provider

`AI_PROVIDER=local` (default) answers from templates and simple text analysis
on the server, with no network. `AI_PROVIDER=openai_compatible` with
`AI_ALLOW_EXTERNAL_PROVIDER=true`, `AI_PROVIDER_URL` (https) and
`AI_PROVIDER_MODEL` uses an external chat-completions API. Before anything is
sent, the names and student numbers of every student in the district that
the text mentions are removed, for every role, then emails, phone numbers,
URLs and id-like strings. If the lookup fails, nothing is sent. The operations
brief sends only its counts. If the service fails, the local answer is used.

## How students are found and removed

The same rules protect the staff assistant and the student tutor (Christie).

- **Finding** (`src/student-identifiers.js`, `db/043`): the database splits
  names, student numbers and the text with one tokenizer (NFC, lowercase,
  split on spaces and punctuation, including hyphens, commas, slashes and
  apostrophes) and matches on an indexed token table kept current by a
  trigger. A student is found when a name part of two or more characters is a
  word of the text ("Okonkwo-Reyes" or "Reyes" finds Marisol Okonkwo-Reyes;
  "Doe" finds "Doe, Jane"), when every part of their name is, when every part
  of their number is ("SIS 2026 55417", "A/2026/001"), or when the number
  without separators is. Names in scripts written without spaces (Chinese,
  Japanese, Korean, Thai...) are matched anywhere in the text. Measured at
  100,000 students: about 0.2 s a request, 20 at once in under 3 s.
- **Removing** (`src/redact-names.js`): Unicode-aware word edges; the whole
  name first, then each part of two or more characters, including each side
  of a hyphen or apostrophe; numbers as phrases however they are punctuated.
- **One-character parts** (an initial, "Q Z", a one-character family name) are
  removed only as part of the whole name, never alone: removing every lone
  "A" or "明" would wreck ordinary text, and a lone initial identifies no one.
- **Not covered:** a number stored without separators but typed with them
  ("202655417" typed as "2026 55417", though the generic id patterns catch
  most such digit runs); nicknames or misspellings; names of staff or family
  members; a name part that is also an ordinary word is removed wherever it
  appears.

## Christie (student tutor) with an external provider

Off by default (`CHRISTIE_PROVIDER`, `CHRISTIE_ALLOW_EXTERNAL_PROVIDER`). When
on, **every field** of the request is sanitized, not only the learner's
question: lesson title, approved lesson, problem and hints lose the names and
numbers of any district student, email and web addresses, phone-shaped
numbers, street addresses and dates labelled as a birth date. Other digits and
dates are left alone: maths and history are full of them. Pattern-matching
can't recognize every personal detail (an unlabelled birthday, an unusually
written address, a staff or family member's name), so lessons should be
written without them. "Approved for teaching" doesn't mean free of personal
information. The provider serializes only that sanitized copy; without one it
sends nothing. The learner still sees the original content, and the local
tutor still uses it.
