# EduOS District Edition 37.7.4

**Release type:** Weather-warning safety fix (fresh review of 37.7.3)
**Base:** 37.7.3 (main at a46157d, after #144 MEDIA-03)
**Status:** Proposed; changes are on `fix/37.7.4-weather-safety`. Not deployed.

## Fixed

- **Two leaders could overwrite each other's decision on a weather warning.**
  `POST /api/safety/weather/:id/dismiss` and `/started` read the alert, checked
  that it was undecided, then ran a separate unconditional `UPDATE`. Two leaders
  acting at the same moment both passed the check and the second write replaced
  the first (both got 200, both were audited). The decision is now claimed with
  one conditional `UPDATE ... WHERE decision IS NULL AND ended_at IS NULL AND
  (expires IS NULL OR expires > now())`; exactly one request wins, the others get
  `409 already_decided`, and only the winning decision is written to the audit log.
- **Ended or expired warnings could still be decided.** The Safety screen hides
  alerts NWS has dropped or that are past their expiry, but the decision routes
  didn't check, so a prompt left open on a screen could still be dismissed or
  linked to a shelter. They now answer `410 alert_ended` or `410 alert_expired`.
  The web app tells the leader "Another leader already decided this warning" or
  "This warning has ended or expired" and removes the prompt.
- **Updated NWS warnings could leave old guidance on screen.** When NWS sent an
  alert again, only the headline and expiry were refreshed; changed instructions,
  area, severity and hazard stayed stale. An NWS `Update` (which comes under a
  new id and references the message it replaces) was recorded as a brand-new
  alert: leaders were alerted twice, and a decision on the original was left on
  an ended row. The parser comment said updates were skipped; they weren't.
  Migration `130_weather_alert_updates.sql` replaces `eduos_weather_record`:
  - every authoritative field (event, level, hazard, severity, headline, area,
    instruction, onset, expires) is refreshed whenever an alert is seen;
  - an `Update` is folded into the alert it references (same alert, new NWS id),
    so the prompt and any decision carry over and leaders aren't alerted again;
  - a `Cancel` ends the alerts it references, even if NWS still lists the
    original beside it.
- **An update to a warning someone already decided:** the decision stays and
  nobody is alerted again. The exception is a *dismissed* warning whose update
  raises the stakes (it becomes a prompting warning it wasn't before, changes
  hazard, or NWS raises its severity, e.g. Moderate to Extreme): the dismissal is
  cleared (the audit log keeps it), the "Start shelter" prompt returns and leaders
  are alerted again. A warning a shelter was already started from keeps that
  link.

## Also

- `express-rate-limit` 8.7.4 → 8.7.5 and `jose` 6.2.17 → 6.2.18 (the same lockfile
  entries as Dependabot PR #122, which is 57 commits behind main; it can be closed
  as superseded once this merges).
- `RELEASE-SECURITY-33.7.md` no longer says the workflow actions are tag-pinned;
  they are pinned to full commit SHAs.

## Tests

- `test/weather-alerts.test.js`: Update messages keep their references; Cancel
  is a marker; unknown message types are treated as Alert.
- `test/integration/safety-nws.test.js` (real PostgreSQL 16, non-owner runtime role):
  three leaders deciding at once (5 rounds) give exactly one 200 and the winner's
  note is kept with one audit record; ended and expired alerts answer 410 for
  dismiss and started; the same id refreshes every field; an Update replaces the
  guidance on the same alert without re-alerting; an update to a dismissed warning
  keeps the dismissal unless severity rises; a Cancel ends the original.
  The six new tests fail on 37.7.3 and pass here.

## Migrations

- `130_weather_alert_updates.sql` (`CREATE OR REPLACE` of `eduos_weather_record`,
  plus the internal helper `eduos_weather_severity_rank`). No table changes, no new
  grants. Numbered 130 because main's latest is 128 and open PR #146 (TC-06a,
  Time Capsule transfer packages) already uses 129. Later branches should take the
  next free number when they rebase.
