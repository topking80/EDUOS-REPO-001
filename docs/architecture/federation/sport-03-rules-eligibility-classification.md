# SPORT-03 — Rules, eligibility, classification, officials, and sanctioning

Status: registry contract and architecture foundation only. No association rule is normalized, interpreted, or activated by this schema.
Scope: association-owned rule sources and versions; eligibility policies; classification cycles and school assignments; official credentials; event/school sanctioning records.

## Authority and provenance

- Each rule source identifies its issuing organization and authority level. NFHS and other external bodies may be sources, but state-association variations and decisions remain distinct.
- A rule version is immutable once approved/published. Corrections and amendments create a new version with publication/effective dates and explicit supersession.
- Every operational policy references the exact rule version, association, activity/school scope, source URL, verification status, and effective period.
- EduOS stores official rule metadata and authorized references. It must not reproduce copyrighted rulebooks or claim endorsement absent permission.
- No national rule update silently overrides a state association decision where the association has authority.

## Eligibility and transfers

- Eligibility policy types include age, grade, enrollment, residency, transfer, academic standing, amateur status, recruiting, medical/safety, hardship, and association-defined categories.
- Each policy has explicit activity/level scope, effective dates, decision authority, source evidence, and appeal route.
- A case decision engine is not part of this slice. No eligibility result may be inferred from incomplete data or a generic national default.
- Student data remains in the district education tenant. Later eligibility exchange must be purpose-bound, minimized, consent/authority checked, and audited. The registry does not store student identifiers or eligibility case evidence.

## Classification

- Classification cycles are association-defined and may vary by sport, division, school type, enrollment method, competitive balance, geography, and cycle.
- A school's classification is not a permanent school attribute. Assignments are tied to a specific organization, cycle, activity, and effective period.
- Appeals and final decisions must preserve the original assignment and its source/cycle history. Do not overwrite historical classifications.
- Competition districts/regions/leagues and education districts are different entities.

## Officials and sanctioning

- Official credentials are association-issued, activity-scoped, effective-dated, and revocable. A credential record is not a background-check result or a claim of eligibility to work in every jurisdiction.
- Sanctioning records identify the competent association, event or school reference, decision type, authority, dates, source, and appeal reference. EduOS records decisions; it does not decide sanctions.
- Access to confidential disciplinary or student-related records requires separate authorization and data minimization.

## Acceptance criteria

- Rule sources, versions, eligibility policies, classification cycles/assignments, official credentials, and sanctioning records are represented independently.
- Rule versions and eligibility policies reference their source/rule version; classifications reference an association cycle; all records reference a canonical organization.
- Scope and effective dates are mandatory where a policy or assignment can change over time.
- Empty seed collections remain empty until official primary sources and approvals support population.
- Tests cover invalid scope/status and referential integrity.
- Association autonomy, NFHS preservation, district data ownership, and no blanket student-data access remain enforced design constraints.

## Delivery boundary

This PR creates data contracts and tests. It does not implement eligibility adjudication, student record exchange, classification calculations, official assignment, sanction decision-making, or rulebook redistribution. Those require separate service/API slices and association-specific conformance tests.
