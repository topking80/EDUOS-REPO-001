# EduOS District Edition 37.7.4

**Release type:** Weather-warning safety, completing the fresh review of 37.7.3
**Base:** 37.7.3 (main at 3bde47d, after #145 SAFE-05)
**Status:** Proposed; changes are on `fix/37.7.4-weather-safety-r3`. Not deployed.

## Already on main from #145 (SAFE-05, migration 131)

- Weather-warning decisions are claimed with one conditional `UPDATE ... WHERE
  decision IS NULL AND ended_at IS NULL AND (expires IS NULL OR expires > now())`;
  the loser gets `409 already_decided`, an ended or expired alert `410
  alert_no_longer_active`. The audit record is written only after a successful
  claim, so a losing request leaves none.
- When NWS sends the same alert id again, every field is refreshed.

## Fixed in 37.7.4

- **NWS Update messages became duplicate alerts.** An `Update` arrives under a
  new id and lists the message it replaces in `references`. EduOS ignored the
  references, so each update was recorded as a new alert: leaders were alerted
  again, a second "Start shelter" prompt appeared, and a decision on the
  original was left on an ended row. Migration `133_weather_alert_updates.sql`
  folds an update into the alert it replaces (same alert, new NWS id, every
  authoritative field refreshed: event, level, hazard, severity, headline, area,
  instruction, onset, expires) and ends any other alerts it replaces.
- **NWS Cancel messages were dropped.** An original NWS still listed beside its
  Cancel stayed active. A Cancel now ends the alerts it references.
- **Parser comment** said updates were skipped; it now describes what happens.
- **An update to a warning someone already decided:** the decision stays and
  nobody is alerted again. Exception: a *dismissed* warning whose update raises the
  stakes (it becomes a prompting warning it wasn't, changes hazard, or NWS raises
  its severity, e.g. Moderate to Extreme). The dismissal is cleared (the audit log
  keeps it), the prompt returns and leaders are alerted again. A warning a shelter
  was already started from keeps that link.
- **Web app:** a dismiss that loses the race or hits an ended/expired warning now
  says "Another leader already decided this warning" or "This warning has ended or
  expired" and removes the stale prompt, instead of "Couldn't dismiss it."
- `RELEASE-SECURITY-33.7.md` no longer says the workflow actions are tag-pinned;
  they are pinned to full commit SHAs.

## Tests

- `test/weather-alerts.test.js`: Updates keep their references; a Cancel is a
  marker; unknown message types count as Alert.
- `test/integration/safety-nws.test.js` (real PostgreSQL, non-owner runtime role),
  alongside #145's two tests: three leaders at once for five rounds (one 200, the
  winner's note kept, exactly one audit record); dismiss *and* started refused on
  ended and expired alerts with no decision or audit written; an Update replaces
  the guidance on the same alert without re-alerting; the decided-alert rule; a
  Cancel ends the original even when still listed.

## Migrations

- `133_weather_alert_updates.sql`: `CREATE OR REPLACE` of `eduos_weather_record`
  (replacing 131's version) plus the internal helper `eduos_weather_severity_rank`.
  No table changes, no new grants. 132 and 134 are used by open Time Capsule
  branches (`tc/08-archival-storage-v2`, `tc/11-family-storage-dashboard`); later
  branches should take 135 or higher.
