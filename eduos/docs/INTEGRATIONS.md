# Data links: OneRoster 1.2, Ed-Fi and PowerSchool

EduOS is the district's operational system and runs on its own. Data links let
it **read** student rosters from systems a district already has, so staff
don't re-type them. They are optional, off by default, and never send EduOS
student data out.

## Turning it on

1. Set `INTEGRATIONS_KEY` on the server (32+ random characters). It encrypts
   each connector's client secret. If you change it, re-enter every secret.
2. Optionally set `INTEGRATIONS_ALLOWED_HOSTS` (comma-separated) to limit which
   hosts connectors may reach.
3. Run database migrations (`npm run db:migrate`).

Connectors reach public HTTPS servers only (checked after DNS, pinned for the
connection, no redirects), under the same destination rules as outbound webhooks.

## Adding a connector (Data links tab)

A superintendent or IT admin adds the connector. **A different** district lead
approves it before it can sync. Changing its URLs, client ID, secret or scope,
or which EduOS school any of their schools is linked to, sends it back for
approval. A sync that was already reading their roster when such a change (or
turning it off) happened imports nothing. Principals and school staff have no
access.

| | OneRoster 1.2 | Ed-Fi API | PowerSchool SIS |
|---|---|---|---|
| Base URL | `https://sis.example.org/ims/oneroster/rostering/v1p2` | v8: `https://edfi.example.org/api/data` · ODS/API v5–7: `…/api/data/v3` | District SIS origin, e.g. `https://district.powerschool.com` |
| Token URL | from your SIS | v8: Configuration Service `/connect/token`, or `/oauth/token` on API host · ODS/API: `/oauth/token` | Use the OAuth token URL supplied/configured for the installed PowerSchool plugin (commonly `/oauth/access_token/`) |
| Auth | OAuth 2.0 client credentials; default scope `roster-core.readonly` | OAuth 2.0 client credentials | OAuth 2.0 client credentials |
| Reads | `/schools`, `/students` | `schools`, `students`, `studentSchoolAssociations` | `GET /ws/v1/district/school`, then active-only `GET /ws/v1/school/{school-dcid}/student?q=school_enrollment.enroll_status==(A)` |
| Writes to SIS | None | None | None |

For PowerSchool, install and enable a district-approved OAuth plugin, use its
client credentials, and ask the district/vendor to grant only the GET access
needed for school and student roster endpoints. PowerSchool API plugin
credentials are sensitive and must be stored only in the encrypted connector
secret field. Do not reuse administrator passwords or browser session cookies.
The adapter requests only active school enrollments using PowerSchool's
`school_enrollment.enroll_status==(A)` query and the `school_enrollment`
expansion. It does not request contacts, addresses, demographics or guardian
data. The PowerSchool endpoint and response shape can vary by SIS release and
plugin; validate against the district's actual supported REST API before
production use. PowerSchool documents OAuth plugin credentials in its
[administrator guide](https://ps.powerschool-docs.com/pssis-admin/latest/view-oauth-client-credentials).

## Syncing

- **Preview** reads their roster and shows what would change. Nothing changes.
- Link each of their schools to an EduOS school (exact name matches are
  suggested). Students at schools you don't link aren't imported.
- **Import** adds or updates students through the same rules as the SIS CSV
  import: one SIS run per school, district caps, audit.
- A student already at another EduOS school is **not moved**; transfers happen
  in EduOS. Duplicate student numbers and records with no school, name, or
  student number are skipped and listed by external id.
- Student number: OneRoster `identifier`; Ed-Fi `studentUniqueId`;
  PowerSchool `student_number`. PowerSchool's student DCID is retained only
  as the external source identifier.

Every change, approval and sync is in the audit log; each sync's counts and
skipped records are kept in its history.

## Not yet

- Staff accounts, class enrollments and attendance from these systems.
- Scheduled syncs (a district lead runs each one).
- Connectors to private-network servers.
- A live PowerSchool district test-instance certification. The adapter's
  contract tests do not establish compatibility with every PowerSchool release,
  plugin, field projection, or district configuration.

## District sign-in through Keycloak or another broker

No roster connector is needed. EduOS already signs people in with any OpenID
Connect provider, so a district can put Keycloak (or Entra ID, Google Workspace,
a SAML bridge) in front of EduOS by pointing `OIDC_ISSUER`,
`OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` at it. EduOS still decides what
each person can do from its own memberships; it never takes roles from the
identity provider.
