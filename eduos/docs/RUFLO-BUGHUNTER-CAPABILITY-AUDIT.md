# Ruflo and Claude-BugHunter: capability audit and extraction plan

**Status:** audit, 2026-11-27. No code, dependency, plugin or MCP server from either project is added to EduOS by this document.
**Asked for:** "incorporate" `ruvnet/ruflo` and `elementalsouls/Claude-BugHunter`. Agreed approach: audit both and extract what fits EduOS under its governance rules, the way the Project NOMAD plan did (`docs/PROJECT-NOMAD-CAPABILITY-EXTRACTION-INTEGRATION-PLAN.md`).

## 1. Summary

Neither project is a school feature. **Ruflo** is an agent harness for Claude Code and Codex: swarms, vector memory, self-learning, federation and a plugin marketplace. **Claude-BugHunter** is a skill bundle for bug-bounty and external red-team work. Neither belongs inside EduOS's runtime, and neither should be installed into this repository's development workflow by default.

What's worth taking is ideas, rebuilt in EduOS's own code and tests:

| From | Idea | EduOS use | Priority |
|---|---|---|---|
| BugHunter (IDOR / BOLA) | Assume every record id will be tried by someone it doesn't belong to | **Per-student row security on the nine tables found in §5.1**, plus a test that keeps it that way | **P0** |
| BugHunter (auth, session, IDOR) | Inventory every route, not just the "critical" ones | A route inventory test: every `/api` route has session or device auth, or is on an explicit public list | P1 |
| Ruflo (PII pipeline) | Secret-shaped patterns in outbound text | Add API keys, tokens, private keys and connection strings to the AI-gateway redaction | P1 |
| Ruflo (aidefence) + BugHunter (LLM, RAG) | Treat retrieved content as untrusted | Hostile-content fixtures for Christie and the LRH-08 assistant; retrieval only from approved, licence-reviewed content | P1 (before LRH-08) |
| Ruflo (audit events) | Record *that* something was removed, never *what* | Count-only redaction audit (kinds and counts, no values) | P2 |
| BugHunter (race conditions) | Single-packet concurrent requests | Concurrency tests on quiz attempts, payments, tickets and one-time codes | P2 |
| Ruflo (MetaHarness ADR-150) | "Removable augmentation": optional parts must be removable, with a CI job proving it | A no-optional CI run for optional integrations (AI providers, sports connectors, media scanning) | P3 |
| Ruflo (federation trust ladder) | Peers start untrusted and see discovery data only | Design input for district-to-district federation (wave 6), alongside the existing mesh and history delivery | P3 |
| BugHunter (methodology) | Scoped, written authorization before any active testing | An authorized staging-only scan (OWASP ZAP baseline) under a signed scope; never production, never third parties | P3 |

Rejected, with reasons, in §4.3 and §6.

## 2. The two projects

### Ruflo (`ruvnet/ruflo`, formerly Claude Flow)
- **What it is:** an "agent meta-harness" for Claude Code and Codex. CLI and MCP server; 100+ agent roles in swarm topologies; AgentDB/RuVector vector memory; self-learning (SONA, ReasoningBank, trajectory feedback); cross-machine federation; 48 Claude Code plugins and 14 npm plugins; a monitoring console.
- **Licence:** MIT. TypeScript/Node with Rust crates.
- **Maturity:** very active, about 81.6k stars and 10k+ commits. Its performance figures (routing accuracy, retrieval latency) are its own and not independently verified.
- **Security posture worth noting:**
  - federation uses mTLS, ed25519 identities and a 14-type PII pipeline (block, redact, hash or pass, per trust level);
  - the console defaults to read access plus ask-before-acting;
  - `ruflo-protector` ships deterministic, OWASP-mapped rules and a fail-open design.
- **Risks:** plugins ("mods") run with the user's account permissions and aren't sandboxed. Several components call LLM providers and remote MCP endpoints.

### Claude-BugHunter (`elementalsouls/Claude-BugHunter`)
- **What it is:** 83 skills for Claude Code and similar harnesses: methodology, 58 `hunt-*` vulnerability classes drawn from disclosed HackerOne reports, enterprise-platform attacks, recon and OSINT, reporting, a CLI, a HackerOne MCP server and a Burp Suite MCP integration.
- **Licence:** code MIT; documentation, wordlists and methodology CC BY 4.0, which requires attribution if any text is reused.
- **Scope it sets itself:**
  - only assets you own or are authorized to test;
  - external attack surface only;
  - no 0-day weaponization, malware or mass targeting.
