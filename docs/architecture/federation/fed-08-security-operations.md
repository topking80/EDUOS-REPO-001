# FED-08 — Security operations: key rotation, revocation and incident response

Status: built into Master Control and each district's EduOS.

Code:
- Master Control:
  - `eduos/src/master-control/security.js` (key registry, incident freezes, alerts);
  - the FED-08 routes in `eduos/src/master-control/app.js`;
  - `eduos/src/master-control/security-check.js` (`npm run mc:security-check`);
  - migration `eduos/db/master-control/006_security_operations.sql`.
- EduOS: `eduos/src/federation/key-ring.js`, used by the policy bundle, jurisdiction rule and exchange report code.

Tests:
- `eduos/test/key-ring.test.js`;
- `eduos/test/integration/key-rotation.test.js`;
- the FED-08 cases in `eduos/test/integration/master-control.test.js`.

## Master Control's signing key

Master Control signs policy bundles (FED-05) and exchange terms (FED-06) with the key derived from `MC_POLICY_SIGNING_SECRET`. Every key it signs with is recorded in a **key registry** by fingerprint:
- **active:** the key in use;
- **retired:** a key it moved on from;
- **revoked:** a key it will never use again.

**Rotating** (planned, for example yearly):
1. Generate the new secret and work out its public key and fingerprint.
2. In **every** district's EduOS, add the new public key to `MC_POLICY_PUBLIC_KEY`. It may list several keys, separated by commas or spaces, or as several PEM blocks. EduOS now trusts both keys.
3. Switch Master Control to the new secret. The first signature with it makes it the active key and retires the old one.
4. Ask each district to receive a fresh bundle, so its newest bundle is signed with the new key.
5. After the overlap, remove the old key from `MC_POLICY_PUBLIC_KEY`. Bundles already received stay as they were.

**Revoking** (the secret was exposed):
1. A platform operator revokes the key (`POST /mc/api/signing-keys/:fingerprint/revoke`, with a reason). Master Control refuses to sign with it from then on, even if its secret is configured again (`policy_key_revoked`). The answer says how many bundles it signed.
2. Configure a new secret in Master Control, add its public key to each EduOS, and add the revoked fingerprint to each EduOS's `MC_POLICY_REVOKED_KEYS`.
3. EduOS then refuses any bundle or terms signed with that key (`key_revoked`), even if it's still listed as trusted. It also **stops following bundles it already received under it**: the jurisdiction rules (FED-07) fall back to the newest bundle signed with a key it still trusts. Data links marks such bundles.
4. Re-issue each district's policies (a new release) so they are signed with the new key.

`GET /mc/api/signing-keys` lists the registry, with how many bundles each key signed. `GET /mc/api/policy-signing-key` shows the configured key's status.

## A district's exchange key

The producing district's sharer can replace the EduOS key on an agreement (`POST /mc/api/exchange-agreements/:id/rotate-key`, with the new public key and a reason). From then on, reports signed with the old key are refused (`wrong_key`). Deliveries already accepted stay valid. A district does this after changing `EXCHANGE_SIGNING_SECRET`, on a schedule or after a compromise.

## Incidents

Whoever coordinates security at a node (`security.incident.coordinate`: the platform operator, a state, or a district's superintendent or IT administrator) can open an incident there, with a severity and a summary. Opening one can:
- **freeze exchanges** that involve the node or anything under it: no approvals, deliveries, terms or reads (`incident_freeze`, 423) until it closes;
- **sign out everyone** holding a role at the node or under it, except whoever opened it. This ends their Master Control sessions; they can sign in again.

Closing needs a note on what was found and done. Opening, closing and every refused action are in the hash-chained audit log. `GET /mc/api/incidents?nodeId=` lists incidents at, above and below a node.

For a compromised account or identity provider, the FED-04 controls still apply: disable an operator, sign them out everywhere, or suspend a provider.

## Alerts and the scheduled check

`GET /mc/api/security/alerts` (platform) lists, most severe first:
- **critical:** the audit hash chain is broken;
- **critical:** the configured signing key has been revoked;
- **high:** an operator has had at least `MC_ALERT_DENIALS_PER_HOUR` refusals in the last hour (default 10);
- **high or info:** each open incident.

`npm run mc:security-check` (with `MC_DATABASE_URL` and `MC_POLICY_SIGNING_SECRET`) prints the same alerts as JSON. It exits 1 when any is critical or high, so a scheduler or monitor can page someone. Run it every few minutes.

The console shows incidents on each node where you can coordinate security. For the platform, it also shows the signing keys and alerts.

## Not in this slice

- Automatic rotation, or Master Control pushing keys to EduOS: keys move by configuration, as bundles move by file.
- Freezing policy releases or sign-ins during an incident.
- Sending alerts anywhere: the check's exit code and output are for the operator's own monitoring (FED-09 covers observability).
