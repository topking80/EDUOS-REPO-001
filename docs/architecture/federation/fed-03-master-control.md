# FED-03 — Master Control API and console shell

Status: first working slice of the federation administration plane. It stores the FED-02 authority model, makes every change through the FED-02 engine, and audits every decision. It has **no way to browse student, family or staff records**, and that is enforced by the database, not just by code.

Code: `eduos/src/master-control/` (server, API, console in `console/`). Schema: `eduos/db/master-control/`. Tests: `eduos/test/master-control.test.js` and `eduos/test/integration/master-control.test.js`.

## Separation from EduOS

| | EduOS | Master Control |
|---|---|---|
| Process | `npm start` | `npm run mc:start` (own port, `MC_PORT`, default 3100) |
| Database | `public` schema, `eduos_app` login with RLS | `master_control` schema (or a separate database), its own login (`MC_APP_ROLE`) |
| Sign-in | district OIDC (`OIDC_*`) | its own OIDC client (`MC_OIDC_*`); only registered operators |
| Cookies | `eduos_session`, path `/` | `eduos_mc`, path `/mc` |
| Imports | — | only its own files and `src/federation/` (a unit test checks this) |

At every start, Master Control **refuses to run** if its login:
- is a superuser, or can bypass RLS, create roles or create databases;
- can select, insert, update or delete any table outside `master_control`.

`npm run mc:migrate` grants the runtime role this schema only and revokes anything in `public`. The integration test confirms the login gets "permission denied" on `public.students`, and that Master Control won't start after someone grants it.

## What it stores

- **Nodes:** platform → state education authority → district → school. Each has a jurisdiction, a district tenant reference (opaque), an effective period and an approval reference.
- **Operators:** people who may sign in, identified by OIDC issuer + subject, each with an opaque `principal_id`.
- **Role assignments, delegations and policy settings:** exactly the FED-02 contract.
- **Audit log:** every decision (allowed, denied, or rejected as invalid), with actor, action, node, capability, the engine's basis or reason, and details.
  - Rows are chained by SHA-256 (each hash covers the previous hash and the canonical entry).
  - Rows can't be updated, deleted or truncated.
  - `GET /mc/api/audit/verify` walks the chain and reports the first broken entry.

## How a change is decided

Each change runs in one serialized transaction:
1. Load the whole model.
2. Ask the FED-02 engine whether the operator may do it (deny by default). A denial is audited and returns 403 with the reason.
3. Apply the change to a copy of the model and validate the whole model. Invalid models are audited as `rejected` and return 422 with the errors.
4. Save the change and audit it with the engine's basis.

Who may do what:

| Change | Needs |
|---|---|
| Add a state authority, district or school | `federation.membership.manage` over the parent (platform operators) |
| Close a node | `federation.membership.manage` over it |
| Assign a role at a platform or state node | `federation.roles.assign` (platform operator; state oversight for their own state node) |
| Assign a role at a district or school | `tenant.roles.assign`, which only the district holds. The one exception: a newly enrolled district's **first superintendent** may be set up by whoever enrolled the district. That is audited with `bootstrap: first_district_superintendent`, and stops once the district has someone who can assign roles. |
| Revoke a role | The same capability over the node, or the holder giving it up |
| Delegate | Only from your own assignment, or a delegation you received. FED-02 then checks no enlargement, student data staying in its district, an end date, a purpose and redelegation rights. |
| Revoke a delegation | The delegator, anyone above them in the chain, or the delegate (giving it up) |
| Set a policy | `policy.set` at that node. A new version ends the previous one the day before it starts. |

Nobody can assign a role to themselves or delegate to themselves. Revocations and policy settings can't be backdated.

## API (all under `/mc/api`, session cookie plus `x-csrf-token` for changes)

`GET me`, `GET catalog`, `GET nodes` (only nodes related to where you hold a role or a delegation), `GET nodes/:id` (role holders shown only with `audit.view` or a role-assigning capability there), `GET check?capability&nodeId` (your own authority), `GET policies/:id/resolve?nodeId[&at]`, `GET audit?nodeId` (`audit.view` at that node), `GET audit/verify` (platform configuration), `POST nodes`, `POST nodes/:id/close`, `POST assignments`, `POST assignments/:id/revoke`, `POST delegations`, `POST delegations/:id/revoke`, `POST policy-settings`.

## Console shell (`/mc/`)

- Shows the federation tree you can see and your roles.
- For the selected node:
  - who holds which role there, with revoke;
  - assigning a role;
  - adding a child node;
  - the effective value of every policy (with ignored settings and why), and setting one;
  - the node's audit trail.
- Lists the delegations you gave and received, with revoke.
- Built with DOM calls only (no HTML strings) under a strict CSP (`default-src 'self'`, `frame-ancestors 'none'`).

Creating delegations is API-only in this slice.

## Running it

1. Create the runtime login: `CREATE ROLE mc_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '…'`. A separate database is preferred. If it shares EduOS's database, the migration and start-up checks keep it out of `public`.
2. Migrate as the schema owner: `MC_MIGRATE_DATABASE_URL=<owner url> MC_APP_ROLE=mc_app npm run mc:migrate`
3. Configure:
   - `MC_DATABASE_URL` (the `mc_app` login), `MC_PUBLIC_ORIGIN` (https in production);
   - `MC_OIDC_ISSUER`, `MC_OIDC_CLIENT_ID`, `MC_OIDC_CLIENT_SECRET`, `MC_OIDC_REDIRECT_URI` (default `<origin>/mc/auth/callback`);
   - optional: `MC_PORT`, `MC_SESSION_HOURS` (1–24, default 8), `MC_RATE_LIMIT_PER_MINUTE`.
4. Once, create the platform and its first operator: `npm run mc:bootstrap -- --subject <oidc sub> --name "<name>" --approval "<reference>"`. It refuses to run again.
5. Start: `npm run mc:start`. Put it behind its own hostname or path, not EduOS's.

## Not in this slice

- Wiring EduOS's own district roles to Master Control's assignments; EduOS keeps its current in-district authority.
- Identity federation, multiple issuers and provisioning (FED-04).
- Signed policy distribution to districts and acknowledgements (FED-05). Policies resolved here aren't yet pushed into EduOS.
- Cross-tenant exchange (FED-06).
- Jurisdiction and data residency (FED-07).
- Security operations, observability and resilience (FED-08–10).
- A delegation form in the console.
