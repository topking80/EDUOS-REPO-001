# EduOS 35.6.0 — District SRO Deployment Policy

## District controls
A superintendent can configure:
- **School scope:** allow SRO memberships at all active district schools, or allow only an explicit list of active school IDs. An empty list allows none.
- **Superintendent-only provisioning:** when enabled, district IT administrators cannot create SRO memberships or reactivate disabled SRO memberships; the superintendent must perform those actions directly.
- District IT administrators can read the policy. Principals cannot read or change district policy and remain unable to provision SRO accounts.

## Enforcement
The policy is enforced server-side for SRO user creation, additional membership creation, and membership reactivation. Disabling an SRO remains available to authorized district administrators. All policy changes are audited. Policy data is district-scoped with PostgreSQL RLS; runtime grants exclude delete/truncate.

## API
- `GET /api/admin/sro-policy` — superintendent or district IT administrator.
- `PUT /api/admin/sro-policy` — superintendent only, CSRF protected.
- Body: `{ "allowedSchoolIds": null | ["<school-uuid>", ...], "requireSuperintendentApproval": true | false }`.
- `null` means all active schools. `[]` means no schools. IDs must be unique active schools in the current district.

The approval setting is an authorization gate, not an approval queue: when enabled, IT must route the request to a superintendent to perform provisioning directly. No pending approval workflow or external notification is implied.

## Deployment
Apply migration `021_sro_district_policy.sql` through the standard migration runner, then deploy the application. Existing districts with no policy row retain prior behavior (all district schools allowed; IT provisioning remains enabled) until a superintendent saves a policy.

## Verification
Focused SRO policy, role, and coordination tests: 15 passed. JavaScript syntax checks and ZIP integrity are included in this release packaging. Live PostgreSQL migration/RLS behavior, browser E2E, and identity-provider integration were not run in this environment.
