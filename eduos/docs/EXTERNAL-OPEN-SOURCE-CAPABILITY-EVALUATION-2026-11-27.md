# External Open-Source Capability Evaluation

**Date:** 2026-11-27  
**Target:** EduOS `main`  
**Status:** Research baseline — no external code imported or deployed  
**Purpose:** Identify mature open-source projects whose capabilities can improve EduOS without creating duplicate systems of record or weakening district governance.

## Executive recommendation

Treat external projects as capability references and, where justified, separately deployed services behind governed EduOS integrations. Do not copy whole applications into the EduOS codebase by default.

Recommended evaluation order:

1. **Kolibri** — strongest immediate fit for offline-first learning content and the EDEN/school-node direction.
2. **BigBlueButton** — mature virtual-classroom capability that could fill synchronous instruction and tutoring gaps.
3. **Keycloak** — evaluate identity federation and standards compatibility, but do not replace EduOS sign-in without an architecture decision.
4. **Frappe Education and RosarioSIS** — compare workflows and data models; do not create a second SIS or duplicate student records.
5. **Koha** — assess a library integration only if native EduOS library workflows cannot meet district requirements.
6. **Snipe-IT** — assess asset inventory workflows; its AGPL license and IT-asset focus require careful review before code reuse.
7. **Jitsi Meet** — alternative video/meeting platform to compare against BigBlueButton; avoid implementing both without a clear use-case split.

## Existing EduOS capabilities and non-negotiable boundaries

The current EduOS documentation describes:

- Public district, homeschool-family, and independent private-school contexts with separate data boundaries.
- Role-specific applications for students, families, teachers, administrators, and school operations.
- SIS import and scheduled synchronization, LTI 1.3, Canvas integration, webhooks, and a district-approved app catalog.
- EDEN school nodes designed for local continuity during WAN outages.
- Master Control federation, delegated authority, signed policy bundles, and aggregate-only exchange by default.
- District-governed external AI egress, disabled unless allowed.

The district governance acceptance baseline requires server-derived actor/context, district and school isolation, forced PostgreSQL RLS, least-privilege runtime grants, explicit app approval and data scopes, consent-aware media delivery, auditability, and no unapproved third-party data sharing.

These requirements govern every integration in this evaluation. An external service must not become an alternate route around EduOS authorization.

## Repository evaluations

### 1. Kolibri — offline-first learning platform

- Repository: https://github.com/learningequality/kolibri
- Maintainer: Learning Equality
- Default branch observed: `develop`
- Repository is public and not archived at time of review.
- README describes an offline-first learning platform for teaching and learning without requiring internet connectivity.
- License file inspected: MIT.

**Potential EduOS value**
- Offline learning-resource delivery.
- Local content catalog and learner access patterns.
- Possible school-node content synchronization and resilience model.
- Potential complement to the planned native NOMAD capability extraction.

**Recommended disposition:** **Prioritize technical spike.**

**Integration shape:** Prefer a school-node/local service or a controlled content integration. EduOS remains authoritative for learner identity, school membership, permissions, course enrollment, and reporting. Define content identifiers, entitlement checks, sync ownership, and progress-event contracts before implementation.

**Risks / checks**
- Verify whether Kolibri's learner/course model maps cleanly to EduOS without creating a second roster.
- Define offline progress reconciliation, duplicate-event handling, retention, and audit behavior.
- Confirm media/content licensing independently of the software license.
- Review the complete dependency and security posture before deployment.

### 2. BigBlueButton — virtual classroom

- Repository: https://github.com/bigbluebutton/bigbluebutton
- Default branch observed: `v4.0.x-develop`
- Repository is public and not archived at time of review.
- README describes real-time audio/video, slides, whiteboard, chat, polls, breakout rooms, recordings, and learning analytics.
- Exact top-level license file was not confirmed in this pass; obtain and review the authoritative license and component notices before adoption.

**Potential EduOS value**
- Live classes and remote tutoring.
- Parent-teacher conferences and staff professional learning.
- Breakout collaboration, shared whiteboards, and moderated sessions.

**Recommended disposition:** **Prioritize architecture and deployment spike.**

**Integration shape:** EduOS creates a meeting only after role, school, course, and participant authorization. Use short-lived, scoped meeting credentials; avoid exposing raw service secrets to clients. Define recording consent, retention, deletion, access logs, and district-level enablement.

