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

## Rules

- **Off until the superintendent turns each tool on** (District tab →
  Assistant settings). Students and families have none of these tools.
- **The AI never reads student records.** It gets the text the person typed,
  or for the operations brief only counts (attendance marked today, active
  safety incidents, open service work, substitute coverage needed) for the
  person's own school, or the district for a superintendent, computed under
  row-level security.
- **Budgets:** district tokens per day and tokens per person per day, as hard
  limits. Before anything is sent, a request reserves the most it could
  possibly use, one request at a time per district: the UTF-8 bytes of what
  would be sent (system prompt, redacted text, framing), since no tokenizer
  makes a token smaller than a byte, plus the 900-token output cap (sent to
  the model as max_tokens; local answers are cut to fit). It then settles to
  what it used. A request that could never fit a budget is refused as such.
  If a provider ever reports more than its reservation, that is recorded
  (it is what will be billed) and flagged in the audit log. The provider call
  is cut off at AI_PROVIDER_TIMEOUT_MS (at most 120 s); a reservation only
  stops counting after 15 minutes, so it can't lapse while a request runs.
- **Kept:** use case, role, tokens and provider for each use; every use is in
  the audit log. **Not kept:** the prompt or the answer.

## Provider

`AI_PROVIDER=local` (default) answers from templates and simple text analysis
on the server, with no network. `AI_PROVIDER=openai_compatible` with
`AI_ALLOW_EXTERNAL_PROVIDER=true`, `AI_PROVIDER_URL` (https) and
`AI_PROVIDER_MODEL` uses an external chat-completions API. Before anything is
sent, emails, phone numbers, URLs and id-like strings are removed, as are the
names and student numbers of every student in the district that appear in the
text, for every role (the database finds them, with no size limit). If that
lookup fails, nothing is sent. Names are matched in any script: word edges
are Unicode-aware; Chinese, Japanese, Korean and Thai names match inside
text without spaces; text and names are compared in NFC with curly and
straight apostrophes alike; whole names are removed first (which catches
initials and one-letter names), then each part, including each side of a
hyphen. The student tutor (Christie) uses the same removal. The operations
brief sends only its counts. If the service fails, the local answer is used.
