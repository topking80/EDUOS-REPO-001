// SPORTS-02: one adapter per vendor. MaxPreps and Hudl can each build out
// their connection here: an adapter module for their own API that exports the
// same four functions. Until a vendor adds one, its adapter speaks the EduOS
// sports sync format (eduos-sports-sync-1, docs/SPORTS-CONNECTORS.md).
//
// Every adapter gets the connector's base URL (already checked to be on the
// vendor's own site) and the school's key, and must:
//   sendRoster(base, key, teamId, athletes)  athletes = opted-in only, [{jersey, firstName, lastName, grade, position}]
//   sendSchedule(base, key, teamId, events)  [{ref, date, startsAt, title, opponent, venue, homeScore, awayScore}]
//   pullResults(base, key, teamId)           → [{ref, opponent, homeScore, awayScore, teamStats}] (team totals only)
//   pullFilm(base, key, teamId)              → [{ref, title, url}] (Hudl links only)
// and throw ConnectorError(msg, "not_offered") for anything the school's
// account doesn't offer, so the school uses what it has.
import * as eduosSync from "../sports-connector.js";
import * as maxpreps from "./maxpreps.js";
import * as hudl from "./hudl.js";

const pick = m => ({ sendRoster: m.sendRoster || eduosSync.sendRoster, sendSchedule: m.sendSchedule || eduosSync.sendSchedule,
  pullResults: m.pullResults || eduosSync.pullResults, pullFilm: m.pullFilm || eduosSync.pullFilm, name: m.ADAPTER || "eduos-sports-sync-1" });
export const ADAPTERS = { maxpreps: pick(maxpreps), hudl: pick(hudl) };
