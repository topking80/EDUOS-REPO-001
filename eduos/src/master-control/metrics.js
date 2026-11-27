// FED-09: Master Control gauges for its /mc/metrics. Counts and ages only:
// no operator, node, agreement or student is named, so labels stay bounded.
import { verifyAudit } from "./audit.js";

const g = (name, help, samples, type = "gauge") => [`# HELP mc_${name} ${help}`, `# TYPE mc_${name} ${type}`, ...samples.map(([l, v]) => `mc_${name}${l} ${v}`)];
const byLabel = (rows, key, values) => values.map(v => [`{${key}="${v}"}`, Number(rows.find(r => r[key] === v)?.n || 0)]);

export async function federationGauges(db, { signingFingerprint = null } = {}) {
  const lines = [];
  const chain = await verifyAudit(db);
  lines.push(...g("audit_chain_ok", "Whether the audit hash chain verifies (1) or is broken (0).", [["", chain.ok ? 1 : 0]]),
    ...g("audit_entries", "Entries in the audit log.", [["", chain.entries]]));
  const { rows: dec } = await db.query("SELECT decision, count(*)::int AS n FROM audit_log WHERE at > now() - interval '1 hour' GROUP BY 1");
  lines.push(...g("audit_decisions_last_hour", "Decisions recorded in the last hour, by outcome.", byLabel(dec, "decision", ["allowed", "denied", "rejected"])));
  const { rows: [top] } = await db.query("SELECT coalesce(max(n), 0)::int AS n FROM (SELECT count(*) AS n FROM audit_log WHERE decision='denied' AND at > now() - interval '1 hour' GROUP BY actor) x");
  lines.push(...g("audit_max_denials_per_operator_last_hour", "The most refusals any one operator had in the last hour.", [["", top.n]]));
  const { rows: inc } = await db.query("SELECT severity, count(*)::int AS n FROM incidents WHERE status='open' GROUP BY 1");
  lines.push(...g("incidents_open", "Open security incidents, by severity.", byLabel(inc, "severity", ["low", "moderate", "high", "critical"])));
  const { rows: [fz] } = await db.query("SELECT count(*)::int AS n FROM incidents WHERE status='open' AND freeze_exchange");
  lines.push(...g("incidents_freezing_exchange", "Open incidents freezing exchanges.", [["", fz.n]]));
  let keyStatus = signingFingerprint ? "unused" : "unconfigured";
  if (signingFingerprint) keyStatus = (await db.query("SELECT status FROM signing_keys WHERE fingerprint=$1", [signingFingerprint])).rows[0]?.status || "unused";
  lines.push(...g("signing_key_status", "Status of the configured policy signing key (1 for the current status).",
    ["active", "retired", "revoked", "unused", "unconfigured"].map(v => [`{status="${v}"}`, v === keyStatus ? 1 : 0])));
  const { rows: [ack] } = await db.query(`SELECT count(*)::int AS n, coalesce(extract(epoch FROM now() - min(b.issued_at)), 0) AS oldest
      FROM policy_bundles b WHERE NOT EXISTS (SELECT 1 FROM policy_acknowledgements a WHERE a.bundle_id = b.id)
       AND b.version = (SELECT max(version) FROM policy_bundles x WHERE x.district_node_id = b.district_node_id)`);
  lines.push(...g("policy_bundles_unacknowledged", "Districts whose newest policy bundle has no answer yet.", [["", ack.n]]),
    ...g("policy_bundle_oldest_unacknowledged_seconds", "How long the oldest unanswered newest bundle has waited.", [["", Number(ack.oldest).toFixed(0)]]));
  const { rows: xa } = await db.query("SELECT status, count(*)::int AS n FROM exchange_agreements GROUP BY 1");
  lines.push(...g("exchange_agreements", "Exchange agreements, by status.", byLabel(xa, "status", ["proposed", "active", "revoked"])));
  const { rows: [xd] } = await db.query("SELECT count(*)::int AS n FROM exchange_deliveries WHERE delivered_at > now() - interval '1 day'");
  lines.push(...g("exchange_deliveries_last_day", "Exchange deliveries accepted in the last day.", [["", xd.n]]));
  const { rows: [ss] } = await db.query("SELECT count(*)::int AS n FROM sessions WHERE expires_at > now()");
  lines.push(...g("sessions_active", "Signed-in operator sessions.", [["", ss.n]]));
  const { rows: idp } = await db.query("SELECT status, count(*)::int AS n FROM identity_providers GROUP BY 1");
  lines.push(...g("identity_providers", "Trusted identity providers, by status.", byLabel(idp, "status", ["active", "suspended", "retired"])));
  return lines;
}

/** Read at most once per ttlMs; on failure report mc_federation_up 0. */
export function cachedGauges(read, { ttlMs = 30000, now = Date.now, log = console } = {}) {
  let value = null, at = -Infinity, inflight = null;
  return async () => {
    if (value && now() - at < ttlMs) return value;
    inflight ??= (async () => {
      try { value = [...g("federation_up", "Whether Master Control's state could be read (1) or not (0).", [["", 1]]), ...await read()]; }
      catch (e) { log.warn?.(`master control gauges unavailable: ${e.message}`); value = g("federation_up", "Whether Master Control's state could be read (1) or not (0).", [["", 0]]); }
      at = now(); inflight = null; return value;
    })();
    return inflight;
  };
}
