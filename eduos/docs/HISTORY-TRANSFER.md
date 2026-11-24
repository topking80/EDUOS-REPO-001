# Sending a student's history to another district (TC-06)

When a student moves to another district, the school's records office can send
the student's eligible history as a **signed file**. A person makes the file
and sends it through the district's usual records channel; a person at the new
district checks and accepts it (TC-06b). Nothing is sent automatically.

## Who and what

* **Starts a transfer:** the school's principal (or a vice principal), or the
  superintendent, with the receiving district's name and the basis: an
  enrollment request from the new district, a records request, a family
  request, or another stated reason.
* **Always included (records office authority):** published official records,
  teacher items and milestones.
* **Only if the family agrees:** family memories and the student's own
  portfolio. The student decides once they hold their own record rights (TC-05);
  before that, a guardian with access does (not one under a custody
  restriction). If they decline, only the school records go.
* **Never included:** private items, drafts, anything withdrawn or restricted,
  other students' items. Photos are listed by their descriptions; image files
  aren't included.

## The file

`eduos-history-transfer-1`: canonical JSON listing the sending district and
school, the receiving district, the basis, the student's name, local student
number and grade, and each item as it was saved (with its source id and
revision), signed with Ed25519. The key is derived from
`HISTORY_TRANSFER_SIGNING_SECRET` (or `PORTFOLIO_SIGNING_SECRET`; at least 32
characters); no private key is stored. Transfers stay off until it's set.

The items are fixed when the transfer is ready, so the file (and its SHA-256)
is the same every time it's downloaded. Every download is logged under "Who
looked" for the student, the family and the records office, and audited.

The records page shows the district's **signing fingerprint**. Give it to the
receiving district through a separate channel (phone, letterhead) so they can
confirm the file came from you.

Cancelling a transfer (with a reason) stops further downloads. A copy already
sent can't be recalled; tell the receiving district.