- **How EduOS uses it:** defensively only. Its vulnerability classes are a checklist for reviewing EduOS's own code and tests. Nothing from it is run against any system, and none of its offensive tooling, wordlists or MCP servers are installed.

## 3. Governance check

The rules, and how each project measures against them:

| Rule | Ruflo inside EduOS | BugHunter inside EduOS |
|---|---|---|
| No vendor gets unrestricted student-data access | **Fails** as a runtime component: swarms, vector memory and multi-provider routing would pass data to model providers and memory stores outside the district's control | n/a (not a runtime component) |
| No external grade changes without district authorization | n/a | n/a |
| No weakening of existing RLS or school boundaries | Agent memory shared across sessions is a second, unscoped data store | Used defensively, it **strengthens** RLS (§5.1) |
| No automatic student transfers | n/a | n/a |
| No unapproved third-party data sharing | **Fails** for federation and provider failover unless each peer and provider is approved | Its HackerOne MCP would send findings to a third party: not used |
| No compliance claims without evidence and review | Its `hipaa`/`soc2`/`gdpr` "compliance modes" are labels, not evidence: EduOS must not repeat them | Its reports are not compliance evidence |

So both stay out of the runtime. Section 4 takes ideas only.

## 4. Ruflo: what to extract

### 4.1 Adopt (rebuild in EduOS)

1. **Secret-shaped redaction before AI egress** (from `pii-pipeline-service.ts`).
   - What EduOS already does: `src/christie/providers.js` `redact()` and `src/student-identifiers.js` are stronger than Ruflo's generic name regexes. They match every student in the district by name tokens and student numbers, in any script, and also remove emails, URLs, phone numbers, addresses, labelled birth dates and titled names.
   - What Ruflo has that EduOS doesn't: secret patterns (OpenAI-style and generic API keys, GitHub tokens, AWS keys, JWTs, PEM private keys, database URLs, `password=` pairs).
   - Why it matters: a teacher pasting a log or config into the staff assistant could send a secret to an external provider.
   - **Work item SEC-03.**
2. **Count-only redaction audit.** Ruflo's audit events record `piiTypesFound` and the action taken, without values. EduOS should write, per AI call, the kinds and counts removed (for example `{student_name: 2, email: 1}`) to the existing usage and audit record, never the text. This gives the district evidence that redaction runs, without creating a new store of personal data. **SEC-06.**
3. **Removable-augmentation rule** (ADR-150). Optional integrations must be removable: no static imports from optional packages, graceful degradation, and a CI job that runs the suite with the optional parts absent. EduOS already degrades when there's no external AI provider, ClamAV or sports connector. A CI job would prove it. **OPS-02.**

### 4.2 Adapt (design input, not code)

- **Deterministic guard rules** (`ruflo-protector` PR-001 to PR-013). These are narrow, explainable rules such as "a secret sent to a network sink" or "a risky action after outside content". They suit EduOS's classroom agent (`/api/classroom-agent/*`) and any future assistant that can act. Rules are pure functions over categorical events, store no content, and only notify unless the district turns on enforcement. *Use when an EduOS feature first takes actions on someone's behalf.*
- **Permission levels and approval modes** (console: read, write, manage, full; ask or auto; default read + ask). This matches EduOS's draft-only AI stance: Leo and the staff assistant draft, and people approve. Any future AI action stays at "ask" by default and logs who approved it.
- **Federation trust ladder** (untrusted → verified → attested → trusted; untrusted peers see discovery data only). This is input for district-to-district federation in wave 6. EduOS's existing same-deployment history delivery (TC-06c) and learner transfers already require district records-office approval at both ends. A trust ladder would sit before that, never replace it.
- **Prompt-injection screening for retrieved content** (aidefence). EduOS limits Christie to approved lessons. The LRH-08 assistant will retrieve from the licence-reviewed catalog. Both should treat retrieved text as data: hostile-content fixtures in tests, and no tool use or link rendering driven by retrieved text. **SEC-04.**

### 4.3 Reject

| Ruflo capability | Why not in EduOS |
|---|---|
| Self-learning from task trajectories (SONA, ReasoningBank) | Learning from use would mean learning from student and staff data. EduOS's AI must not be trained on student data. |
| Persistent vector memory (AgentDB, RuVector) of conversations | A second, unscoped store of personal data outside RLS. LRH-08's index will hold approved reference content only. |
| Multi-provider routing with failover | Sends data to providers the district didn't approve. EduOS uses one district-approved provider at a time (`ai_district_policy`), with egress pinned and allowlisted (`src/ai/provider-egress.js`). |
| Plugin marketplace and unsandboxed mods | Runs third-party code with full permissions. EduOS's app catalog uses district-approved LTI tools with scoped data. |
| Agent federation across organizations | Third-party data sharing without per-peer approval. |
| Compliance modes (`hipaa`, `soc2`, `gdpr`) | Labels, not evidence. EduOS makes no compliance claims without documented evidence and review. |

