// FED-09: federation gauges for EduOS's /metrics. Counts of districts only:
// no district, school or person is named, so labels stay bounded.
import { mcKeyRing } from "./federation/key-ring.js";
import { rulesFrom, residencyStatus } from "./jurisdiction-rules.js";

const today = () => new Date().toISOString().slice(0, 10);

/** Lines for the federation gauges, from eduos_federation_status() rows (or null if unreadable). */
export function renderFederationMetrics(rows, { ring = mcKeyRing(), location = process.env.EDUOS_DATA_LOCATION } = {}) {
  const g = (name, help, samples) => [`# HELP eduos_federation_${name} ${help}`, `# TYPE eduos_federation_${name} gauge`, ...samples.map(([l, v]) => `eduos_federation_${name}${l} ${v}`)];
  const out = [
    ...g("trusted_keys", "Master Control signing keys this server trusts (MC_POLICY_PUBLIC_KEY, less revoked ones).", [["", ring.keys.length]]),
    ...g("revoked_keys", "Master Control signing keys listed as revoked (MC_POLICY_REVOKED_KEYS).", [["", ring.revoked.size]]),
    ...g("status_up", "Whether district federation status could be read (1) or not (0).", [["", rows ? 1 : 0]]),
  ];
  if (!rows) return out;
  const residency = { met: 0, not_met: 0, undeclared: 0 };
  let none = 0, current = 0, holds = 0, consent = 0, revokedNewest = 0, oldest = 0;
  for (const r of rows) {
    if (r.newest_revoked) revokedNewest++;
    if (r.newest_age_seconds != null) oldest = Math.max(oldest, Number(r.newest_age_seconds));
    if (!r.has_bundle) { none++; residency.met++; continue; } // defaults: no restriction
    current++;
    const rules = rulesFrom(r.policies || [], { jurisdictionId: r.jurisdiction_id || null });
    if (rules.legalHold) holds++;
    if (rules.consentRequired) consent++;
    residency[residencyStatus(rules, location).status]++;
  }
  out.push(
    ...g("districts", "Districts by whether a policy bundle is in effect.", [['{bundle="in_effect"}', current], ['{bundle="none"}', none]]),
    ...g("legal_hold_districts", "Districts under a legal hold.", [["", holds]]),
    ...g("consent_required_districts", "Districts whose exchanges need a recorded consent.", [["", consent]]),
    ...g("residency_districts", "Districts by data residency status against the declared hosting location.", Object.entries(residency).map(([k, v]) => [`{status="${k}"}`, v])),
    ...g("newest_bundle_revoked_key_districts", "Districts whose newest received bundle was signed with a revoked key.", [["", revokedNewest]]),
    ...g("oldest_newest_bundle_seconds", "Across districts with bundles, the age of the stalest newest bundle.", [["", oldest.toFixed(0)]]));
  return out;
}

/** Read and render, at most once per ttlMs. */
export function federationMetrics(query, { ttlMs = 30000, now = Date.now, log = console } = {}) {
  let value = null, at = -Infinity, inflight = null;
  return async () => {
    if (now() - at < ttlMs && value) return value;
    inflight ??= (async () => {
      const ring = mcKeyRing();
      let rows = null;
      try { rows = (await query("SELECT * FROM eduos_federation_status($1, $2::text[])", [today(), [...ring.revoked]])).rows; }
      catch (e) { log.warn?.(`federation status unavailable: ${e.message}`); }
      value = renderFederationMetrics(rows, { ring }); at = now(); inflight = null;
      return value;
    })();
    return inflight;
  };
}
