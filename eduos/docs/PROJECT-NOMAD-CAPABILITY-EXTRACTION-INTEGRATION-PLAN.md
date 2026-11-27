# Project NOMAD Capability Extraction — EduOS Integration Plan

**Status:** Planning proposal, audited 2026-11-27 against the repository and the NOMAD source (corrections in §13; Phase 0 inventory in §14; work items in §15)  
**Source reviewed:** https://github.com/Crosstalk-Solutions/project-nomad  
**Target repository:** `topking80/EDUOS-REPO-001`  
**Implementation principle:** Extract useful capabilities and patterns; implement them natively in EduOS. Project NOMAD is a reference, not a runtime dependency.

## 1. Executive decision

Do not embed, deploy, fork, or directly connect the NOMAD application as a second platform inside EduOS. Do not create a separate student identity, course-progress, document-storage, authorization, or AI policy system.

Instead, build an **EduOS Learning Resource and Offline Knowledge Hub** on top of existing EduOS services:

- District and school governance, authenticated sessions, role permissions, and PostgreSQL RLS.
- Existing Learning services for courses, lessons, assignments, standards, mastery, and feedback.
- Existing EDEN school-node architecture for signed content bundles, local caching, offline operation, and controlled synchronization.
- Existing media/storage registration, scanning, consent, and delivery pipeline.
- Existing school safety and emergency-readiness capabilities (`src/safety-*.js`). EduOS has **no map module** today (see §13); offline maps are new work.
- Existing district library services (`library_items`, loans, reservations, resource requests, catalog imports) and AI gateway with egress controls (`src/ai/`).

NOMAD is useful as a catalogue of capabilities and operational patterns. Its current README explicitly describes the management UI as unauthenticated and warns against direct internet exposure. Its Compose deployment grants the management service access to the host Docker socket. Those choices are not suitable authorization or execution boundaries for a multi-tenant K–12 platform.

## 2. Capability extraction and disposition

| NOMAD capability / pattern | EduOS target | Disposition | Notes |
|---|---|---|---|
| Kiwix / ZIM offline information library | Offline Reference Library | Adopt capability; reimplement management | Store source, license, language, age range, subject, version, checksum, and content metadata. Serve vetted offline packages through EduOS. |
| Curated content collections and setup wizard | District Resource Catalog | Adopt | District approves collections; schools choose from approved catalog; age/grade and accessibility metadata required. |
| Kolibri learning platform and channels | Learning Content Import and Delivery | Adapt | Reuse course, lesson, assignment, standards, and mastery records in EduOS. Import/launch approved content without a parallel gradebook or student identity. |
| Local AI chat and RAG over uploaded documents | EduOS Knowledge Assistant | Adapt with strict controls | District-controlled model/provider policy; scoped retrieval; citations; no external model egress by default; never index student records or private documents without explicit purpose and authorization. |
| Offline maps / regional map packages | New: offline map packages | Build (no existing map stack) | EduOS has no maps module to extend. Build one governed map-package type on the Phase 1 provisioning path; OpenStreetMap-derived data carries ODbL attribution and share-alike duties. |
| Download manager, job status, retries, content updates | Content Provisioning Service | Adopt patterns | Idempotent jobs, resumable downloads, checksums, storage quotas, version pinning, rollback, operator visibility. |
| FlatNotes / local notes | Student Portfolio and Teacher Workspace | Adapt | Use existing portfolio/time-capsule and teacher workflows; preserve ownership, approval, retention, and consent controls. |
| Hardware benchmark and system health | EDEN Node Health / Capacity Dashboard | Extend | Use measured health, storage, memory, temperature, service status, and capacity alerts; avoid public hardware leaderboards for school infrastructure. |
| Supply Depot / custom Docker app catalog | Governed EduOS Integration Catalog | Redesign | No arbitrary containers or student-facing Docker control. District-reviewed integrations only, with data scopes, licensing, security review, approvals, and disable/rollback. |
| Emergency and medical reference packs | School Emergency Resource Library | Adopt with content review | Separate emergency operational procedures from general medical information; district-approved, versioned, offline access. |
| Offline-first / local-first operating model | EDEN | Reuse existing architecture | Extend signed bundle and cache model; do not create another synchronization protocol. |

## 3. EduOS product experience

Create one coherent **Learning Resources** destination with role-aware views:

