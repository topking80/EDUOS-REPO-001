# HSP-06 (part 3) — School districts in the learner transfer workflow

Status: built (migration `db/169_hsp06c_district_transfers.sql`, routes in `src/learner-transfer-routes.js`).
Extends HSP-06 part 1 (`hsp-06-learner-transfers.md`).

## What changes

Districts can now send records to, and receive records from, homeschool families and private schools,
using the same workflow: prepare, release, one-time code, preview, accept or decline.

**District-to-district moves keep using the signed history transfer (TC-06, `docs/HISTORY-TRANSFER.md`).**
A district asked to receive another district's code is told to use it.

## The district's switch

Nothing happens until the **superintendent** turns transfers on (`PUT /api/transfers/settings`). Turning
them on or off is audited. A district that's off can neither send nor receive.

## Sending

1. The **records office** prepares a transfer for one student:
   - who: the student's principal (or a vice principal acting as one), or the superintendent;
   - what: enrollment (grade, school, enrolled since), posted final grades (the current grade per course: a
     corrected grade replaces the one it supersedes), and attendance totals per school year.
   - Nothing else is sent: no history items, notes, contact details, safety, health or discipline records.
2. A **guardian** linked to the student in the district, with **no open custody restriction**, releases it in
   their parent account and gets the code. Staff can't release it. A guardian named in a custody restriction can't.
3. The guardian gives the code to the homeschool family or private school. A district's records go to a
   family **only if the person accepting there is that student's guardian in the district**.
4. The district's records stay where they are. Nothing is withdrawn or deleted.

The records office can withdraw a transfer until it's decided.

## Receiving

The records office previews a code from a family or private school and either declines it with a reason, or
accepts it **onto a student the district already has, chosen by the records office**. A principal can only
choose students at their school.

Nothing is matched or created automatically: enroll a new child first (the enrollment funnel), then accept.

Received records are read-only, carry their provenance label, and can be voided with a reason. In this slice
only the records office sees them, not teachers.

## Provenance

District records carry: "Issued by *school* in *district*, a school district on EduOS. Not a certified
transcript; ask the district for one."

## Security

- District tables are scoped by `app.district_id`. When a family receives a district's code,
  `eduos_district_guardian()` looks inside that one district for the guardian and custody check, then restores the
  context.
- The receiving district's view of an accepted transfer is limited to that student's records office.
- All writes still go through the `eduos_transfer_*` definer functions. Steps are audited in `audit_events`.
- Fixed in passing: withdrawing a school's or district's transfer before anyone had released it violated a check
  constraint from migration 165. It now works.
