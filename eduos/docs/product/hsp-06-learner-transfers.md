# HSP-06 (part 1) — Controlled learner transfers

Status: built (migration `db/165_hsp06_learner_transfers.sql`, routes `src/learner-transfer-routes.js`).
Part 2, compliance profiles (jurisdiction templates, instructional-hour tracking, reminders, checklists,
family retention settings), is the next PR. District transfers are not part of this slice.

## The workflow

Nothing transfers on its own. A person on each side acts, the sender's records stay where they are, and
identities are never merged: the receiver gets a **new** learner with the records attached.

1. **Prepare.** The sender picks one learner, what to send and why (enrolling there, records request,
   returning to homeschool, other).
   - A homeschool family: an adult with **full** authority over the learner. Sections: courses and final
     grades, attendance (yearly totals), work and scores.
   - A private school: the school admin or registrar of a **verified** school. Sections: enrollment dates and
     grade, **published** report cards, attendance (yearly totals).
   - Never sent: private notes, daily attendance, goals, drafts, billing, guardian or contact details.
   - The snapshot is frozen when it's prepared (hashed, and a trigger refuses any change to it).
2. **Release.** A family's transfer is released by preparing it. A school's transfer waits for a
   **guardian with full authority** at that school to release it.
3. **Code.** The releaser gets a one-time code (shown once, valid 14 days; only its SHA-256 is stored) and
   gives it to the receiver themselves. EduOS doesn't look up or contact the receiver.
4. **Receive.** The receiver enters the code, previews exactly what was sent, and accepts or declines
   with a reason.
   - A family: its owner. A school's records go to a family **only if the person accepting holds a
     full-authority guardian link to that learner at the school**.
   - A private school: the school admin or registrar of a verified school, choosing a campus.
   - The same family or school can't receive its own transfer.
5. **Correct.** Received records are read-only. The receiver can void one with a reason; nothing can edit them.
6. **Withdraw.** The sender can withdraw a transfer until it's accepted or declined. A decided transfer is final.

## Provenance

Every received record carries the label it was sent with:

- From a family: "Entered by the *name* homeschool family. Not verified by EduOS or any agency."
- From a school: "Issued by *name* (*legal name*), a private school verified by the platform on *date*.
  Not an accreditation or a government record."

## Who sees what

| | Sees the transfer | Sees the records received |
|---|---|---|
| Sending family: adults with full authority over the learner | yes, with where it went | — |
| Sending school: admin, registrar, full-authority guardians of the learner | yes | — |
| Receiving family owner / receiving school admin and registrar | once decided | yes (school staff who can see that learner, and family adults with authority over them) |
| Anyone else, other tenants, districts | no | no |

The runtime role can only read these tables (column-level, so the code's hash is hidden); every change
goes through the `eduos_transfer_*` definer functions, which re-check the session's context and role.

## Audit

Prepare, release, withdraw, accept, decline and corrections are written to the acting tenant's audit trail
(`family_audit_events` or `private_school_audit_events`).

## Governance

- No automatic transfers: acceptance is explicit, and nothing is withdrawn or deleted at the sender.
- No unapproved sharing: the sender chooses the fields, a guardian releases a school's records, and the code
  goes only where the releaser sends it.
- No compliance claims: provenance labels say what the records are and aren't.
