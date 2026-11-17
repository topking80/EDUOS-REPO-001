# Credentials Wallet (37.6.0 candidate)

Learners and their guardians can take a credential that a school leader issued
on the EDAL ledger and:

- **download** it as a signed W3C Verifiable Credential (Open Badges 3.0
  `OpenBadgeCredential`), or
- **share** it with a link that they control: the name shows as initials, in
  full, or not at all; the link lasts 1 to `WALLET_SHARE_MAX_DAYS` days (default
  90); they can see how many times it was opened and turn it off at any time.

Anyone can check a credential at `/verify/`, either by opening a share link or
by pasting a downloaded credential. The page shows only the achievement, its
type and description, the school, the issue date and the name as the holder
chose it.

## Who can do what

| Who | Can |
| --- | --- |
| Pupil | See, download and share their own credentials; turn off their links |
| Parent / guardian | The same for each linked child |
| Staff (any role) | Nothing in the Wallet. Issuing and revoking stay in the learning core (`/api/learning/credentials`, school leaders) |
| Anyone with a link | The minimum public view above, while the link is on and unexpired |

Enforced three times: the `wallet:hold` permission (pupil and parent only), row
security on `wallet_shares` (only the learner and linked guardians), and
`SECURITY DEFINER` functions that check the link (`eduos_is_linked_student`).
Every download, link and revocation is written to `audit_events`.

## Signing

- Data Integrity proof, cryptosuite **`eddsa-jcs-2022`** (W3C *Data Integrity
  EdDSA Cryptosuites v1.0*). The signer reproduces the W3C test vector byte for
  byte (`test/wallet-37.6.test.js`).
- One issuer key per school, a `did:key` (Ed25519), **derived** from
  `WALLET_ISSUER_SECRET` with HKDF-SHA256. No private key is stored in the
  database or on disk. Rotating the secret changes every school's DID, so
  credentials signed before the rotation then verify only as `signature_only`
  (signature good, issuer no longer recognised).
- Revocation is checked live: the verify page asks the issuing district whether
  the credential is still active.

## Honest profile statement: this is a PARTIAL profile

- **Not 1EdTech-certified.** The document follows the OB 3.0 data model and
  JSON schema reference, but has not been through 1EdTech conformance.
- **Proof format:** the OB 3.0 examples use `eddsa-rdfc-2022` or VC-JWT. EduOS
  uses `eddsa-jcs-2022`, which is a valid W3C Data Integrity proof, but some
  OB 3.0 wallets may not accept it yet.
- **No `credentialStatus` / status list** and no `refreshService`; revocation
  works only through this EduOS server's verify endpoint.
- **`did:key` issuer**, not a hosted issuer profile (`did:web` or an HTTPS
  profile URL). Verifiers can't fetch a school profile.
- **Name privacy:** with "initials" or "full", the credential carries a salted
  hash of the full name (OB 3.0 `IdentityObject`), so someone who guesses the
  full name can confirm it. With "none", no name and no name hash are included.
- No evidence files. The only evidence is the EDAL entry hash.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `WALLET_ISSUER_SECRET` | unset | 32+ characters. Unset = downloads and links are off (the Wallet tells families so). Keep it in your secret store and back it up. |
| `WALLET_SHARE_MAX_DAYS` | 90 | Longest share link, 1-365 |
| `PUBLIC_VERIFY_RATE_LIMIT_PER_MIN` | 60 | Per-IP limit on the public verify API |

## Data

Migration `058_credentials_wallet.sql`: table `wallet_shares` (only the SHA-256
of each link token is stored), definer functions for the holder's list, export
inputs, public lookup and status, and a FERPA purge step chained in front of
`eduos_purge_student`. The runtime role can create links and set
`revoked_at`/`revoked_by`, but can't delete them.

Note for the public verify API: the share token is in the request path
(`/api/public/wallet/:district/:token`), so access logs that record full paths
will contain it. Tokens can be turned off by the holder at any time.
