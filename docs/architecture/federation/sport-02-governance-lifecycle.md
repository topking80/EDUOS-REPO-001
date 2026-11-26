# SPORT-02 — State association governance and delegated authority

Status: data-contract foundation; not an assertion that association bylaws or governance records have been fully verified.
Scope: governance bodies, bounded delegations, formal decisions, and appeals for autonomous athletics/activity associations.

## Non-negotiable governance boundaries

1. The association remains the decision-maker for matters within its lawful/bylaw authority. EduOS records and routes governance; it does not become the governing body.
2. NFHS is a national reference/federation relationship, not an EduOS platform owner. National materials and rules do not silently supersede an association's valid state decisions.
3. Education state authorities and athletics state associations are distinct organizations with distinct authority.
4. Districts remain education tenants and retain ownership/control of student records. Association governance and membership never grant blanket student/guardian record access.
5. Delegation is explicit, scoped, approved, effective-dated, constrained, revocable, and auditable. No inferred or transitive authority.
6. Governance facts require official source provenance and verification status. Unknown bylaws, votes, committee membership, or appeals routes remain unpopulated.

## Records

- **Governance body**: board, executive/standing/sport committee, appeals panel, membership assembly, or other association-defined body; scoped activities, lifecycle, and effective dates.
- **Delegation**: named delegator and delegate, exact authority scope, optional decision types and constraints, approval reference, lifecycle, and source evidence. A delegation cannot enlarge the delegator's own authority.
- **Governance decision**: formal action attributable to an organization and decision body, with authority reference, decision date, status, optional effective period, and vote-record reference.
- **Appeal**: appeal of a recorded decision, filed date, review authority, status, outcome date/reference. EduOS tracks process and evidence; it does not determine the merits.

## Operational rules

- Keep board composition, member voting eligibility, quorum, election method, term limits, and committee appointment rules in versioned association-specific governance documents; do not impose a universal template.
- A vote record must preserve the governing instrument/version, eligible electorate, quorum rule and result, without exposing confidential ballots where prohibited. Individual voter identities are not required by this registry contract.
- Decisions and appeals must point to the authority and source version in force at the relevant date.
- Effective periods are inclusive date ranges; an end date earlier than a start date is invalid.
- Suspension or revocation of a delegation must stop future use; it must not rewrite historical decisions already taken under a valid delegation.
- Association administrative districts, competition regions, sections, leagues, and school education districts are separate concepts.
- Do not populate records from a general website summary when the operative constitution/bylaw or official decision is available. Mark inaccessible or unverified sources accordingly.

## Acceptance criteria

- All four collections exist and are empty until primary-source-backed records are approved.
- Governance body and delegation IDs are unique; organization references resolve.
- Decisions reference an existing governance body; appeals reference an existing decision.
- Delegations require nonempty authority scopes, valid lifecycle states, and source provenance.
- No role or delegation can grant unrestricted student-record access or change education-tenant ownership.
- Historical decisions remain immutable; later amendments create new effective-dated records.
- Tests cover valid and invalid scoped delegation records and referential integrity.

## Delivery boundary

This PR establishes the registry contract and architecture rules only. It does not ingest individual board members, voting records, bylaws, school membership, eligibility rulings, or appeals. Those require association-specific primary evidence and separate review.
