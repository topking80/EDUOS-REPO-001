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

## Class rosters (optional)

A connector can also import **who teaches whom**: the SIS's teachers, class
sections and enrollments become teacher rosters in EduOS. Rosters decide which
students a teacher can see (including student history and Time Capsules), so:

- It's **off** unless a district lead turns it on ("Also import class rosters",
  or "Add class rosters" on an existing connector), and turning it on or off
  needs a **different** lead's approval, like any connector change.
- **No accounts are created.** An SIS teacher becomes the one active EduOS
  teacher at that school with the same email (case doesn't matter). If no
  teacher, or more than one, matches, the preview lists them; add them as
  teachers in EduOS, or match them by hand to an existing teacher. A manual
  match also needs approval again.
- Students in a class must already be in EduOS at that same school (the same
  sync imports them first). A student at another EduOS school isn't linked.
- Only roster links **this connector created** are added or removed. Rosters
  a person entered by hand are never changed, and a pair already on a
  hand-entered roster is left as it is. Links at a school that's no longer
  linked to the connector are left alone.
- If the SIS returns no class enrollments at all for the linked schools, the
  import stops and nothing is removed: that's more likely an outage than every
  class emptying overnight.
- **Preview** is a full dry run: it imports the students, plans the rosters,
  and rolls everything back, so its counts are what an import would do.
- Scheduled syncs import rosters the same way, as the scheduler's service
  identity, under the schedule a district lead approved.

What's read: OneRoster `/classes`, `/teachers` and `/enrollments` (active
records; teacher and student roles only); Ed-Fi `sections`, `staffs`,
`staffSectionAssociations` and `studentSectionAssociations` (associations
that haven't ended; the staff member's work email is preferred); PowerSchool
`/ws/v1/school/{id}/section`, `/ws/v1/school/{id}/staff` and
`/ws/v1/section/{id}/section_enrollment` for linked schools (the section's lead
teacher; dropped and exited students are skipped). PowerSchool field names vary
by version and plugin: preview against the district's sandbox before turning
class rosters on there.

EduOS courses (lessons, assignments) are still created by teachers; the SIS
sections only decide rosters.

## Not yet

- Staff accounts and attendance from these systems.
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
