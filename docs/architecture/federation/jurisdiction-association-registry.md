# Federation jurisdiction and association registry

Status: initial implementation contract and seed registry for FED-01 / SPORT-01.
Scope: 50 U.S. states, Washington, D.C., Puerto Rico, U.S. Virgin Islands, and American Samoa.
This is a registry foundation, not a claim that every association's legal status, current membership, or current rules have been fully verified.

## Design invariants

1. A jurisdiction is not an association. One jurisdiction can contain multiple associations, school-system leagues, government athletics offices, university leagues, youth leagues, and island-based competition bodies.
2. Association identity is a stable canonical ID, never an acronym. Acronyms are aliases and may collide (e.g. MHSAA in Michigan/Mississippi; WIAA in Washington/Wisconsin).
3. Associations have explicit scope: jurisdiction, education level, school types, activities, geography, and dates of authority/operation.
4. Governance type and legal authority are separate dimensions. A voluntary nonprofit can exercise delegated statutory authority; a government office is not modeled as a nonprofit.
5. Membership is many-to-many and time-bound: school ↔ association ↔ activity/sport ↔ season, with membership class and entitlements.
6. Rule sources are layered and versioned: statute/regulation, education authority, association constitution/bylaws, board policy, sport/activity manual, external rule body (e.g. NFHS), and local school policy. Store provenance, approval state, effective dates, supersession, and jurisdiction.
7. Historical organizations remain queryable through predecessor/successor relationships; do not silently overwrite names or merge legal entities.
8. Unverified claims stay explicitly unverified. Never infer legal authority, territory-wide scope, or endorsement from a name or competition listing.
9. District-owned student data remains in the education tenant. Sports federation affiliation does not confer broad access to student records.
10. Cross-jurisdiction exchanges require purpose, minimum necessary data, authorization, retention rules, and audit.

## Registry entities

### Jurisdiction
Required: `id`, `name`, `kind`, `country_code`, `active`.
Optional: `postal_code`, `parent_id`, `languages`, `notes`.
Kinds: `state`, `federal_district`, `commonwealth`, `territory`.
Use ISO 3166-2-style IDs (US-XX); retain local legal/administrative names separately.

### Organization
Required: `id`, `legal_name`, `organization_type`, `governance_type`, `jurisdiction_ids`, `scope`, `verification_status`, `active`.
Organization types include: `independent_association`, `government_office`, `school_system_league`, `regional_association`, `university_league`, `youth_league`, `affiliate_body`.
Governance types include: `member_governed_nonprofit`, `private_nonprofit`, `statutory_body`, `delegated_authority_body`, `education_department_office`, `school_system_program`, `unverified`.
Keep `legal_authority` separate from `governance_type`: `independent`, `statutory`, `delegated`, `departmental`, `school_system`, `contractual`, `unverified`.

### Association relationship
`organization_relationships` records predecessor/successor, umbrella/member, section/league, affiliate, and cross-island relationships with source, effective dates, and verification status.

### Membership
A separate record references organization, school, school level, activity, season, membership class, entitlements, status, approval evidence, fees, and effective dates. Never store a single association ID directly on a school as the only affiliation.

### Authority and rules
A separate rule-source record identifies issuer, authority level, document type, version, publication/approval/effective dates, scope, URL, language, and supersession. A rule decision records who decided, under which authority/version, evidence, appeal path, and outcome.

## Initial API/data contract

Use opaque IDs, ISO dates, stable enumerations, and nullable fields for unknowns. Do not use display labels as keys. All imported source facts must carry `source_url`, `observed_at`, and `verification_status`. A current rule is not established merely because a document is discoverable.

## Acceptance criteria for this foundation

- All 54 jurisdiction IDs exist exactly once.
- DC, PR, VI, and AS are not misclassified as states.
- Organization records support multiple organizations per jurisdiction and multiple jurisdictions per organization.
- Canonical IDs are unique even where acronyms collide.
- ASHSSA is historical predecessor to ASDOE Athletic Office, not a second current operator.
- DCSAA and DCIAA are distinct organizations.
- Puerto Rico PRHSAA is not conflated with university/youth leagues.
- U.S. Virgin Islands island-level bodies are separate and carry an explicit unverified governance status pending primary constitutions.
- Iowa supports IHSAA and IGHSAU as separate organizations.
- California CIF supports state/section/league relationships without flattening section governance into school districts.
- No organization membership grants unrestricted access to education records.
- Schema validation and seed tests cover uniqueness, referential integrity, date ranges, aliases, and relationship cycles.

## Follow-on implementation slices

1. FED-01A: registry schema, migrations, seed data, canonical IDs, source provenance.
2. FED-01B: organization relationships, sections, islands, school-system and affiliate bodies.
3. FED-01C: membership lifecycle and entitlements.
4. SPORT-02: association governance, delegated authority, committees, voting and appeals.
5. SPORT-03/04: rules, classifications, alignment, seasons, brackets and results.
6. FED-06/07: authorized exchange and jurisdiction/privacy controls.

## Evidence limitations

The 50-state research is first-pass. Several associations need current bylaws, classification formula, membership status, and appeal process revalidated before operational rule ingestion. Puerto Rico public-school governance and the U.S. Virgin Islands territory-wide governance structure need further primary-source research. American Samoa's current DOE athletics office was identified as successor to ASHSSA. D.C. statutory membership provisions have an implementation caveat and require legal review before encoding.
