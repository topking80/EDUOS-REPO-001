# FED-05 — Signed, versioned policy distribution, acknowledgements and rollback

Status: built into Master Control, plus a receiving page in each district's EduOS. EduOS checks and keeps bundles but **applies nothing yet**: district settings don't change.

Code:
- Signing and checking: `eduos/src/federation/policy-bundle.js`.
- Master Control: `eduos/src/master-control/app.js` (release, promote, rollback, bundle and acknowledgement routes) and migration `eduos/db/master-control/003_policy_distribution.sql`.
- EduOS: `eduos/src/policy-bundle-routes.js` and migration `eduos/db/157_master_control_policy_bundles.sql`.

Tests: `eduos/test/policy-bundle.test.js`, the FED-05 cases in `eduos/test/integration/master-control.test.js`, and `eduos/test/integration/policy-bundles.test.js`.

## Releases

A **release** is made at a platform or state node by someone holding `policy.distribute` there. That is a new capability: platform operator and state oversight; never delegable; never held by a district.

When a release is made:
- Master Control resolves the effective value of every policy (FED-02 inheritance: locks, restrict-only, district-reserved) for **each active district below the node**, as of the release's start date.
- It stores that snapshot, so every district in the release gets exactly what was decided that day.
- Releases can't start in the past.

**Pilot first (optional):**
- Choose pilot districts; they get their bundles at once, and the rest wait.
- **Promoting** to the remaining districts requires every pilot to have **accepted** its bundle.
- An objection or no answer blocks promotion. The distributor can override only with a written note, which is audited with the pilots that hadn't accepted.

## Bundles

Each district gets its own **bundle**: `eduos-policy-bundle-1`, canonical JSON signed with Ed25519. It carries:
- the release and its kind (release or rollback);
- the district's node, name and **tenant reference** (its EduOS district ID);
- the issuer;
- the start date;
- the catalog version;
- every policy's value, where it came from, any lock, and the chain of settings applied.

**Versions:**
- A district's version only goes up (1, 2, 3, …).
- Each bundle records the SHA-256 of the district's previous bundle.
- Bundles and acknowledgements are append-only.

**The signing key:**
- It's derived from `MC_POLICY_SIGNING_SECRET` (or `MC_POLICY_SIGNING_SECRET_FILE`; at least 32 characters). Releases are refused until it's set.
- Master Control shows the public key and its fingerprint (`GET /mc/api/policy-signing-key`, and on the console's release card). Give the public key to districts through a trusted channel.

## Acknowledgements

The **district answers for itself**: only someone holding `policy.set` at the district (its superintendent) can accept or object, and an objection needs a note. Distributors can't answer for a district. The latest answer counts. The console shows each district's bundles, with download, Accept and Object.

## Rollback

Rolling back a release creates a **new release** (kind `rollback`) for every district that received the bad one:
- Each district is re-issued the content of the bundle it had before, under a higher version. A district with nothing earlier gets an empty bundle.
- The original release is marked rolled back and can't be rolled back twice.
- Policy settings in Master Control are left as they are. Fix the setting before the next release, or the next release will carry it again.

## In the district's EduOS

- **Configuration:** set `MC_POLICY_PUBLIC_KEY` to Master Control's public key (base64 SPKI or PEM).
- **Upload and checks:** on **Data links**, the superintendent uploads a bundle file. EduOS checks, in order:
  1. the signature, against that key (refusing altered files and other keys);
  2. that it's addressed to **this** district (tenant reference = the district's ID);
  3. that its version is newer than any already received.
- **The same file again** opens the same record.
- **Skipped versions:** a gap (versions skipped) is accepted and flagged.
- **Shown:** the superintendent and IT administrator see the latest version's policies (with locks), who issued it and who received it.
- **Not applied:** nothing is applied, and district settings are unchanged.
- **Records:** bundles are append-only and audited.

## Not in this slice

- Applying policies inside EduOS. That needs a mapping from each policy to the district setting it governs, and a decision about which ones apply automatically.
- EduOS fetching bundles on its own; today a person downloads and uploads them, as with history transfers.
- Signing-key rotation with overlapping trust.
- Policy definitions beyond the catalog.