### 4.4 As development tooling for maintainers

Not added to this repository by default. A maintainer who chooses to use Ruflo locally should:
- keep it out of the repository (no committed `.claude-flow/`, hooks or MCP config);
- run `ruflo-protector` in `enforce` and the console at read + ask;
- never point it at production data or a database with real student records;
- install plugins only after reading their code.

EduOS's own CI (unit, integration, e2e, Flutter, CodeQL, dependency and container security, the GitHub ruleset) stays the gate either way.

## 5. BugHunter: EduOS checked against its vulnerability classes

### 5.1 Finding: student tables protected only at district level (P0)

BugHunter's IDOR and BOLA material starts from one rule: any id will eventually be tried by someone it doesn't belong to.

For EduOS, the defence is row security beneath the routes. Migration 173 added it to `assignment_submissions` after it was found during student app Phase C. A full scan of the migrated database (89 tables with a `student_id` column, all with forced RLS) found more tables in the same state. The runtime role can read them, and their only read policy is district isolation:

| Table | What it holds | Today |
|---|---|---|
| `student_case_notes` | counselor and staff case notes | district only |
| `student_intervention_cases` | intervention and support plans | district only |
| `attendance_events` | attendance marks | district only |
| `family_messages` | family messaging | district only |
| `guardian_invitations` | invitations to guardians | district only |
| `student_user_links` | which accounts are a student's family or the student | district only |
| `teacher_student_rosters` | which teacher has which student | district only |
| `athlete_association_consents` | athletic association consents | district only |
| `student_redact_tokens` | name and number tokens used for AI redaction | district only |

The routes filter these correctly as far as the reviews so far have seen. But any route that forgets a filter, or a future query, would expose a whole district's case notes or attendance to any signed-in pupil or parent in that district. Several of the tables are also used inside policies and definer functions (`student_user_links`, `teacher_student_rosters`, `student_redact_tokens`), so a fix has to keep those working.

`activity_media_*` tables are limited to school (plus district roles), not district. They're tighter, but still not per-student, and are reviewed in the same pass.