### District administrators
- Approve, publish, version, and retire resource collections.
- Set permitted subjects, grades, languages, schools, storage budgets, and download windows.
- Set AI availability, model/provider policy, retention, and permitted knowledge sources.
- View content freshness, usage aggregates, storage consumption, node distribution, and failed updates.
- Approve external content sources and integrations after licensing, privacy, and security review.

### School administrators and librarians
- Select district-approved collections for their school.
- Pin curriculum-aligned collections and local resources.
- Schedule downloads to the school node and view readiness/offline status.
- Request new resources from the district.
- Manage school-local emergency reference packs within district policy.

### Teachers
- Find resources by subject, grade, standard, language, format, and accessibility.
- Attach approved resources to existing courses, lessons, and assignments.
- Assign a reading, video, practice activity, or offline learning pack using existing EduOS assignment workflows.
- Use approved teacher-only knowledge collections for lesson preparation.
- See resource availability at their school, including offline readiness.

### Students
- Browse only age-appropriate and school-approved materials.
- Open resources from courses and the student app.
- Continue reading and viewing already-synchronized resources during supported outages.
- Keep learning progress in EduOS, not in a shadow LMS.
- Use an approved learning assistant only where district and age policies permit.

### Parents and guardians
- View resources explicitly shared through the child's course or school.
- Access homeschool/private-school resource collections only within the applicable school/program and guardian permissions.
- No default access to private teacher knowledge bases, staff notes, or other students' activity.

## 4. Target architecture

```text
District Resource Governance
  |-- catalog, licensing, age/grade policy, AI policy, quotas
  v
EduOS Learning Resources
  |-- metadata, search, assignments, access decisions
  |-- content provisioning jobs and integrity checks
  |-- approved knowledge retrieval and citations
  v
Existing EduOS foundations
  |-- authenticated actor + permission registry
  |-- district_id / school_id + PostgreSQL RLS
  |-- Learning service + portfolio
  |-- registered media/storage pipeline
  |-- EDEN signed bundles, node cache, egress gate
  v
School node / approved devices
  |-- verified offline reference packages
  |-- approved learning resources
  |-- scoped local search where enabled
```

### Architectural rules

1. EduOS remains the system of record for identities, enrollments, courses, assignments, grades, mastery, consent, and audit.
2. Resource metadata is tenant-scoped and school-scoped where applicable. Every resource read, download, search result, attachment, and background job is authorized server-side.
3. Binary packages live in approved object/file storage or the existing school-node content store. PostgreSQL stores metadata, license records, checksums, versions, access policy, and opaque object references.
4. Offline distribution uses EDEN's signed, versioned bundle mechanism **for manifests**. Nodes verify signatures, pinned trust root, version monotonicity, checksums, school assignment, and revocations before activation. EDEN bundles today are JSON documents stored in PostgreSQL (`eden_bundles.bundle jsonb`, 16 MB request limit), so large packages (ZIM archives, video) travel as separate content-addressed files named by SHA-256 in a signed `content` manifest, not inside the bundle.
5. Do not cache private student records or broaden the existing phone offline queue. Offline reference packages are public-to-the-authorized-school resources, not student-specific records.
6. Search results must be filtered by authorization before content snippets are returned. Retrieval is not a bypass around RLS or resource permissions.
7. No arbitrary Docker deployment, host Docker socket exposure, unaudited plugin execution, or direct vendor access to student data.

## 5. Workstreams and phased roadmap

### Phase 0 — Baseline, inventory, and policy (planning gate)

- Map current EduOS resource/library, file, media, maps, learning, EDEN, app catalog, AI, and storage capabilities.
- Inventory NOMAD content formats and upstream dependencies: ZIM/Kiwix, Kolibri channels, maps, local inference, vector search, and downloadable collections.
- Produce a source/license matrix for every proposed content type and upstream package.
- Define district policy for age bands, grade ranges, accessibility, language, retention, AI use, content review, and school storage quotas.
- Define explicit boundaries for student data, teacher-only data, staff data, and public/approved reference content.

**Exit:** approved architecture decision record, data-flow map, content license matrix, and security threat model.

### Phase 1 — Resource catalog and offline reference library (MVP)

- Add tenant-aware resource catalog metadata and collection management.
- Support curated resource types: HTML/static reference, PDF/ebook, ZIM-compatible offline collection, image/audio/video only through approved media pipeline, and map package references.
- Add district approval, school selection, publication, versioning, retirement, and audit history.
- Add content integrity verification (SHA-256), source attribution, license, language, age/grade, subject, standards mapping, file size, and update date.
- Build provisioning jobs with resumable download, retries, idempotency, cancellation, quota checks, and disk-space preflight.
- Deliver approved resource bundles through EDEN to assigned school nodes.
- Build student/teacher/librarian browse, search, and resource detail screens.