**Risks / checks**
- Media infrastructure capacity, bandwidth, recording storage, accessibility, moderation, and abuse handling.
- Meeting participation must not implicitly disclose student rosters to unauthorized participants.
- Confirm license obligations for the full server distribution and bundled components.

### 3. Keycloak — identity and access management

- Repository: https://github.com/keycloak/keycloak
- Default branch observed: `main`
- Repository is public and not archived at time of review.
- README describes user federation, strong authentication, user management, and fine-grained authorization.
- License file was not confirmed in the inspected path during this pass; verify the repository's current license and notices before use.

**Potential EduOS value**
- Standards-based identity federation.
- Enterprise SSO and MFA options.
- External identity-provider brokering.
- Potential support for district and partner identity integrations.

**Recommended disposition:** **Architecture comparison only; no replacement decision.**

**Integration shape:** Compare Keycloak's OIDC/SAML and federation capabilities with EduOS's current session, identity, and Master Control federation architecture. If used, it must authenticate identities—not decide EduOS district, school, student-record, or role permissions. EduOS remains the authorization and data-governance authority.

**Risks / checks**
- Avoid dual identity stores and conflicting role/tenant sources.
- Model account linking, deprovisioning, recovery, MFA policy, and emergency access.
- Test tenant/school context switching and session revocation.
- Do not migrate production identities until a formal architecture review and rollback plan exist.

### 4. Frappe Education — education management system

- Repository: https://github.com/frappe/education
- Default branch observed: `develop`
- Repository is public and not archived at time of review.
- README lists student/teacher management, admissions, attendance, fee management, course scheduling, exam planning, and a student portal.
- License file inspected: GNU GPL v3.

**Potential EduOS value**
- Admissions and enrollment workflow comparisons.
- Fee and billing process patterns.
- Scheduling and academic administration workflow references.

**Recommended disposition:** **Workflow and data-model reference; do not deploy as a second SIS.**

**Integration shape:** Map useful workflows to existing EduOS services and forms. If a district has an existing Frappe deployment, consider a governed connector with explicit field mappings and source-of-truth rules.

**Risks / checks**
- GPL v3 obligations require legal review before copying or creating derivative code.
- ERPNext/Frappe framework dependencies would add a separate application stack.
- Duplicate student, attendance, fee, and course records would create reconciliation risk.

### 5. RosarioSIS — student information system

- Repository: https://github.com/francoisjacquet/rosariosis
- Default branch observed: `mobile`
- Repository is public and not archived at time of review.
- README describes student information, employee records, gradebook, attendance, scheduling, courses, calendar, discipline, billing, and reporting.
- License file inspected: GNU GPL v2.

**Potential EduOS value**
- SIS workflow and data-model comparisons.
- Scheduling, attendance, gradebook, and transcript edge cases.
- Reporting and administrative usability patterns.

**Recommended disposition:** **Workflow reference and interoperability candidate only.**

**Integration shape:** Compare its workflows to EduOS's current SIS and gradebook implementation. If interoperability is required, use a controlled import/export adapter with field-level provenance and district approval. Do not sync grades or student records bidirectionally by default.

**Risks / checks**
- GPL v2 obligations require legal review before copying or creating derivative code.
- The repository's default branch is named `mobile`; review branch/release practices and maintenance activity before considering production dependency.
- Avoid competing gradebooks, attendance sources, or transcript authorities.

### 6. Koha — integrated library system

- Repository: https://github.com/Koha-Community/Koha
- Default branch observed: `main`
- Repository is public and not archived at time of review.
- README describes a free software integrated library system.
- License file inspected: GNU GPL v3.

**Potential EduOS value**
- Cataloging and bibliographic records.
- Circulation, holds, patron workflows, and library inventory.
- Interoperability patterns for districts with existing Koha installations.

**Recommended disposition:** **Conditional integration candidate.**

**Integration shape:** First compare Koha against EduOS's existing library circulation workflows. Where a district already operates Koha, prefer a district-approved connector and clear patron identity mapping over replacing it.

**Risks / checks**
- GPL v3 obligations require legal review before code reuse.
- Patron privacy, borrowing history, and student identity scopes must be explicitly minimized.
- Koha's README states that it does not accept pull requests from Git hosting sites; plan upstream contributions through its documented process.

