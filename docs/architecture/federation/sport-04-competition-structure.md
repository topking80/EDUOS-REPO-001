# SPORT-04 — Conferences, leagues, regions, divisions, schedules, results and championships

Status: registry contract plus a tested checker (`eduos/src/federation/competition.js`). The seed collections stay empty until associations' official records are approved. The running app doesn't use this yet; SPORT-05 and the Master Control work connect it.

Tests: `eduos/test/federation-competition.test.js`.

## Collections

| Collection | What it holds |
|---|---|
| `seasons` | One association's season for one activity and school year: dates, end of the regular season, start of the postseason, and the rule version in force |
| `competition_groupings` | Conferences, leagues, regions, districts, sections, divisions and subdivisions. Each records its association, its parent grouping, its activities and levels, whether it's exclusive, and its effective period. Each needs a **recognition by its own association**, citing a governance decision. A grouping can name a classification band (cycle plus classification). |
| `grouping_memberships` | A school in a grouping for one activity and period, on a stated basis: association alignment, classification, conference vote or appeal decision |
| `contests` | A scheduled contest in a season. Schools only (`participant_school_ids`, `home_school_id`), with type (regular season, conference, non-conference, tournament, postseason, championship, scrimmage, invitational), date, status, and an optional grouping, championship or sanction |
| `contest_results` | Versioned results: provisional, official, corrected or vacated. Outcomes are recorded per school (win, loss, tie, forfeit, placement), with an optional score. |
| `championships` | An association's championship for a season and activity, with optional classification and division, format, qualification rule version and entry limit |
| `championship_entries` | Schools entered, with seed, status, placement and how they qualified |

**No student data.** Every participant is a member school, identified by an opaque school ID. No collection has a field for an athlete, a student or a person (a test checks the schema). Athlete eligibility and participation stay in the district's education tenant (SPORT-05 handles any exchange).

## Rules the checker enforces

1. **The association owns its structure.**
   - A grouping must be recognized by the association it belongs to, through that association's governance decision. Once a grouping is recognized or active, that decision must be approved.
   - A parent grouping belongs to the same association, the hierarchy can't loop, and a child's activities stay within its parent's.
   - A grouping with a classification band cites a classification cycle of the same association.
2. **Competition groupings are not education districts.** An association's "district" is a competition grouping. Belonging to one never changes a school's education tenant or district administration.
3. **Only member schools take part.**
   - A school in a grouping, a contest or a championship must hold an **active membership** (FED-01C) in that association, for that activity, on that date.
   - The exception is a contest covered by an **approved event sanction** from the same association (SPORT-03); an invitational always needs one.
4. **Classification is respected.**
   - A school in a grouping inside a classification band (its own or inherited from a parent) must hold an assigned or final classification matching that band in that cycle.
   - A classified championship takes only schools classified for it.
5. **Exclusive groupings don't overlap.** A school can't be in two exclusive groupings of the same type, association and activity in overlapping periods (for example two football districts).
6. **Schedules stay inside the rules.**
   - Contests fall within the season, and postseason and championship contests on or after the postseason start.
   - The home school is a participant.
   - A conference contest names the grouping it counts in (not a division, which is a classification band), and every participant is in that grouping on the date.
   - A championship contest names a championship in that season, between entered schools.
7. **Results are versioned and never overwritten.**
   - Only the association makes a result official, and only for a completed or forfeited contest. A provisional result can come from the association or a participant.
   - A correction supersedes an earlier version of the same contest and cites an approved decision. Vacating a result cites an approved decision.
   - There is at most one current official result per contest, and earlier versions stay on record.
   - Outcomes cover exactly the participants. Head-to-head outcomes must agree (win/loss, tie/tie, forfeit win/loss), and scores must match the outcome. Placements in multi-team events are distinct.
8. **Championships are orderly.** Seeds are distinct and no school is entered twice. Entries stay within the limit, and qualification by grouping finish or appeal cites the association's own grouping or approved decision.

`currentResult(registry, contestId)` returns the result that stands. `standings(registry, groupingId, seasonId)` builds wins, losses, ties and win percentage (ties count as half) from current official results:
- forfeits count as wins and losses;
- vacated and unofficial results don't count.

## Not in this slice

- Storage, APIs and screens. Associations would maintain these records through Master Control, under FED-02 authority, with audit.
- Automatic alignment or classification calculations; associations decide these.
- Brackets generated from seeds.
- Tie-breaker rules (association-specific; to be referenced as rule versions).
- Officials assignment.
- Athlete-level data of any kind (SPORT-05, purpose-limited exchange with education tenants).