**Exit:** approved content can be provisioned, verified, distributed to a school node, browsed under correct permissions, and used during WAN outage. No student data is included in resource bundles.

### Phase 2 — Curriculum integration and learning content import

- Build an import adapter for approved Kolibri channel/content formats and other licensed open educational content.
- Map imported material to EduOS subjects, grade levels, standards, courses, lessons, and resource attachments.
- Use EduOS course enrollment, assignments, submissions, mastery, and gradebook as the authoritative learning record.
- Where an upstream format exposes completion/progress, map only supported learning events into EduOS after validating identity, attribution, idempotency, and source provenance.
- Provide teacher preview, curriculum alignment, and assignment creation.
- Support homeschool/private-school program configuration without creating a separate learning platform.

**Exit:** teachers can assign approved imported resources through EduOS; student progress is visible through existing EduOS learning screens; no duplicate gradebook exists.

### Phase 3 — Local knowledge search and AI assistant

- Start with keyword/full-text search over approved, non-sensitive resource collections.
- Add optional semantic retrieval only after tenant, school, collection, and document-level authorization filters are enforced.
- Build a district-managed knowledge-source registry with owner, purpose, sensitivity, retention, allowed roles, and indexing state.
- Add local model provider support behind a provider-neutral EduOS service interface.
- Enforce prompt and retrieval policies, source citations, age-appropriate response rules, rate limits, audit controls, and safe fallback when model hardware is unavailable.
- Default external AI egress to disabled. If a district enables a remote provider, require explicit policy approval, documented data categories, redaction, and an auditable configuration.
- Exclude student records, private guardian documents, grades, health/safety records, and staff-only material from general-purpose indexing by default.

**Exit:** an authorized user can ask a question over an explicitly approved collection and receive grounded answers with source citations; unauthorized content cannot be retrieved through prompts, search, or embeddings.

### Phase 4 — Offline maps, emergency resources, and resilience

- Build an offline map package type (no map workflow exists today) for school, district, and curriculum use, reusing the Phase 1 provisioning and EDEN manifest path.
- Create versioned emergency reference collections with named district owners and review/expiry dates.
- Include approved evacuation maps, emergency procedures, contact protocols, and continuity instructions.
- Add node capacity preflight, content freshness, failed bundle alerts, checksum failures, and storage pressure reporting.
- Test disconnected school operation, interrupted downloads, corrupt/tampered packages, revocation, disk-full conditions, and recovery.
- Keep emergency procedures separate from general student-facing content and restrict operational details to authorized roles.

**Exit:** approved offline map and emergency packages remain available through a WAN outage and update safely after connectivity returns.

### Phase 5 — Governance, integrations, and scale

- Add a district-reviewed integration catalog for approved content providers and tools.
- Require vendor/privacy/security review, license validation, declared data scopes, district approval, school assignment, audit, revocation, and removal workflow.
- Add storage consumption reporting and district-configurable quotas by school/resource type; do not silently expand per-student media limits.
- Add accessibility and multilingual content validation, quality review, stale-content alerts, and operational dashboards.
- Pilot on representative school hardware before claiming hardware compatibility or production readiness.

**Exit:** districts can operate the service across schools with controlled costs, revocation, audit, disaster recovery, and measured capacity.

## 6. Data model proposal (to validate against existing schemas before migration)

Prefer reusing existing catalog, content, media, and learning tables where they already meet the requirements. Do not create duplicate concepts without an inventory first.

Potential new entities only if no existing equivalent exists:

- `learning_resources`: tenant/school scope, title, description, type, source, license, language, grade/age band, subject, standards metadata, sensitivity, status, checksum, version, storage reference, created/approved/published timestamps.
- `learning_resource_collections`: governed named collections, owner, policy, publication state, review date.
- `learning_resource_collection_items`: ordered resource membership and version pin.
- `learning_resource_assignments`: link from existing assignment/course/lesson to resource version; not a second assignment system.
- `learning_resource_node_deployments`: node, resource/version, desired state, verified state, last sync, error state.
- `learning_resource_audit`: append-only approval, publication, access-policy, retirement, and distribution events.
- `knowledge_sources`: approved indexable source, purpose, sensitivity, allowed roles, retention, owner, indexing policy.
- `knowledge_index_jobs`: idempotent indexing lifecycle, source version, checksum, status, and failure reason.

