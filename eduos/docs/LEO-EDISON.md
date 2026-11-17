# Leo and Edison (37.6.0 candidate)

Both run on the staff AI gateway (`src/ai/*`, `docs/AI-ASSISTANT.md`): off
until the superintendent turns each on (Assistant settings), the same role
rules, district and per-person token budgets, redaction before anything goes
to an external model, usage rows and an audit entry per call. The shared call
path is `src/ai/invoke.js` (moved out of `/api/ai/run`). It includes the
district AI privacy switch from #48 (this branch is stacked on it): when an
external provider is configured, Leo and Edison send nothing to it until the
superintendent turns external AI on with the privacy acknowledgement
(`PUT /api/ai/policy` `externalProviderEnabled: true, privacyAcknowledged:
true`); until then both return 403 `ai_external_provider_disabled`.

Neither profiles, scores, ranks or predicts anything about a student (p21).
Neither uses location, facial recognition or threat scoring.

## Leo: lesson drafts that need approval

| | |
|---|---|
| Who | teacher (own courses), principal (own school), superintendent |
| Switch | `leo_lesson` in Assistant settings |
| Input | 1-4 district standards, up to 3 **approved** lessons in the same course, up to 2 **approved** primary sources, an optional focus (100 chars), 30/45/60 minutes |
| Output | a new **draft** lesson in the chosen unit, linked to the standards |

- `GET /api/leo/options?courseId=` lists the units, standards, approved lessons
  and approved sources Leo may use, and whether Leo is on.
- `POST /api/leo/drafts` builds the draft. Locally (no network) it is a
  deterministic template (`src/ai/leo-template.js`). With an external provider
  the model is sent a plain-text curriculum brief only, redacted like any
  pasted text (any district student named in a lesson or source is removed);
  title and objective are always computed by EduOS.
- The saved lesson has `generated_by` (`leo-local` / `leo-external`) and
  `generated_from` (ids of the standards, lessons and sources used, and the
  `ai_usage` row). The content starts `LEO DRAFT: needs review and school
  leader approval before use.`
- **Approval is enforced in the database** (`db/059_leo_edison.sql`,
  trigger `lessons_zz_leo_guard`): a Leo lesson is created as an unapproved
  draft, can't be published until a school leader approves it with the existing
  lesson approval, and its provenance can't be changed by the app. If a
  teacher edits an approved, published Leo lesson, the existing 014 guard
  clears the approval and Leo's guard returns it to draft. The API answers
  `409 leo_draft_needs_approval` before the database has to.
- Ordinary (non-Leo) lessons behave exactly as before.

## Edison: trends from aggregation-gate output only

| | |
|---|---|
| Who | principal and vice principal (own school), superintendent (district, up to 50 schools) |
| Data | `attendance_daily` for the last 1-20 school days, today's `transport_checkins_daily`, `enrollment_by_grade` |
| Rule | every table goes through `release()` in `src/eden/aggregation-gate.js` before Edison reads it |

- `GET /api/edison/trends?days=10` (no AI; role only) returns, per school,
  the published "all grades" / "all routes" margins: counts under 5 and
  complementary cells are `null` and listed as suppressed. Edison never
  estimates them; rates are computed from published counts only. A table the
  gate refuses is skipped and counted in `withheld`.
- `POST /api/edison/brief {days}` (switch `ops_trends`) writes a short brief
  over exactly that released context. The model sees school **labels**
  ("School 1"), dates and released counts; school names are mapped back in the
  browser.
- Raw counts come from `eduos_edison_source(kind, school, day)` (SECURITY
  DEFINER, school leaders in their own scope, the same SQL as the EDEN node's
  `eduos_eden_source`) and go straight into the gate; the identifier index
  (`eduos_edison_identifiers()`) never leaves the server.
- The gate's allow-list (`KINDS`) is unchanged: Edison adds no new aggregate
  kind and nothing new can leave a school node.

## Not in this PR

- The existing **Operations brief** (`ops_brief`, also named Edison in its
  prompt) still uses today's raw school-level counts, not gate output. Moving
  it onto the gate would change existing behavior, so it is left for review.
- No Flutter screens; the web app gets a Leo card on the course page and an
  Edison card on Overview / Operations.
