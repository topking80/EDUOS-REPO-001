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
- **Budgets:** district tokens per day and tokens per person per day.
- **Kept:** use case, role, tokens and provider for each use; every use is in
  the audit log. **Not kept:** the prompt or the answer.

## Provider

`AI_PROVIDER=local` (default) answers from templates and simple text analysis
on the server, with no network. `AI_PROVIDER=openai_compatible` with
`AI_ALLOW_EXTERNAL_PROVIDER=true`, `AI_PROVIDER_URL` (https) and
`AI_PROVIDER_MODEL` uses an external chat-completions API. Before anything is
sent, emails, phone numbers, URLs and id-like strings are removed, as are the
names and student numbers of the students the person can see. The operations
brief sends only its counts. If the service fails, the local answer is used.