All tenant-owned tables require district scope, school scope where relevant, enabled and forced RLS, deny-by-default policies, and least-privilege runtime grants. Join tables and worker paths require equivalent enforcement. Exact schema names and relationships are subject to the Phase 0 inventory.

## 7. Security, privacy, and content governance gates

- Preserve authenticated server-side actor context; never trust client-supplied district, school, role, owner, or learner identifiers.
- Apply permission checks to browse, search, snippets, downloads, assignments, indexing, exports, and workers.
- Test district isolation, school isolation, role matrix, IDOR, guardian relationship revocation, staff assignment revocation, and stale sessions.
- Keep third-party integrations at zero student-data scope by default.
- Do not send student PII or education records to an external AI provider by default.
- Require malware scanning and file-type validation before content activation; fail closed when scanning or processing is unavailable.
- Verify source licensing and redistribution rights for every downloadable collection. NOMAD's Apache-2.0 repository license does not grant rights to all third-party apps, models, courses, books, maps, or content packs it can install.
- Enforce consent and authorization at read/delivery time, not only upload time.
- Keep content provenance, version, checksum, license, reviewer, and review date.
- Maintain audit trails for privileged access, policy changes, publication, indexing, download, revocation, and retirement.
- Do not use resource search or AI as a path to expose student profiles, grades, health records, discipline records, private messages, or confidential staff information.

## 8. Performance, storage, and operational design

- Use district-managed storage budgets and school-level quotas; report projected and actual package sizes before deployment.
- Support selective downloads by school, grade band, subject, language, and curriculum rather than pushing every package to every node.
- Use resumable transfers, bounded retries, exponential backoff, checksums, and atomic activation.
- Retain the last known-good content bundle when an update fails; do not replace verified content with partial downloads.
- Track storage, CPU, memory, indexing queue, node connectivity, package freshness, and failure rates.
- Separate resource-content storage from student multimedia quotas and existing student-history retention policy.
- Provide backup, restore, migration, content revocation, and node replacement procedures.

## 9. Test and acceptance matrix

Every phase PR must include relevant tests:

1. **Tenant and school security:** cross-district and cross-school reads, writes, search, snippets, downloads, and worker execution denied.
2. **Role authorization:** district, principal, librarian, teacher, pupil, guardian, and IT admin permission matrix.
3. **Content provenance:** invalid license state, missing source, stale review, checksum mismatch, unsupported file, and malware scan failure.
4. **Provisioning:** retry, resume, cancellation, duplicate job, interrupted download, disk full, corrupted package, atomic activation, rollback.
5. **EDEN distribution:** valid signature accepted; tampered, unsigned, wrong-school, revoked, or rollback bundle refused.
6. **Offline operation:** previously provisioned approved resource remains accessible without WAN; private API data is not cached as a side effect.
7. **Learning integration:** assignment, resource version pin, student completion, teacher feedback, and mastery remain consistent in EduOS.
8. **AI and search:** unauthorized collection retrieval blocked before snippet/vector return; prompt injection in source documents treated as untrusted content; citations resolve to authorized source versions.
9. **Accessibility:** keyboard, screen reader, contrast, captions/transcripts, responsive web, and Flutter journeys.
10. **Operations:** restore, node replacement, key revocation, package retirement, storage quotas, and audit completeness.

Database enforcement claims must be tested against PostgreSQL with a non-owner runtime role and RLS enabled/forced. Distinguish unit-tested, integration-tested, simulated, and hardware-verified results.

## 10. Delivery sequencing and PR strategy

Use small PRs from `main`, each with one bounded purpose:

1. **Plan / architecture ADR** — this document, inventory, source/licensing matrix, threat model.
2. **Resource catalog foundation** — schema, RLS, permissions, audit, API tests.
3. **District resource governance UI/API** — approve, publish, retire, policy controls.
4. **Offline resource provisioning** — jobs, checksum, quotas, storage, retry and rollback.
5. **EDEN content bundle delivery** — signed distribution and node verification.
6. **Resource Library experience** — district/school/teacher/student role views.
7. **Learning content import** — Kolibri/open content adapter and EduOS assignment links.
8. **Knowledge search** — authorized full-text search, followed by semantic retrieval.
9. **Local AI assistant** — only after search security and district policy gates pass.
10. **Maps and emergency packs** — new map package type on the Phase 1 provisioning path; emergency packs alongside existing safety features.
11. **Integration catalog and operational scale** — governed connectors, dashboards, pilot.