### 7. Snipe-IT — asset management

- Repository: https://github.com/grokability/snipe-it
- Default branch observed: `master`
- Repository is public and not archived at time of review.
- README describes web-based IT asset management, including assignment and inventory tracking.
- License file inspected: GNU AGPL v3.

**Potential EduOS value**
- Device and equipment inventory.
- Asset assignment and lifecycle tracking.
- Useful workflows for school IT inventory.

**Recommended disposition:** **Use as a workflow reference first; separate service only after legal/security review.**

**Integration shape:** Evaluate an asset-register capability in EduOS Facilities/IT. If using Snipe-IT as an external service, use district-controlled deployment and a narrowly scoped integration. Keep asset records separate from student records unless a documented business need exists.

**Risks / checks**
- AGPL v3 has network-use source availability requirements that require legal review.
- Snipe-IT is oriented toward IT assets; it is not automatically a full facilities work-order, inspection, or preventive-maintenance system.
- Do not allow asset inventory permissions to imply student-record access.

### 8. Jitsi Meet — video and collaboration

- Repository: https://github.com/jitsi/jitsi-meet
- Default branch observed: `master`
- Repository is public and not archived at time of review.
- README describes open-source browser and mobile video conferencing, SDKs, content sharing, chat, polls, and self-hosting.
- License file inspected: Apache License 2.0.

**Potential EduOS value**
- Video calls and family conferences.
- Staff collaboration and remote meetings.
- SDK-based meeting embedding.

**Recommended disposition:** **Compare with BigBlueButton; do not implement both initially.**

**Integration shape:** Use EduOS-issued short-lived meeting tokens and scoped meeting metadata. Require district controls for recording, guest access, moderation, and retention.

**Risks / checks**
- Decide whether EduOS needs a teaching-first virtual classroom (BigBlueButton) or a lighter meeting layer (Jitsi), or both for distinct use cases.
- Confirm deployment, moderation, recording, accessibility, and data residency requirements.
- Validate all bundled component licenses, not only the top-level license.

## License and adoption posture

| Project | License evidence observed | Initial posture |
|---|---|---|
| Kolibri | MIT | Low-friction review; still audit dependencies and content rights |
| Frappe Education | GPL v3 | Legal review before code reuse |
| RosarioSIS | GPL v2 | Legal review before code reuse |
| Koha | GPL v3 | Legal review before code reuse |
| Snipe-IT | AGPL v3 | Elevated legal review, especially for hosted modifications |
| Jitsi Meet | Apache 2.0 | Review notices, dependencies, and bundled components |
| Keycloak | Not confirmed in inspected path | Verify before adoption |
| BigBlueButton | Not confirmed in inspected path | Verify before adoption |

This is an initial repository-level screen, not a legal opinion or a complete software bill of materials. Transitive dependencies, fonts, icons, media, plugins, container images, and bundled services can carry separate terms.

## Cross-cutting technical gates

Before any external capability is approved:

1. **Architecture:** document whether the candidate is a library, embedded client, API integration, or separately deployed service. Prefer API/service boundaries for large independent platforms.
2. **Authority:** name the authoritative owner for identity, student, guardian, enrollment, course, grade, attendance, library, asset, and meeting records.
3. **Authorization:** enforce EduOS district and school scope server-side. Never trust a client-provided role, school, district, or student identifier.
4. **Data minimization:** default to no student data. Approve only named fields, purposes, retention, and recipients.
5. **Consent and privacy:** apply consent and withdrawal at access/delivery time for media and recordings.
6. **Security:** threat model service credentials, webhooks, token lifetimes, secrets, network boundaries, logs, and incident response.
7. **Database:** preserve forced RLS, non-owner runtime roles, and least-privilege grants. External services must not connect directly to EduOS production databases.
8. **Offline:** define sync direction, idempotency keys, conflict handling, replay protection, retention, and recovery for EDEN.
9. **Operations:** establish SLOs, monitoring, backups, restore tests, upgrade policy, capacity, support ownership, and vendor/community dependency risk.
10. **Accessibility:** validate keyboard, screen-reader, captions, language, and assistive-technology workflows.
11. **Licensing:** complete legal review and generate an SBOM before code reuse or production deployment.
12. **Exit plan:** document export formats, data deletion, migration, and service replacement before onboarding a district.

