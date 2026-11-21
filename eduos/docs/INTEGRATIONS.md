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
expansion. Student records are requested only for schools already mapped by
the district; unmapped school rosters are not downloaded. Records missing an
explicit active enrollment status are rejected rather than assumed active. It
does not request contacts, addresses, demographics or guardian data. The aggregate download ceiling is 200,000 student records per sync, configurable
with `POWERSCHOOL_MAX_STUDENTS` from 1,000 to 200,000. The limit counts all
downloaded records, including rejected records, across mapped schools. This
bounded in-memory limit is not a certified district capacity target. Districts
with larger rosters need a staged/chunked ingestion implementation before the
limit can be raised safely; do not increase it to accommodate a large district. The PowerSchool endpoint and response shape can vary by SIS release and
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

## Canvas LMS API connection (separate from app launch)

EduOS launches the district's Canvas LMS from the approved app catalog. The
optional Canvas API connector is a separate integration and does not change
that direction. A district can launch Canvas without connecting its API.

For the API connection, register an institution-managed Canvas developer key
in the district's Canvas tenant. Add a **Canvas LMS API** connector using the
tenant origin only (for example, `https://district.instructure.com`), the
matching token endpoint
(`https://district.instructure.com/login/oauth2/token`), the developer key
ID and its secret. Configure the developer key to require endpoint scopes, then enter only the approved read-only Canvas endpoint scopes in EduOS (space-separated `url:GET|/api/v1/...` values). Write scopes are rejected by the connector. The callback URI must be registered exactly as:

`PUBLIC_ORIGIN` + `/api/integrations/canvas/callback`

A different district lead must approve the connector before the authorized
district administrator can complete the Canvas OAuth consent flow. EduOS uses
the authorization-code flow; it does not collect Canvas passwords, personal
access tokens or browser cookies. The developer key's scopes must be set and
reviewed in Canvas by the district. Keep the developer key secret in EduOS's
encrypted connector secret field and never commit it to source control.

EduOS stores access and refresh tokens encrypted and does not return them from
its API. Expired access tokens are refreshed server-side with a database-backed
lease so concurrent application instances do not issue duplicate refresh requests. Canvas reuses the existing refresh token.
Invalid or revoked refresh grants require the district administrator to reconnect.
Changing Canvas connector credentials or disabling the connector deletes the
previous grant and pending authorization state. Disconnecting in EduOS attempts Canvas's token DELETE endpoint, deletes the locally stored tokens and pending authorization state, and returns the connector to pending approval. A different district lead must approve it before reconnecting. The district should also revoke or disable the developer key in Canvas when full application revocation is required.

**CANVAS-API-01 scope:** OAuth connection, token storage, status and local
disconnect only. Course, enrollment and grade synchronization are not enabled
by this phase. The existing roster sync endpoint explicitly refuses Canvas
connectors until the read-only Canvas adapter is implemented and reviewed.