Keep PRs draft until automated tests, security review, and required PostgreSQL integration checks pass. Do not merge phases that depend on unimplemented security boundaries.

## 11. Explicit non-goals

- No NOMAD source-code merge or long-lived fork.
- No requirement to install or run NOMAD to use EduOS features.
- No second LMS, student account system, gradebook, assignment database, or portfolio.
- No direct Docker socket access from EduOS application services.
- No arbitrary third-party container execution.
- No automatic import of every NOMAD collection or model.
- No default external AI calls or student-data egress.
- No claim of Raspberry Pi or other edge hardware support without a measured pilot.

## 12. First implementation recommendation

Begin with **Phase 0 followed by Phase 1**. The first shippable product should be the district-governed Offline Reference Library, distributed through EDEN and surfaced in the student, teacher, librarian, and administrator experiences. This delivers immediate value without introducing AI risk or duplicating the learning platform.

After the resource catalog and offline delivery are proven, add curriculum import. Add AI last, because retrieval authorization, source governance, age policy, and data egress must be solved first.

## 13. Audit (2026-11-27)

Checked against the repository at the merge of PR #214 and against the NOMAD source.

### Confirmed

- NOMAD's README states it "includes no authentication" and isn't designed for direct internet exposure; its
  licence is Apache-2.0.
- `install/management_compose.yaml` mounts `/var/run/docker.sock` into the admin service (and two others). The
  plan's refusal to copy that execution model stands.
- The NOMAD references in "Source references" exist (`admin/docs/use-cases.md`, `admin/constants/service_names.ts`),
  as do the five EduOS documents and `src/learning-service.js`.
- The governance gates in §7, the test matrix in §9 and the non-goals in §11 match EduOS's existing rules
  (forced RLS, non-owner runtime role, no vendor student-data scope by default, no automatic transfers).

### Corrected in this document

1. **Maps.** The plan said to extend "existing EduOS Maps". There is no map module (only weather/NWS alerts). §1, §2,
   Phase 4 and §10 now treat offline maps as new work.
2. **EDEN can't carry the packages.** EDEN bundles are signed JSON stored in PostgreSQL with a 16 MB request limit.
   ZIM archives and media run to gigabytes. Rule 4 now separates the signed manifest (EDEN) from content-addressed
   file transfer verified by SHA-256 on the node.

### To carry into implementation

3. **Library overlap.** EduOS already has a physical library module (`library_items`, `library_loans`,
   `library_reservations`, `library_resource_requests`, `library_catalog_imports`, library intelligence routes)
   and a `librarian` role (migration 024), plus teacher-owned `teacher_library_items`. The resource catalog must
   sit beside these under one Library destination, reuse the librarian role and resource-request workflow, and
   not create a second "library".
4. **AI already has a gateway and egress policy.** `src/ai/providers.js`, `src/ai/provider-egress.js`,
   `ai_district_policy`, `ai_usage` and `docs/AI-PROVIDER-EGRESS.md` already keep external AI off by default with a
   host allowlist and redaction. Phase 3 extends these, not a new provider interface.
5. **Integration catalog exists.** `apps`, `app_requests`, `app_licenses`, `app_assignments` and the LTI marketplace
   (`docs/MARKETPLACE.md`) are the district-reviewed catalog. Phase 5 extends them.
6. **Tenancy has changed.** Since HSP-00 (`docs/product/hsp-00-architecture-and-tenancy.md`) a tenant is a district,
   a homeschool family or a private school; the latter two have no `district_id`. Resource tables need the tenant
   model, or must state that phase 1 is district-only. Homeschool reading lists (`family_reading`, HSP-07 part 2)
   should be able to point at catalog resources later.
7. **Kolibri.** Kolibri keeps its own accounts and progress. Import channel *content* without running Kolibri
   or its accounts, and record progress only through EduOS assignments, consistent with §11.
8. **Licences differ by package, and some restrict use.** Upstream terms as published (to verify per package
   before distribution): Wikipedia text CC BY-SA; Khan Academy content CC BY-NC-SA (non-commercial); OpenStreetMap
   data ODbL (attribution, share-alike). The licence matrix in §14 tracks this.
9. **Scanning very large archives.** The media pipeline (`src/media-pipeline*.js`) scans uploads. Multi-gigabyte
   archives need a size-aware scan or a trusted-source checksum policy, decided in Phase 1.

## 14. Phase 0 inventory