## Proposed work packages

| ID | Work package | Priority | Exit evidence |
|---|---|---:|---|
| OSS-01 | Kolibri architecture spike against EDEN and NOMAD capability plan | P1 | Local content demo, sync contract, privacy/threat review |
| OSS-02 | BigBlueButton virtual classroom integration spike | P1 | Scoped meeting lifecycle, recording consent/retention design |
| OSS-03 | Keycloak identity/federation architecture comparison | P1 | Current-vs-proposed identity diagram, migration/rollback analysis |
| OSS-04 | Frappe Education and RosarioSIS workflow gap matrix | P2 | EduOS-native workflow backlog; no duplicate SIS |
| OSS-05 | Koha library interoperability assessment | P2 | Library capability gap and connector contract |
| OSS-06 | Snipe-IT vs native EduOS asset register assessment | P2 | License review and asset-domain boundary |
| OSS-07 | Jitsi vs BigBlueButton decision | P2 | Use-case split or documented single-platform selection |
| OSS-08 | License, SBOM, and dependency security review for selected candidates | P0 before adoption | Legal signoff, SBOM, vulnerability report |

## Recommended sequence

1. Complete OSS-08 for the candidates selected for hands-on evaluation.
2. Run OSS-01 and OSS-02 as isolated proof-of-concept environments with synthetic data only.
3. Complete OSS-03 before changing identity or federation architecture.
4. Use OSS-04 through OSS-07 to create a gap-driven backlog, not a parallel product stack.
5. Submit each approved integration as its own implementation PR with threat model, data-flow diagram, test evidence, rollback, and district controls.

## Explicit exclusions

- No external repository code is copied into EduOS by this research PR.
- No external service is enabled in production by this research PR.
- No external provider receives unrestricted student data.
- No external system becomes the source of truth for EduOS student identity, grades, attendance, school membership, or district authorization.
- No GPS or device-location tracking is introduced into bus-driver workflows.
- No clinical nurse/Health Office functionality is introduced by this research.
- No compliance certification or legal conclusion is asserted.

## Evidence and limitations

Repository names, default branches, public/non-archived status, README feature descriptions, and the license files noted above were checked through GitHub repository metadata and repository files on 2026-11-27. This pass did not clone/build the projects, run their tests, inspect all transitive dependencies, verify release cadence in depth, or perform a security audit. Items marked unconfirmed must be verified before any adoption decision.


### 9. text-to-cad — AI-assisted engineering, fabrication, and robotics

- Repository: https://github.com/earthtojake/text-to-cad
- Default branch observed: `main`; public and not archived at review time.
- Repository metadata reported approximately 27,675 stars and 2,649 forks at review time; these are popularity signals, not security or quality evidence.
- README describes an agent-oriented local engineering toolkit for mechanical CAD, PCB design, manufacturing checks, finite-element stress studies, engineering drawings, rendering, fabrication workflows, and robotics simulation.
- License metadata and repository badge identify MIT. The top-level README says the project is MIT-licensed.
- Main technologies and formats described include Python, build123d, OpenCASCADE, KiCad, CalculiX, Netgen, Blender, MuJoCo, URDF, SRDF, MJCF, STEP, STL, 3MF, GLB, and DXF.

**Potential EduOS value**
- A strong foundation for a supervised **STEM / CTE Engineering and Maker Lab** capability.
- Student projects in mechanical design, parametric modeling, assemblies, mechanisms, and 2D fabrication profiles.
- PCB schematic/board design, electronics prototyping, and fabrication preparation.
- Engineering drawing generation and introductory design-for-manufacturing workflows.
- Guided stress-analysis and robotics simulation activities.
- Exportable student project artifacts and portfolio evidence, subject to district ownership, retention, and consent policies.

**Recommended disposition:** **High-value candidate for a tightly isolated, supervised engineering-lab proof of concept. Do not deploy its local server as a shared multi-tenant EduOS service.**

