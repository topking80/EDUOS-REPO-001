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

## Receiving a file (TC-06b)

The receiving school's records office (principal, a vice principal acting as
one, or the superintendent) uploads the file on the Student history page under
**Records from other districts**. Nothing is added to anyone's history until a
person has done all three steps:

1. **Check who sent it.** The server checks the signature and that nothing was
   changed (an altered or badly signed file is refused). It then shows the
   signing fingerprint in the file. Get the sending district's fingerprint from
   them another way (a phone call to their records office, their letterhead)
   and type it in; a file signed by anyone else won't match. If earlier files
   from the same district had a different fingerprint, the page warns you.
2. **Choose the student.** Local students with the same name or student number
   are suggested; you can search for anyone else your office may choose. The
   file is never matched to a student automatically.
3. **Accept or reject each item** (or accept all, or finish and reject the
   rest). An accepted item is added to the student's history as published, as
   it was saved at the sending district: its kind, date and school year, who
   could see it (family memories and the portfolio stay with the family and
   student), the original author's name, and "from <district>, <school>".
   What its photos showed is kept in the text; the image files aren't
   transferred.

Receiving the same file again opens the same import. An item that already came
in an earlier file for the same student isn't added again. A decision, once
made, stays: an added item can be archived like any other. The file is kept
exactly as received and can be downloaded again; uploads, checks and decisions
are audited.

Another school in the district can't see or take a file one school received;
the district office sees all of them. Nothing here changes grades, enrollment
or any other record.

## Online delivery between districts on the same EduOS (TC-06c)

When both districts run on the same EduOS deployment, the records office can deliver a ready transfer online
instead of downloading the file and sending it.

* **The receiving district opts in.** Its superintendent turns on **Receive online deliveries** under
  Records from other districts. Only districts that have done so are offered as destinations, and a district
  can't deliver to itself.
* **Delivering.** On the student's records page, a ready transfer (the family's decision already made, if one
  was asked for) shows **Deliver online** with the districts that receive. The records office (principal, a
  vice principal acting as one, or the superintendent) delivers it. It's the same signed file a download gives;
  it's logged under "Who looked" for the student and audited in both districts. A transfer is delivered once.
* **Receiving.** The delivery lands in the receiving district's **Records from other districts**, marked
  *online*, for the district office (the superintendent) first, as an upload by them would. Nothing is added to
  any history on delivery. The receiving records office still chooses the student and accepts or rejects each
  item, as in TC-06b. Because EduOS knows which district delivered it, there's **no fingerprint to check** for
  an online delivery. Uploaded files still need the fingerprint.
* **Cancelling.** Cancelling the transfer before the receiver has chosen a student also **withdraws the
  delivery**: the receiver sees it as withdrawn by the sender and can't go on. After that, nothing is recalled
  automatically; tell the receiving district's records office.

**Other deployments.** Deliveries to a district on another EduOS deployment still go as files. The federation
(Master Control) carries aggregate reports only, and this doesn't change that.