| Need in this plan | What EduOS has | Gap |
|---|---|---|
| Governed resource catalog | Physical library catalog (`library_items`), teacher library items, lesson sources (`lesson_sources`) | Digital/offline resource records with licence, checksum, version, age band |
| Collection approval and publication | District policy bundles (`district_policy_bundles`), app approval workflow | Collection lifecycle (draft, approved, published, retired) |
| Offline distribution | EDEN nodes, signed bundles (`eden_bundles`, `eden_node_bundles`, `eden_bundle_cache`), egress gate | Large-file transfer and node-side verification/activation |
| File storage and scanning | Private media objects and pipeline (`private_media_objects`, `src/media-pipeline*.js`) | Resource-content store separate from student media quotas |
| Assignments and progress | Learning service: courses, units, lessons, assignments, mastery | Resource-version links on lessons and assignments |
| Search | None beyond per-module filters | Authorized full-text search |
| AI | Staff AI gateway, district AI policy, egress allowlist, usage log | Retrieval over approved collections with authorization filters |
| Maps | None | Map package type |
| Emergency readiness | Safety incidents, reunification, room safety, weather alerts | Versioned offline emergency reference packs |
| Integration catalog | Apps, requests, licences, LTI marketplace | Content-provider entries |
| Non-district tenants | Homeschool families and private schools (HSP-00 to HSP-07) | Decide whether phase 1 serves them |

**Licence matrix (to verify per package before any distribution):**

| Content type | Typical upstream terms | Distribution concern | Status |
|---|---|---|---|
| Wikipedia (Kiwix ZIM) | CC BY-SA | Attribution, share-alike | To verify |
| Khan Academy (Kolibri channels) | CC BY-NC-SA | Non-commercial use only | To verify |
| Other Kiwix collections (medical, ebooks) | Varies by collection | Per-collection review | To verify |
| OpenStreetMap-derived maps (ProtoMaps) | ODbL | Attribution, share-alike for derived databases | To verify |
| Local AI models | Varies by model licence | Use restrictions, redistribution | To verify |

**Threat model (headline risks to design against in Phase 1):** a tampered or substituted package (signed
manifest plus SHA-256 per file); a resource visible outside its approved schools or age band (server-side checks
plus forced RLS); search or AI returning content the user can't open (filter before snippets); storage exhaustion
on a school node (quotas and preflight); licence breach through redistribution (licence state required before
publication); student data leaking into a package (packages hold approved reference content only).

## 15. Work items

| ID | Item | Depends on |
|---|---|---|
| LRH-00 | This audit and Phase 0 inventory (done; ADR approval and the licence review still needed) | — |
| LRH-01 | Resource catalog foundation: schema, forced RLS, permissions, audit, alongside the library module (built: migration 171, `docs/LEARNING-RESOURCES.md`) | LRH-00 |
| LRH-02 | District collection governance: approve, publish, retire, school selection, policy (approve, publish, retire and school selection arrived with LRH-01; the written district policy and collection review reminders remain) | LRH-01 |
| LRH-03 | Provisioning: jobs, checksums, quotas, resumable transfer, rollback | LRH-01 |
| LRH-04 | EDEN content manifests and node verification/activation | LRH-03 |
| LRH-05 | Library experience for district, school, librarian, teacher, student and guardian | LRH-02 |
| LRH-06 | Learning content import (open content, Kolibri channel content without Kolibri accounts) | LRH-05 |
| LRH-07 | Authorized full-text search | LRH-05 |
| LRH-08 | Retrieval-grounded assistant on the existing AI gateway | LRH-07 |
| LRH-09 | Offline map packages and emergency reference packs | LRH-04 |
| LRH-10 | Content-provider entries in the app catalog; operations dashboards; pilot | LRH-04 |

## Source references

- Project NOMAD repository and capability overview: https://github.com/Crosstalk-Solutions/project-nomad
- NOMAD use cases: https://github.com/Crosstalk-Solutions/project-nomad/blob/main/admin/docs/use-cases.md
- NOMAD service catalog: https://github.com/Crosstalk-Solutions/project-nomad/blob/main/admin/constants/service_names.ts
- EduOS school-node local-first readiness: `eduos/docs/reliability/school-node-local-first-readiness.md`
- EduOS district governance feature acceptance: `eduos/docs/security/district-governance-feature-acceptance.md`
- EduOS media storage controls: `eduos/docs/MEDIA-STORAGE.md`
- EduOS EDEN / offline architecture: `eduos/FIX-REPORT-32.7.0.md`
- EduOS learning service: `eduos/src/learning-service.js`
