# FED-04 — Identity federation, trust, provisioning and account lifecycle

Status: built into Master Control (FED-03). This slice covers OIDC only; SAML and SCIM are not included.

Code: `eduos/src/master-control/identity.js`, the sign-in, provider, invitation and account routes in `app.js`, and migration `eduos/db/master-control/002_identity_federation.sql`. Tests: `eduos/test/integration/master-control.test.js`.

## Trusted identity providers

Master Control can trust several OIDC providers. Each one is limited to the part of the federation it may **vouch for**, its scope node. For example, a state's sign-in service is scoped to that state's node, and a district's own sign-in service to that district.

- **The primary provider:** the provider configured in `MC_OIDC_*` becomes `primary`, scoped to the platform.
  - It is created at start-up, or by bootstrap.
  - Master Control refuses to start if `MC_OIDC_ISSUER` no longer matches its stored issuer.
  - It can't be suspended or retired, so the platform can't lock itself out.
- **Who registers a provider:**
  - for a platform or state scope, whoever holds `federation.identity.manage` there (new capability: platform operator; state oversight for their state; never delegable);
  - for a district or school scope, **only the district** (`tenant.roles.assign` there).
- **Registration checks the provider first:** Master Control fetches its discovery document and requires the issuer to match. In production the issuer must be https.
- **Client secrets are never stored:** a provider names the environment variable (`MC_…`) that holds its secret. The provider list shows whether that variable is set on this server.
- **Optional sign-in rules per provider:**
  - `requireMfa`: the ID token's `amr` must show a second factor (RFC 8176 values such as `mfa`, `otp`, `hwk`).
  - `allowedEmailDomains`: the email must be verified and in one of the listed domains.
  - A failure is refused and audited (`mfa_required`, `email_domain_not_allowed`).
- **Status:** `active`, `suspended` or `retired` (retired is final), changed with a reason by the same authority that registers. Stopping a provider **ends every session** it vouched for.

## What a provider's scope means

An account belongs to exactly one provider, and its authority holds only at nodes inside that provider's scope:
- Assigning a role or creating an invitation at a node outside the scope is rejected (422).
- If the hierarchy changes later, an assignment outside the scope simply stops counting.
- A state provider's accounts can hold district roles in that state, if the district gives them. A district provider's accounts can never hold state or platform roles.

Authority also stops while the account is disabled or the provider isn't active. Those assignments, and the delegations the person received, count as suspended from that day. Delegations they **gave** stop too, because FED-02 checks the delegator's own authority every day it's used. Questions about earlier dates keep their answers.

## Provisioning by invitation

Accounts are no longer created by typing someone's subject identifier (that API path still exists for administrators who have it).

1. **Creating an invitation:** someone who could give the role (the same rules as assigning it, including a new district's first superintendent) creates an invitation with:
   - the node, the role and the provider;
   - the invitee's name;
   - an approval reference;
   - an optional role end date;
   - an expiry of 1–30 days (default 7).
2. **The link:** Master Control returns a sign-in link **once**. Only a hash of the code is kept.
3. **Accepting:** the invitee signs in with the named provider using the link. In one transaction Master Control:
   - re-checks the code, the provider and the provider's sign-in rules;
   - **re-checks that the inviter can still give the role**;
   - validates the whole model with the new assignment;
   - creates the account bound to that issuer and subject, attaches the role and marks the invitation used.
   - An existing account from the same provider just gains the role.
4. **Using and revoking:** an invitation works once. The inviter, or anyone who could give the role, can revoke it while it's pending. `GET invitations?nodeId` lists each invitation as pending, accepted, revoked or expired.

## Account lifecycle

- **Disable, enable, sign out everywhere** (`POST operators/:id/disable|enable|sign-out`, with a reason). Allowed for:
  - whoever manages identity for the account's provider scope;
  - whoever can give every role the person currently holds.
  - Anyone may disable their own account or sign themselves out; nobody may re-enable themselves.
- **Disabling** ends every session immediately and removes the person's authority from that day, as above.
- **Stale-account review** (`GET operators/review?days=90`): lists the people you manage who hold roles today but haven't signed in for that long, or ever. The console shows it with a Disable button.
- **Sessions** are re-checked on every request against the account and its provider, so suspension and disabling take effect at once.

Every step is in Master Control's hash-chained audit log: registration and status changes, invitations and acceptances (with who invited), sign-ins (allowed and refused, with the reason), and disabling, enabling and sign-outs.

## Configuration

For each extra provider, set its secret on the Master Control server under the name given at registration (for example `MC_IDP_SECRET_TX`). Alternatively, set `<NAME>_FILE` to the path of a mounted secret file, which takes precedence.

**Rotating a secret:**
- The secret is read every time it's used, and a provider's client is rebuilt whenever its issuer, client ID, scopes or secret changes (compared through an HMAC with a per-process key; the secret is never logged or stored).
- A rotated mounted file takes effect on the next sign-in, without a restart.
- A rotated environment variable needs a restart, because environment variables only change when the process starts. Register the redirect URI `MC_OIDC_REDIRECT_URI` (default `<origin>/mc/auth/callback`) with every provider.

## Not in this slice

- **SAML 2.0:** would need an audited XML-signature library.
- **SCIM provisioning** from directories.
- **Per-provider session limits** and step-up authentication for sensitive actions.
- **History of disabled periods:** re-enabling an account restores its history as if it had never been disabled. The audit log keeps the record.
- **EduOS's own sign-in** is unchanged.
