// SPORTS-02: the EduOS sports sync client (format: docs/SPORTS-CONNECTORS.md).
// This is the default adapter for both vendors (src/sports-adapters/); a vendor
// can replace its adapter with one for its own API.
//
// Calls go only to the connector's vendor site over https, with the school's
// key as a bearer token, a 15-second limit, no redirects and at most 1 MB
// back. Answers are checked field by field before anything is stored.
import { serviceLink } from "./sports-sharing.js";

// Tests (never production) may point connectors at a loopback mock.
const TEST_BASE = (process.env.NODE_ENV || "development") !== "production" && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(process.env.SPORTS_CONNECTOR_TEST_BASE || "")
  ? process.env.SPORTS_CONNECTOR_TEST_BASE : "";

/** The connector's base URL if it's on the vendor's site (or the test mock). */
export function connectorBase(service, url) {
  if (TEST_BASE && url === TEST_BASE) return TEST_BASE;
  const u = serviceLink(service, url);
  return u ? u.replace(/\/+$/, "") : null;
}

export class ConnectorError extends Error { constructor(msg, code = "connector_failed") { super(msg); this.code = code; } }

async function call(base, key, method, path, body) {
  let res;
  try {
    res = await fetch(`${base}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new ConnectorError("couldn't reach the service"); }
  const text = await res.text();
  if (text.length > 1_000_000) throw new ConnectorError("answer too large");
  if (res.status === 401 || res.status === 403) throw new ConnectorError("the service refused the key");
  // The school's account doesn't offer this: not an error, the school uses what it has.
  if (res.status === 404 || res.status === 405 || res.status === 501) throw new ConnectorError("not offered by this account", "not_offered");
  if (!res.ok) throw new ConnectorError(`the service answered ${res.status}`);
  try { return text ? JSON.parse(text) : {}; } catch { throw new ConnectorError("the answer wasn't JSON"); }
}
const team = id => `/eduos/v1/teams/${encodeURIComponent(id)}`;

export const sendRoster = (base, key, teamId, athletes) => call(base, key, "PUT", `${team(teamId)}/roster`, { format: "eduos-sports-sync-1", athletes });
export const sendSchedule = (base, key, teamId, events) => call(base, key, "PUT", `${team(teamId)}/schedule`, { format: "eduos-sports-sync-1", events });

const UUID = /^[0-9a-f-]{36}$/i;
const score = v => Number.isInteger(v) && v >= 0 && v <= 999;
const statKey = /^[A-Za-z][A-Za-z0-9 _-]{0,39}$/;

/** Results: [{ref, opponent, homeScore, awayScore, teamStats}] for events we sent (ref = our event id). Team totals only. */
export async function pullResults(base, key, teamId) {
  const r = await call(base, key, "GET", `${team(teamId)}/results`);
  if (!Array.isArray(r?.results)) throw new ConnectorError("no results list");
  return r.results.slice(0, 500).filter(x => UUID.test(x?.ref || "") && typeof x.opponent === "string" && x.opponent.trim().length >= 1 && x.opponent.length <= 120
    && score(x.homeScore) && score(x.awayScore)).map(x => ({ ref: x.ref, opponent: x.opponent.trim(), homeScore: x.homeScore, awayScore: x.awayScore,
      teamStats: Object.fromEntries(Object.entries(x.teamStats && typeof x.teamStats === "object" && !Array.isArray(x.teamStats) ? x.teamStats : {})
        .filter(([k, v]) => statKey.test(k) && typeof v === "number" && Number.isFinite(v)).slice(0, 40)) }));
}

/** Film: [{ref?, title, url}] — Hudl links only. */
export async function pullFilm(base, key, teamId) {
  const r = await call(base, key, "GET", `${team(teamId)}/film`);
  if (!Array.isArray(r?.film)) throw new ConnectorError("no film list");
  return r.film.slice(0, 200).map(f => ({ ref: UUID.test(f?.ref || "") ? f.ref : null, title: typeof f?.title === "string" ? f.title.trim().slice(0, 160) : "", url: serviceLink("hudl", f?.url) }))
    .filter(f => f.title && f.url);
}
