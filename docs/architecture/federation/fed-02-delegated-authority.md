# FED-02 — Delegated authority, scoped roles, district autonomy and policy inheritance

Status: data contract plus a tested rule engine. The running app does not use it yet; FED-03 (Master Control API and console) wires it in.

- Contract: `authority-model.schema.json` (JSON Schema 2020-12) and the seed `authority-model.v0.1.json` (model 0.4.0). The catalog part (capabilities, roles, policy definitions) is also shipped with the app as `eduos/src/federation/authority-catalog.json`; a test keeps the two identical.
- Engine: `eduos/src/federation/authority.js`, with three functions:
  - `validateAuthorityModel(model)` checks a model and lists every problem;
  - `authorize(model, {principal_id, capability_id, node_id, at, purpose?})` answers whether someone may act;
  - `resolvePolicy(model, policy_id, node_id, at)` gives a policy's effective value.
- Tests: `eduos/test/federation-authority.test.js`.

This covers the **education** federation only. Athletics associations (`registry-seed.*.json`, SPORT-01–03) are a separate graph with their own governance and delegations. They are never nodes here, and membership in one never confers authority in the other.

## The hierarchy

```
platform
└── state education authority   (one per jurisdiction, US-XX)
    └── district                (the education tenant: owns student data)
        └── school              (a unit of its district's tenant)
```

- There is exactly one platform node.
- Each node has the parent kind shown above and shares its parent's jurisdiction.
- Districts and schools carry the district's `tenant_ref`. It is an opaque reference to the tenant and grants nothing by itself.
- Nodes are effective-dated. A closed node grants nothing after it closes.

## Capabilities

A capability is one thing someone can do. Each one says:
- whether it touches student data (`none`, `aggregate` or `identifiable`);
- the levels where it can be held;
- how far it reaches from where it is held:
  - `node`: only there;
  - `descendants`: there and everything below;
  - `tenant`: there and below, but never outside that district;
- whether it can be delegated.

| Capability | Student data | Held at | Reach | Delegable |
|---|---|---|---|---|
| `platform.config.manage` | none | platform | node | no |
| `federation.membership.manage` | none | platform | descendants | no |
| `federation.roles.assign` | none | platform, state | descendants | no |
| `federation.identity.manage` | none | platform, state | descendants | no |
| `service.health.view` | none | platform, state, district | descendants | yes |
| `security.incident.coordinate` | none | platform, state, district | descendants | yes |
| `policy.set` | none | all | node | yes |
| `policy.distribute` | none | platform, state | descendants | no |
| `audit.view` | none | all | node | yes |
| `reporting.aggregate.view` | aggregate | state, district, school | descendants | yes |
| `reporting.submit` | aggregate | district | node | yes |
| `tenant.users.manage` | none | district, school | tenant | yes |
| `tenant.roles.assign` | none | district, school | tenant | **no** |
| `school.operations.manage` | none | district, school | tenant | yes |
| `student.records.read` | identifiable | district, school | tenant | yes, within the district |
| `student.records.write` | identifiable | district, school | tenant | no |
| `student.storage_quota.set` | none | district (reserved) | node | no |

Roles are named bundles of capabilities held at one level (seed: platform operator, state oversight, superintendent, district IT administrator, principal). A role assignment gives one principal (an opaque ID) one role at one node, for a dated period, with an approval reference.

## Hard rules (enforced by the engine whatever a model's catalog says)

1. **No global access to student records.**
   - Identifiable student data (anything marked `identifiable`, and any `student.records.*` capability) can be held only at a district or school.
   - It reaches only inside that district's tenant.
   - It can be delegated only to someone whose home node is in the same district.
   - No platform or state role ever reaches it, even if an unvalidated model claims otherwise.
   - Inside the app, the existing relationship and RLS rules still apply on top of this.
2. **District autonomy.**
   - Tenant administration (`tenant` reach) stops at the district boundary.
   - A state authority gets such a capability only when the district delegates it, with a stated purpose, an end date and an approval reference.
   - Assigning roles inside the tenant (`tenant.roles.assign`) is never delegable.
   - Roles at platform and state nodes are assigned with `federation.roles.assign`; roles at districts and schools only with `tenant.roles.assign`, which only the district holds. Master Control (FED-03) applies this split.
3. **No enlargement.**
   - A delegation can carry only capabilities the delegator holds over the delegation's node, on the day it starts and on every day it is used.
   - Redelegation needs `may_redelegate` on the parent link, and chains are at most 3 deep.
4. **Revocation stops the future, not the past.**
   - Suspending or revoking any link in a chain (or the delegator's own assignment ending) stops everything delegated through it from that date.
   - Asking about an earlier date gives the answer that was true then.
   - `proposed` records never count.
5. **Purpose-bound delegations.** When a request states a purpose, it must match the delegation's purpose. A delegation without an end date is invalid.
6. **Deny by default, with a reason.**
   - Reasons: `no_grant`, `purpose_mismatch`, `student_data_outside_tenant_or_role`, `node_inactive`, `unknown_capability`, `unknown_node`, `invalid_date`, `no_principal`.
   - Every allow names its basis: the assignment, or the delegation chain back to the assignment it came from.

## Policy inheritance and overrides

A policy definition fixes:
- the value type;
- a default;
- the levels that may set it;
- the levels whose setting may **lock** descendants;
- a mode:
  - **free**: any settable level chooses its own value; the nearest setting wins.
  - **restrict_only**: once an ancestor has set a value, descendants may only make it stricter (`stricter`: `true`/`false` for booleans, `higher`/`lower` for integers). A looser setting is ignored and reported.
  - **district_reserved**: only the district sets it, and nobody can lock it. Example: the per-pupil storage quota.

Resolution walks from the platform down to the node:
- At each node, the newest active version of the setting in force on the date applies.
- A setting is ignored, with a reason in `conflicts`, when:
  - an ancestor locked the policy (`locked_by:<setting>`);
  - it is looser than what it inherits (`looser_than_inherited`);
  - its level can't set the policy (`not_settable_here`);
  - its value doesn't fit (`invalid_value`).
- The result lists every setting applied (`chain`).
- A setting is valid only if the assignment that made it held `policy.set` at that node on its start date. Because `policy.set` reaches only its own node, a state can't set a district's policy directly; it sets its own value, and inheritance applies.

The seed's policy definitions are product examples, not legal requirements:
- staff MFA;
- minimum years history is kept;
- photo uploads;
- the per-pupil storage quota;
- default interface language.

The seed holds no nodes, assignments, delegations or settings. Real ones come from approved records, through FED-03.

## Not in this slice

- Storage, APIs, a console or audit logging of decisions: FED-03 builds them on this engine, with every decision written to a tamper-evident trail.
- Identity federation and provisioning (FED-04).
- Signed policy distribution and rollback (FED-05).
- Cross-tenant data exchange (FED-06).
- Jurisdiction rules for residency and retention (FED-07).
- Mapping the app's existing district roles (superintendent, principal, vice principal, IT admin and others) onto these roles: FED-03 does this, keeping today's in-district rules unchanged.
