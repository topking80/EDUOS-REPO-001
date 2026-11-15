# Data links: OneRoster 1.2 and Ed-Fi

EduOS is the district's operational system and runs on its own. Data links let
it **read** student rosters from the systems a district already has, so staff
don't re-type them. They are optional, off by default, and never send EduOS
student data out.

## Turning it on

1. Set `INTEGRATIONS_KEY` on the server (32+ random characters). It encrypts
   each connector's client secret. If you change it, re-enter every secret.
2. Optionally set `INTEGRATIONS_ALLOWED_HOSTS` (comma-separated) to limit which
   hosts connectors may reach.
3. Run migration `040_external_integrations.sql` (`npm run migrate`).

Connectors reach public HTTPS servers only (checked after DNS, pinned for the
connection, no redirects), the same rules as outbound webhooks.

## Adding a connector (Data links tab)

A superintendent or IT admin adds the connector. **A different** district lead
approves it before it can sync. Changing its URLs, client ID, secret or scope
sends it back for approval. Principals and school staff have no access.

| | OneRoster 1.2 | Ed-Fi API |
|---|---|---|
| Base URL | `https://sis.example.org/ims/oneroster/rostering/v1p2` | v8: `https://edfi.example.org/api/data` · ODS/API v5–7: `…/api/data/v3` |
| Token URL | from your SIS | v8: Configuration Service `/connect/token`, or `/oauth/token` on the API host · ODS/API: `/oauth/token` |
| Auth | OAuth 2.0 client credentials; default scope `roster-core.readonly` | OAuth 2.0 client credentials |
| Reads | `/schools`, `/students` | `schools`, `students`, `studentSchoolAssociations` |

Ask the vendor for a **read-only** client.

## Syncing

- **Preview** reads their roster and shows what would change. Nothing changes.
- Link each of their schools to an EduOS school (exact name matches are
  suggested). Students at schools you don't link aren't imported.
- **Import** adds or updates students through the same rules as the SIS CSV
  import: one SIS run per school, district caps, audit.
- A student already at another EduOS school is **not moved**; do transfers in
  EduOS. Duplicate student numbers and records with no school or name are
  skipped and listed by external id.
- Student number: OneRoster `identifier` (else `sourcedId`); Ed-Fi
  `studentUniqueId`. Ed-Fi's current school is the latest association without
  an exit date.

Every change, approval and sync is in the audit log; each sync's counts and
skipped records are kept in its history.

## Not yet

- Staff accounts, class enrollments and attendance from these systems.
- Scheduled syncs (a district lead runs each one).
- Connectors to private-network servers.

## District sign-in through Keycloak or another broker

No connector is needed. EduOS already signs people in with any OpenID Connect
provider, so a district can put Keycloak (or Entra ID, Google Workspace, a
SAML bridge) in front of EduOS by pointing `OIDC_ISSUER`, `OIDC_CLIENT_ID` and
`OIDC_CLIENT_SECRET` at it. EduOS still decides what each person can do from
its own memberships; it never takes roles from the identity provider.