**Integration shape**
- Begin with a district-managed engineering workstation or isolated lab runner using synthetic projects and no production student records.
- EduOS should own course enrollment, assignment instructions, user authorization, teacher review, project metadata, and portfolio publication approvals.
- Treat the CAD engine as an execution tool in a separately isolated environment. Exchange only explicitly approved project artifacts and status metadata through a narrow integration API or controlled file handoff.
- Keep project files private to the authorized learner/team and instructor. Require teacher approval before publishing artifacts to student portfolios, shared galleries, or external fabrication services.
- Use separate resource quotas, timeouts, storage limits, network egress policy, malware scanning, and retention/deletion controls for every project.
- Treat generated models, scripts, imported CAD/PCB files, meshes, and fabrication exports as untrusted content. Validate file type, size, parser behavior, and export contents before storage or sharing.
- Require human review before any physical fabrication, electrical energizing, robotics actuation, or use of a design in a safety-critical context.

**Security findings from the repository's own SECURITY.md**
- The project describes itself as a local development tool; its server, viewer, and model execution run with the local user's rights and files.
- The security document explicitly warns that a script's worker runs with the interpreter used to launch it, and dependencies declared by scripts may be installed with network access.
- An agent sandbox that can reach the CAD server's local communication endpoint can cause work to execute with the server's own rights, outside the agent sandbox. Therefore, the agent sandbox alone is not a sufficient isolation boundary.
- The viewer's token, session cookie, or signed link grants broad access to local CAD files and viewer actions. Links and credentials must never be shared across learners or embedded in broadly accessible EduOS records.
- The project documents a local HTTP viewer/MCP endpoint and credential controls, but those controls are designed for a user's own machine—not EduOS district tenancy, learner-level authorization, or hostile multi-tenant workloads.
- The README states that usage statistics and crash reports are sent by default with a random identifier and without files, paths, or prompts; review the privacy policy and provide an approved opt-out/configuration posture for school deployments.
- Imported CAD, PCB, and robot-description files are treated as untrusted input by the project and processed with bounds; EduOS must independently validate the exact pinned version and deployment configuration.

**Risks / checks**
- A local workstation's user boundary is not equivalent to per-student process, filesystem, network, and kernel isolation.
- Never run learner-supplied scripts under a shared service account that can read other learners' projects, teacher materials, district files, secrets, or host credentials.
- Do not expose the CAD viewer token, MCP capability, local server port, or raw project filesystem to browser clients or other tenants.
- Verify whether the intended lab workflow can operate with network egress disabled or tightly allowlisted; dependency installation and fabrication-service integrations need explicit controls.
- Review all transitive dependencies, container/base images, downloaded tools, model assets, and fabrication providers; MIT at the repository root does not establish the license of every dependency or user-supplied asset.
- Validate accessibility, Chromebook/browser compatibility, managed-device requirements, CPU/GPU/RAM needs, and support for district-approved operating systems.
- Treat FEA outputs as educational analysis, not professional engineering certification or proof of safety. PCB ERC/DRC and manufacturing checks are not guarantees that a design is electrically or mechanically safe.
- The PCB workflow documentation notes that its fetched KiCad CLI is a nightly 10.99 build; validate file compatibility before students edit projects intended for stable KiCad installations.
- Require teacher supervision and age-appropriate controls for fabrication tools, sharp/hot equipment, batteries, electrical circuits, and robotics.

## EduOS work package addition

| ID | Work package | Priority | Exit evidence |
|---|---|---:|---|
| OSS-09 | text-to-cad supervised STEM/CTE lab proof-of-concept and isolation assessment | P1 | Synthetic-data demo; threat model; per-learner isolation test; teacher approval workflow; artifact scanning and retention plan; human fabrication safety gate |

**Suggested pilot sequence**
1. Use a district-controlled, single-purpose lab workstation or disposable isolated runner; do not connect it to production EduOS databases.
2. Demonstrate a basic parametric part, an assembly, a dimensioned drawing, and a simple robotics simulation with synthetic project data.
3. Verify that two learner sessions cannot read, modify, enumerate, or export each other's files, credentials, viewer sessions, or outputs.
4. Test malicious or malformed imported CAD/PCB files, runaway scripts, dependency installation, resource exhaustion, and attempted network access.
5. Add EduOS assignment/project metadata and teacher review only after isolation is demonstrated.
6. Keep PCB fabrication, CNC/laser cutting, 3D printing, and physical robotics actuation disabled until separate district safety and supervision approvals are documented.

