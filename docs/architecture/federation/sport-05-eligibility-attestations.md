# SPORT-05 — Athlete eligibility attestations for a state athletic association

Status: built in EduOS. A school's athletic director certifies a team's eligibility to the state athletic association in a signed attestation. Each athlete is included only if a parent or guardian agreed, with the least that verification needs. The association reads it with its own access token while the district's agreement is in force, and every read is logged.

Code:
- Contract (build, sign, verify): `eduos/src/federation/eligibility.js`.
- Routes: `eduos/src/association-attestation-routes.js`.
- Storage and the association's access function: `eduos/db/159_athletic_association_attestations.sql`.
- Screens: **Athletic associations** on Data links (superintendent); **Certify to the athletic association** under a team's eligibility (athletic director); **Eligibility and the athletic association** for families.

Tests: `eduos/test/eligibility-attestation.test.js` and `eduos/test/integration/association-attestations.test.js`.

## What leaves, and what doesn't

| In an attestation | Never in it |
|---|---|
| The athlete's name and grade | Student ID, local student number, date of birth, contact details |
| A reference per athlete per agreement (an HMAC, so the association can follow an athlete across attestations, but two associations can't link their lists) | Grades, courses, percentages |
| The status on the date: eligible, not eligible, or pending (not enough records to decide) | Attendance, reasons, the rule that wasn't met |
| School, team, district, the district rule version, the athletic director's name | Health, physicals, jersey, position |
| How many rostered athletes were withheld (no consent) | Who was withheld |

The status comes from the district's own academic and attendance rules (37.6.0 sports eligibility), computed when the athletic director certifies. The association applies its own rules (age, transfer, semesters) itself; the attestation says so.

## The steps

1. **The superintendent approves an agreement** with the association: its ID, name, legal basis and end date.
   - EduOS shows the association's **access token once**. Only its SHA-256 is kept.
   - The superintendent can replace the token, after which the old one stops working, or revoke the agreement.
2. **Families agree, per athlete and per agreement.** A family sees exactly what would be shared. Saying no later **withdraws every unexpired attestation that lists that athlete**.
3. **The athletic director certifies a team.** This is the school's athletic director only, not the coach.
   - The result is a snapshot dated today, valid for 1 to 30 days (14 by default).
   - It's signed with the district's EduOS exchange key (`EXCHANGE_SIGNING_SECRET`, FED-06) and kept as issued.
   - The athletic director can withdraw it with a reason.
4. **The association reads** with `Authorization: Bearer <agreement id>.<token>`:
   - `GET /api/association/attestations`: current attestations, and the public key that signs them;
   - `GET /api/association/attestations/:id`: one signed file. The association checks it with `verifyAttestation`, which reports altered, wrong key, expired or not yet valid.

   Reads work only while the agreement is active and today is within its dates. Withdrawn or expired attestations can't be read.
5. **Every association request is logged** (`association_reads`, append-only), allowed or denied, with the reason. Only the access function can write to it. The superintendent sees recent reads on the agreement.

## Governance

- No vendor or association gets general access. It reads only attestations made under its agreement, only for consented athletes, only while the agreement is in force, and every read is logged.
- No data goes to a third party without the superintendent's agreement and a family's consent.
- No grades are changed or shared, and RLS and school boundaries are unchanged. The association's access goes through one `SECURITY DEFINER` function that checks the token, the agreement's dates and status, and the attestation's state.
- Nothing here claims compliance with any association rule or law. The legal basis is what the superintendent records.

## Not in this slice

- Association-side screens or storage. The association uses the API and the verify function, or its own system.
- Master Control involvement. Identifiable data stays in the district's EduOS (the FED-02 rule).
- Transfer and hardship eligibility decisions (the association's).
- Sending attestations automatically.
