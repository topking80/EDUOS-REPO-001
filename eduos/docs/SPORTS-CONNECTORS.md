# Sports connectors (SPORTS-02)

Schools that already have a **MaxPreps** or **Hudl** account can connect it to
EduOS with the access key (API key or partner token) the vendor issues to that
account. Neither vendor publishes an open API, so EduOS speaks one documented
format, below; a vendor or integration partner that accepts it can connect.
Teams without a connector keep using the roster and schedule files (SPORTS-01).

## For MaxPreps and Hudl: building out the connection

Each vendor has its own adapter in `src/sports-adapters/` (`maxpreps.js`,
`hudl.js`). A vendor builds out its connection by exporting any of these for its
own API (the contract is in `src/sports-adapters/index.js`):

| Function | Does |
| --- | --- |
| `sendRoster(base, key, teamId, athletes)` | Show this roster (opted-in athletes only) |
| `sendSchedule(base, key, teamId, events)` | Show this schedule, with published scores |
| `pullResults(base, key, teamId)` | Return results for events EduOS sent (team totals only) |
| `pullFilm(base, key, teamId)` | Return Hudl film links |

Anything a vendor doesn't export uses the EduOS sports sync format below, so a
vendor can build out one piece at a time. An adapter can't change what EduOS
sends (opted-in athletes only), where it may call (the vendor's own site), or
what happens to what comes back (results wait for the coach). It throws
`ConnectorError(message, "not_offered")` for anything an account doesn't offer.

## For schools: use what your account offers

A school turns on only what its MaxPreps or Hudl account offers. If the account
doesn't offer something (the vendor answers 404, 405 or 501), the sync says
"not offered by this account" for that part and does the rest. Coaches can
always fall back to the roster and schedule files.

## Who does what

| Step | Who |
| --- | --- |
| Enter the site address and key, choose what the connector does | The school's principal, vice principal or athletic director |
| Approve or decline (nothing moves before this) | District IT |
| Pause, resume, revoke | The school's sports leads, or IT |
| Link a team to its team ID on the site, run a sync | The team's coaches (or the school's leaders) |
| Approve results that come back | The team's coaches; approving makes a **draft** result, published the usual way |

Changing the key, the address or what the connector does sends it back to IT.
Keys are encrypted at rest (`INTEGRATIONS_KEY`, bound to the district and the
connector) and never shown again; the app shows the last four characters.

## Rules the connector keeps

* Calls go only to the vendor's own site (`*.maxpreps.com`, `*.hudl.com`) over
  https, with no redirects, a 15-second limit and at most 1 MB back.
* The roster holds only athletes whose family opted in for that service
  (name, jersey, grade, position). Nothing else about a student is sent.
* Results and team stats that come back wait for the coach. Team totals only:
  per-athlete stats are not accepted.
* Film comes back as Hudl links only; EduOS stores no video. A coach can hide a link.
* Every run is logged (who, what, how many, how many left out, errors).

## Format: `eduos-sports-sync-1`

All requests carry `Authorization: Bearer <key>`. `{team}` is the team's ID on
the vendor's site, as the coach entered it.

### Send the roster — `PUT {base}/eduos/v1/teams/{team}/roster`

```json
{ "format": "eduos-sports-sync-1",
  "athletes": [{ "jersey": 9, "firstName": "Alice", "lastName": "A", "grade": "10", "position": "Forward" }] }
```

The list is the whole roster to show; athletes not in it should be removed.

### Send the schedule — `PUT {base}/eduos/v1/teams/{team}/schedule`

```json
{ "format": "eduos-sports-sync-1",
  "events": [{ "ref": "<EduOS event id>", "date": "2026-09-05", "startsAt": "2026-09-05T22:00:00.000Z",
               "title": "Home opener", "opponent": "Central", "venue": "Main field", "homeScore": 3, "awayScore": 1 }] }
```

`opponent` and the scores are `null` until a result is published in EduOS.

### Bring results in — `GET {base}/eduos/v1/teams/{team}/results`

```json
{ "results": [{ "ref": "<EduOS event id>", "opponent": "Central", "homeScore": 3, "awayScore": 1,
                "teamStats": { "shots": 12, "corners": 5 } }] }
```

Only results for events EduOS sent (`ref`), and not already published, are kept.
`teamStats`: up to 40 numeric team totals.

### Bring film in (Hudl) — `GET {base}/eduos/v1/teams/{team}/film`

```json
{ "film": [{ "ref": "<EduOS event id or null>", "title": "Home opener — full game", "url": "https://www.hudl.com/video/..." }] }
```
