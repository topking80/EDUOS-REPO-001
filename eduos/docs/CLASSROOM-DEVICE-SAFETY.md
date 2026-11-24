# Classroom devices during a safety alert (SAFE-02)

Classroom displays, check-in kiosks and student devices that District IT has
approved and keyed (DEV-01 to DEV-03, ROOM-01) follow a school's safety alert
on their own. Nothing is pushed to them: every poll they already make says what
to show, so a device that was asleep or offline catches up on its next poll.

## What the device asks

Any of these, with the device key (`Authorization: Bearer cdk1.<id>.<secret>`):

| Request | Who uses it | What comes back |
| --- | --- | --- |
| `POST /api/classroom-agent/commands` | displays and student devices that take commands | `{ commands, safety }` |
| `POST /api/classroom-agent/safety` | any device; kiosks and displays without commands | `{ safety }` |
| `POST /api/classroom-agent/checkin-code` | displays and kiosks showing the check-in QR | `{ path: null, paused: true, safety }` during an alert |
| `POST /api/classroom-agent/kiosk-checkin` | check-in kiosks | `{ error: "paused_for_safety", safety }` during an alert |

Poll at least every 10 seconds while running; 5 seconds is better for displays.

## What `safety` means

| `mode` | Displays and kiosks | Student devices |
| --- | --- | --- |
| `normal` | carry on | carry on |
| `dark` (lockdown) | screen off or black, sound off, nothing on screen. A lit screen through a door window gives the room away. Ignore any input. | — |
| `quiet` (lockdown) | — | dim, silent, the short `message` only |
| `alert` (hold, shelter, evacuate, reunification) | full screen: `title` and `message`, sound off | the same as a notice |
| `all_clear` | show `title` / `message` for up to ten minutes, then normal | the same |

`volume: 0` means mute. `title` says when it is a drill. `message` is the
text written for students (never staff instructions, rosters or locations),
because anyone in the room can read the screen.

A device keeps the alert mode until a poll says otherwise. If it can't reach
EduOS while in an alert mode, it stays in that mode.

## What else changes while an alert is live

* Check-in pauses (display code, door QR, kiosk): people stay where they are.
* Teachers' classroom commands are refused (`paused_for_safety`); devices
  follow the alert.
* The principal, vice principals, resource officers and the superintendent
  see on the room board how many screens have switched, and which haven't been
  heard from.

## What this never does

It doesn't lock a student device, open anything on it, show its screen or
record anything in the room. It doesn't contact emergency services. An alert
starts only because a person started it.

## Severe weather and other hazards (SAFE-03)

A shelter or hold can name its hazard (tornado, severe thunderstorm,
lightning, hurricane, flooding, winter storm, extreme heat, earthquake,
hazardous materials). The `safety` object's `title` then names it ("Shelter
in place: Tornado warning") and `message` carries the hazard's student
instructions plus the room's shelter area when one is set ("Shelter area:
Interior hallway B."). Show both in `alert` mode as usual.

The principal (or a vice principal) sets each room's shelter area per hazard,
with a school default, under Rooms & devices → Shelter areas.
