# HSP-00 — Architecture and tenancy foundation (for review)

**Plan:** `docs/product/homeschool-private-school-hub-plan.md` (#207)
**Status:** design for review. HSP-00 is the gate before any HSP runtime work. This PR changes no code, schema or behavior.
**Decides:**
- the tenant-type model;
- the membership and learner-relationship model;
- the session and RLS mechanics;
- the policy matrix;
- the migration strategy;
- the API boundaries;
- the threat model;
- the test plan HSP-01 to HSP-07 must meet.

## 1. Where EduOS is today

Every tenant today is a **district**:
- `districts(id)` is the tenant.
- **268 tables** carry `district_id uuid NOT NULL REFERENCES districts`.
- **209 RLS policies** compare a row's `district_id` to `current_setting('app.district_id')`.
- A user's authority comes from `memberships(user_id, district_id, school_id, role)`. Roles are superintendent, principal, teacher, parent, pupil and the later role apps; IT administrator and others arrive through the role-app migrations.
- A session (`sessions`) pins one membership: `district_id` is `NOT NULL`, plus school and role. `POST /api/session/membership` switches by issuing a new session.
- `withTenantTransaction(actor)` sets `app.district_id`, `app.user_id`, `app.role`, `app.school_id` and `app.membership_role` for the transaction. Every tenant table has forced RLS, and the runtime role is neither owner nor `BYPASSRLS`.
- Learners are `students(district_id, school_id, …)`. Adults are linked to them by `student_user_links(district_id, user_id, student_id, relationship ∈ parent|guardian|pupil)`.
- Federation (FED-02 to FED-10) runs above this: Master Control's nodes are platform → state → district → school. Identifiable data never sits above a district.

The plan forbids two shortcuts: **putting family IDs in `district_id`**, and **treating a homeschool family as a district**.

## 2. Options considered

| | A. One generic `tenants` table; `district_id` becomes "tenant id" everywhere | B. Separate schema per tenant kind, copying the learning core | C. Tenant supertype; each kind its own subtype; shared tables gain `tenant_id` only when they are shared (recommended) |
|---|---|---|---|
| Overloads `district_id`? | Yes, which the plan forbids | No | No |
| Rework of the 268 district tables | All, at once | None, but duplicated features | Only the tables a later slice actually shares, one migration each |
| Risk to districts | High: every policy changes together | Low | Low: district tables change only when shared, with district rows backfilled first |
| Reuse of the learning core | Immediate | None (fork) | Table by table, behind tests |
| Federation fit (districts under states) | Muddied | Clean | Clean: districts stay districts |

**Recommendation: C.** It keeps districts exactly as they are for HSP-01 (which needs no district table at all) and HSP-03. Sharing the learning core with families and private schools (HSP-02, HSP-04) is done as explicit, separately reviewed migrations.

## 3. Tenant-type model

```
tenants(id uuid PK, kind text CHECK (kind IN ('district','private_school','homeschool_family')),
        status text CHECK (status IN ('active','suspended','closing','closed')), created_at, closed_at)

districts(id PK REFERENCES tenants(id))           -- unchanged otherwise; backfilled: one tenants row per district, kind='district'
private_schools(id PK REFERENCES tenants(id), …)   -- HSP-03
homeschool_families(id PK REFERENCES tenants(id), display_name, jurisdiction_ref, time_zone, …)   -- HSP-01
```

- **IDs are opaque UUIDs.** A family ID never appears in a `district_id` column. A tenant's kind never changes.
- `tenants` is a registry of kind and status. It holds no names, and no one but the owner role reads it across tenants.
- A trigger keeps `districts` and `tenants` consistent: inserting a district creates its `tenants` row, and a district's tenant row must be kind `district`.
- A private school's campuses are `private_school_campuses(private_school_id, id)` in HSP-03. They are not `schools`, and not a district's schools.
- **Federation:** Master Control keeps its four levels. A private school that takes part in a state program joins through an explicit agreement (the FED-06 pattern), never as a district node. Homeschool families are not federated in this plan.

## 4. Memberships and learner relationships

### Homeschool family (HSP-01)

```
family_memberships(id, family_id → homeschool_families, user_id → users,
                   role CHECK (role IN ('owner','co_educator','guardian_viewer','learner')),
                   status CHECK (status IN ('invited','active','revoked')),
                   invited_by, invited_at, accepted_at, revoked_by, revoked_at, revoke_reason,
                   UNIQUE (family_id, user_id))
family_learners(id, family_id, display_name, birth_year NULL, grade_band, status, created_by, created_at, archived_at)
family_learner_relationships(id, family_id, learner_id, user_id,
                   relationship CHECK (relationship IN ('parent','legal_guardian','co_educator','learner_self')),
                   authority CHECK (authority IN ('full','educational','view')),
                   verification CHECK (verification IN ('self_declared','verified_by_owner','verified_document')),
                   effective_from, effective_to NULL, revoked_by, revoked_at, revoke_reason)
```

- **At least one active owner** per family, enforced by a constraint trigger. Ownership changes need the current owner, or the account-recovery workflow below.
- **Authority is per learner**, not per family. A co-educator can teach a learner without being able to export or delete that learner's records. A guardian-viewer only reads. This follows the plan: not every adult linked to a child has the same legal authority.
- **Learners are not `students`.** `family_learners` belong to the family tenant. A learner may get a sign-in later (`family_memberships.role='learner'` plus a `learner_self` relationship), never by default, and never for a young learner without the owner's action.
- **Disputes and recovery:** a relationship can be suspended pending review. Ownership recovery requires an out-of-band verification recorded with an approval reference. Both are audited, and neither is automatic.
- **Revocation** ends access at the next request: every read re-checks the relationship. Cached sessions are evicted on revoke, as membership switching does today.

### Private school (HSP-03)

`private_school_memberships(private_school_id, user_id, campus_id NULL, role ∈ school_admin | campus_admin | registrar | finance | teacher | staff | guardian | learner, …)`, and learner records in `private_school_learners`. Guardians are linked to learners as above. Finance is a separate role from academic roles (separation of duties, HSP-05).

### One person, several environments

`users` stays global: one identity, as today. A person can be a district teacher, a homeschool owner and a private-school guardian, through three unrelated memberships. **Identities are never merged across tenants.** A learner moved from a family to a school arrives as a new record, linked only by a transfer record (HSP-06).

## 5. Session context and RLS mechanics

- `sessions` gains `tenant_kind` and `tenant_id`.
  - For districts: `tenant_kind='district'` and `district_id = tenant_id`. Existing columns and behavior are unchanged.
  - For other kinds: `district_id` becomes nullable, with a `CHECK ((tenant_kind = 'district') = (district_id IS NOT NULL))`.
  - The membership the session was opened for is recorded too: `family_membership_id`, or `private_school_membership_id` later.
- **One context per session.** `POST /api/session/context {kind, membershipId}` generalizes today's membership switch. It issues a new session for exactly one tenant. The client's environment selector only chooses which membership to switch to; the server looks the membership up, checks it's active, and derives the role. **Client-sent tenant IDs and roles are ignored everywhere.**
- `withTenantTransaction(actor)` sets, per context:

| Setting | District session | Family session |
|---|---|---|
| `app.tenant_kind` | `district` | `homeschool_family` |
| `app.district_id` | the district | `''` (empty) |
| `app.family_id` | `''` | the family |
| `app.user_id`, `app.role` | as today | user, family role |

- **District tables are invisible in a family session.** Every existing policy compares to `app.district_id`, which is empty there, so they match nothing. No existing policy needs to change for HSP-01. Family tables compare `family_id` to `app.family_id`, so they are invisible in district sessions.
- **Relationship checks are SQL functions**, like the `eduos_is_family_of` and `eduos_is_athletic_director` pattern: `eduos_family_role()` and `eduos_family_authority(learner_id)` return `full`, `educational`, `view` or nothing. Policies and routes both use them, so a forgotten route check still can't widen access.
- **Background workers** (reminders, exports, notifications) run per tenant. They set the same context, then re-check the membership or relationship when they deliver, not only when the job is queued.
- **Shared tables (HSP-02 onward).** A learning-core table shared with families gains a `tenant_id` column, backfilled to `district_id` for district rows. Its policy becomes `tenant_id = app.tenant_id`. `district_id` stays `NOT NULL` on district rows through a check by kind, and existing indexes and foreign keys keep working. Each such table is its own reviewed migration, with negative tests (§9).

## 6. Policy matrix

**Homeschool family** (HSP-01 and HSP-02). Owner is the primary educator; "Co-ed." is co-educator, acting with `educational` authority for the learner; "Viewer" is guardian-viewer, with `view` authority; "Learner" is the learner signed in as themself.

| Action | Owner | Co-ed. | Viewer | Learner (self) |
|---|---|---|---|---|
| Family profile, jurisdiction profile | edit | read | read | — |
| Invite or revoke adults | yes | — | — | — |
| Transfer ownership | yes (to another active adult) | — | — | — |
| Add or archive a learner | yes | — | — | — |
| Learner's plan, calendar, attendance, work | edit | edit | read | read own |
| Grades and evidence (parent-entered, labeled so) | edit | edit | read | read own |
| Progress report, transcript or portfolio **export** | yes, with `full` authority only | — | — | — |
| Delete a learner's records | yes, with `full` authority, after a retention check | — | — | — |
| Audit history | read | read own actions | — | — |

**Private school** (HSP-03 to HSP-05) is outlined here and fixed in HSP-03's review:
- school admin: organization, roles, branding, closure and export;
- campus admin: their campus;
- registrar: admissions and enrollment records;
- teacher: their classes;
- finance: invoices and payments only, with no academic records;
- guardian: their learners;
- learner: themself.

**Never, for anyone:**
- reading another tenant's rows, guessing IDs included;
- a public learner directory;
- advertising or the sale of learner data;
- unrestricted GPS;
- open adult-to-child direct messaging.

## 7. Migration strategy

| Step | Migration | Effect on districts |
|---|---|---|
| HSP-01a | `tenants`, with a backfill row per district; the trigger keeping `districts` and `tenants` aligned | None. Tested on a copy of a populated database with `backup-restore.test.js`. |
| HSP-01b | `sessions.tenant_kind` and `tenant_id` (district rows backfilled), `district_id` nullable only for non-district kinds | None: existing sessions keep working. |
| HSP-01c | `homeschool_families`, `family_memberships`, `family_learners`, `family_learner_relationships`, `family_calendar_events`, with forced RLS on `app.family_id` and runtime grants | None |
| HSP-02+ | One migration per shared learning-core table (`tenant_id`, backfill, policy swap, negative tests) | Policy swap only, behind tests |

- **Rollback:** each migration goes forward only, as today (`docs/MIGRATIONS.md`). Rolling back means restoring the backup taken before upgrading. HSP-01a to HSP-01c add, and change no existing column's meaning, so the previous release runs on the upgraded schema. Each PR verifies this by running the previous release's integration suite against it.
- **Retention:** the retention job (`src/retention.js`) gains a pass per family tenant. FED-07 jurisdiction rules apply only to districts, since they come from district policy bundles. Families get their own retention settings in HSP-06.
- **Backups:** family tenants live in the same database and are covered by the existing backup and restore procedure. The restore test adds a family tenant.

## 8. API boundaries

- **District routes are unchanged.** They require a district context and return 403 `district_context_required` in any other.
- **Family routes** live under `/api/home/…`: `/api/home/family`, `/api/home/members`, `/api/home/learners`, `/api/home/calendar`. They require a family context.
- **Context:**
  - `GET /api/session/contexts` lists the signed-in user's active memberships across kinds, with labels only.
  - `POST /api/session/context` switches.
- **Creating a family:**
  - `POST /api/home/families` works from any signed-in session and creates the family tenant with the creator as owner.
  - Abuse controls: per-user limits on families created and invitations sent, an email-verified account, and rate limits.
- **IDs in paths** are checked in SQL against the active tenant; a mismatch is 404. Exports re-check authority at download time. Every route has a negative test.

## 9. Threat model (STRIDE, condensed)

| Threat | Example | Control |
|---|---|---|
| **Spoofing** | Signing in as a "co-educator" by accepting a forwarded invite | Invitations bound to the invitee's verified email. Single use, expiring, revocable. |
| **Spoofing** | Client sends `tenantId` for another family | The server derives the tenant from the session. Client values are ignored (tested). |
| **Tampering** | Parent-entered grades presented as a verified credential | Provenance labels on every grade and export: "parent-entered", "issuer: family". EDAL verification only for verified issuers. |
| **Repudiation** | An owner removes a co-educator and denies it | Audit events for every membership, relationship, grade, export and ownership change, append-only as today. |
| **Information disclosure** | A family session reads district rows | District policies compare to an empty `app.district_id`, so nothing matches. Negative integration test as the runtime role. |
| **Information disclosure** | IDOR on `/api/home/learners/:id` | RLS plus SQL relationship check; 404 on mismatch. |
| **Information disclosure** | A revoked guardian keeps a cached session | Revocation evicts sessions, and every request re-checks the relationship. |
| **Information disclosure** | A worker sends a report after authority was revoked | Delivery-time re-check. |
| **Denial of service** | Mass family creation or invite spam | Per-user and per-IP limits, verified email, abuse review queue. |
| **Elevation of privilege** | A co-educator exports or deletes a learner | Authority `educational` doesn't grant export or delete. Enforced in SQL and in the route. |
| **Elevation of privilege** | A learner self-account reads siblings | `learner_self` relationship only to themself. |
| **Child safety** | A co-op adult messages a child | No adult-to-child direct messages. Co-ops (HSP-07) are adult-sponsored, invite-only and moderated. |
| **Custody disputes** | Two guardians with conflicting authority | Per-learner authority, a suspend-pending-review state, and no silent overrides. Documented support path. |

## 10. Test plan every HSP PR must pass

The acceptance gates from #207, made concrete:
1. **Real PostgreSQL as the non-owner runtime role.**
   - Positive tests per role in the matrix (§6).
   - Negative tests: family A cannot reach family B, and a district session cannot reach any family table. Then the reverse: a family session cannot reach a district table. Run it over every table the PR adds, by enumerating `pg_policies`.
2. **Context:**
   - a forged tenant ID in the body, query or header has no effect;
   - a stale session after revocation is refused;
   - switching context ends the old session.
3. **IDOR:** every `:id` route is called with an ID from another tenant, and gets 404.
4. **Lifecycle:**
   - invite, accept, revoke and re-invite;
   - ownership transfer;
   - the last-owner guard;
   - learner archive.
5. **Workers:** delivery after revocation is refused.
6. **Audit completeness:** each action in §6 writes exactly one audit event.
7. **Browser and phone:** a smoke test for every affected role. Keyboard and screen-reader checks (axe), and no `prompt()` or `confirm()`, as the phone UI rule requires.
8. **Migration:**
   - an upgrade of a populated copy;
   - the previous release's tests against the new schema;
   - a backup-restore test that includes a family tenant.
9. **Docs:** the PR's tables, tenant ownership, retention, export and deletion, and incident response.

## 11. Decisions for the reviewer

1. **Tenancy option C** (§2), with `tenants` as the supertype and districts unchanged.
2. **One context per session**, with district tables made invisible by an empty `app.district_id`, rather than a policy change on 209 policies.
3. **Per-learner authority levels** `full`, `educational` and `view`, and export or delete only with `full`.
4. **Learners are family-owned records**, not `students`, and no learner sign-in by default.
5. **Families aren't federated** (no Master Control node). Private schools join state programs only by agreement.
6. **The family API prefix** `/api/home/…`.
7. **HSP-01 scope:**
   - the family tenant, members and invitations;
   - learners and relationships;
   - a multi-learner dashboard and family calendar;
   - the context switch.

   Attendance, plans, grades and exports wait for HSP-02.

Once these are approved, HSP-01 starts with migrations HSP-01a to HSP-01c.