**Work items:**
- **SEC-01:** per-student restrictive read and write policies on each table above, in the 173 pattern. One table or group per PR, each with a runtime-role test (learner, each parent, teachers who do and don't teach them, the principal, another school, another district) and the full integration suite. Order: `student_case_notes` and `student_intervention_cases`; then `attendance_events`, `family_messages` and `guardian_invitations`; then the link and roster tables, which policies depend on; then the rest.
- **SEC-02:** an RLS coverage test that fails CI when a table with a `student_id` column has no restrictive per-student read policy, unless the table is on a reviewed allowlist with a reason. That would have caught 173 and SEC-01 when the tables were added.

### 5.2 Other classes

"Controls" are what EduOS does today, with where to look. "Next" is the follow-up, if any.

| Class (BugHunter skill) | EduOS controls today | Next |
|---|---|---|
| IDOR / BOLA (`hunt-idor`) | Forced RLS everywhere; per-student policies on learning tables (014, 173); runtime-role tests in integration | SEC-01, SEC-02 |
| Auth bypass, session (`hunt-auth-bypass`, `hunt-session`) | Server sessions, hashed tokens, `httpOnly` + `SameSite=Lax` cookies; previous session revoked at sign-in (`src/auth.js`) | SEC-05 route inventory |
| CSRF (`hunt-csrf`) | Per-session CSRF token checked in constant time on writes (`requireCsrf`) | Covered by SEC-05 |
| OAuth / OIDC (`hunt-oauth`, `hunt-open-redirect`) | State, nonce and PKCE stored server-side; return paths from a fixed list (`RETURN_PATHS`); native app redirects must be registered | — |
| JWT (`hunt-jwt-crypto`) | LTI accepts RS256 only, checks `typ` and the tool's JWKS (`src/lti.js`) | — |
| SSRF (`hunt-ssrf`) | Webhooks and AI egress resolve every DNS answer, refuse non-public addresses and connect to the vetted address (`src/webhooks.js`, `src/ai/provider-egress.js`) | — |
| File upload (`hunt-file-upload`) | Type from magic bytes; images decoded and re-encoded; media scanned with ClamAV before use (`src/branding-images.js`, `docs/MEDIA-STORAGE.md`) | — |
| XSS / DOM (`hunt-xss`, `hunt-dom`) | The web app builds DOM with text nodes (`h()` never sets `innerHTML`); strict CSP via helmet (`src/csp.js`) | Keep a lint for `innerHTML` |
| Clickjacking (`hunt-clickjacking`) | `frame-ancestors 'self'` | — |
| SQL injection (`hunt-sqli`) | Parameterized queries; dynamic column lists only from fixed allowlists | — |
| Race conditions (`hunt-race-condition`) | `FOR UPDATE` in about 100 places; partial unique indexes for one-open-per-thing rules | SEC-07 concurrency tests |
| Business logic (`hunt-business-logic`) | Two-person rules (licence review, payments); database CHECKs for publish gates; append-only ledgers | — |
| Brute force, rate (`hunt-brute-force`) | Rate limits on 69 route modules | Include in SEC-05 |
| Cache (`hunt-cache-poison`) | `Cache-Control: no-store` on personal data responses | Include in SEC-05 |
| LLM / prompt injection (`hunt-llm-ai`) | Approved content only; hints not answers; redaction before any external provider; output shown as text, so no markdown image exfiltration | SEC-03, SEC-04 |
| RAG / vector (`hunt-rag-vector`) | Not built yet (LRH-08) | SEC-04 before LRH-08 |
| CI/CD, supply chain (`hunt-cicd`, `supply-chain-attack-recon`) | Ruleset on main (PR, required checks, no force push); CodeQL; dependency and container scanning | OPS-02 |
| Error disclosure (`hunt-exceptional-conditions`) | `sendError` returns codes, not stack traces | — |
| XXE, SSTI, deserialization, WebSocket | No XML parser, no server-side template engine, JSON only, no WebSockets in `src/` | Re-check if any is added |

### 5.3 Active testing

BugHunter's methodology requires written authorization and a defined scope before any active testing. EduOS should do the same:
- an OWASP ZAP baseline scan against staging only, under a scope document signed by the district;
- no production systems and no third-party systems (identity providers, payment processors, LTI tools);
- no real student data in staging.

This is **OPS-03**, and is optional. None of BugHunter's own attack tooling is used.

## 6. Work items

| ID | Item | Priority | Depends on |
|---|---|---|---|
| SEC-01 | Per-student RLS on the tables in §5.1, one table or group per PR | P0 | — |
| SEC-02 | RLS coverage test in CI with a reviewed allowlist (**built**: `test/integration/rls-coverage.test.js`; the reviewed list shrinks as SEC-01 lands) | P0 | — |
| SEC-05 | Route inventory test: every `/api` route has auth middleware or a public-list entry with a reason; rate limit and `no-store` noted | P1 | — |
| SEC-03 | Secret-shaped patterns in AI-gateway redaction | P1 | — |
| SEC-04 | Hostile-content fixtures for Christie and the LRH-08 assistant | P1 | before LRH-08 |
| SEC-06 | Count-only redaction audit per AI call | P2 | SEC-03 |
| SEC-07 | Concurrency tests: quiz attempts, payments, tickets, one-time codes | P2 | — |
| SEC-08 | Narrow staff reads of `students` from district-wide to their school (**built**: `db/183_staff_school_scope.sql`; district roles, the SIS scheduler and district-only jobs keep the district, drivers see their riders; tested in `test/integration/students-rls.test.js`) | P1 | SEC-01 part 4 |
| OPS-02 | CI run with optional integrations absent | P3 | — |
| OPS-03 | Authorized staging-only scan under a signed scope | P3 | staging |

## 7. Attribution

- Ruflo is MIT-licensed (© ruvnet). Claude-BugHunter code is MIT (© Sachin Sharma) and its documentation is CC BY 4.0.
- This document paraphrases both and copies no code or text.
- If a future PR reuses BugHunter documentation text, it must carry CC BY 4.0 attribution.

## Sources

- https://github.com/ruvnet/ruflo (README; `plugins/ruflo-aidefence`, `plugins/ruflo-protector`, `plugins/ruflo-metaharness`; `v3/@claude-flow/plugin-agent-federation/src/domain/services/pii-pipeline-service.ts` and `audit-service.ts`)
- https://github.com/elementalsouls/Claude-BugHunter (README; `skills/hunt-*`, in particular `hunt-idor`, `hunt-llm-ai`, `hunt-rag-vector`, `hunt-race-condition`, `hunt-open-redirect`)
- EduOS: `db/173_assignment_submission_rls.sql`, `src/christie/providers.js`, `src/student-identifiers.js`, `src/ai/provider-egress.js`, `src/webhooks.js`, `src/auth.js`, `src/csp.js`, `src/lti.js`, `src/branding-images.js`
