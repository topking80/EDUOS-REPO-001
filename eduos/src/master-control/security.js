// FED-08: security operations for Master Control.
//   * the signing key registry: the key in use, keys retired by rotation,
//     and revoked keys Master Control refuses to sign with again;
//   * incident freezes on exchanges;
//   * security alerts, computed from the hash-chained audit log and state.
import { verifyAudit } from "./audit.js";
import { withinNode } from "./model.js";

export class KeyRevokedError extends Error {
  constructor(fingerprint) { super("policy_key_revoked"); this.code = "policy_key_revoked"; this.fingerprint = fingerprint; }
}

/**
 * Register the configured policy signing key before it signs anything, and
 * refuse it if it was revoked. A key not seen before becomes the active one
 * and retires the previous one (a rotation).
 */
export async function registerSigningKey(c, keys) {
  const { rows: [row] } = await c.query("SELECT status FROM signing_keys WHERE fingerprint=$1 FOR UPDATE", [keys.fingerprint]);
  if (row?.status === "revoked") throw new KeyRevokedError(keys.fingerprint);
  if (row?.status === "active") return { rotated: false };
  await c.query("UPDATE signing_keys SET status='retired', retired_at=now() WHERE purpose='policy' AND status='active'");
  if (row) await c.query("UPDATE signing_keys SET status='active', retired_at=NULL WHERE fingerprint=$1", [keys.fingerprint]);
  else await c.query("INSERT INTO signing_keys(fingerprint, purpose, public_key) VALUES ($1,'policy',$2)", [keys.fingerprint, keys.public]);
  return { rotated: true };
}

/** Open incidents that freeze exchanges touching any of these nodes. */
export async function freezingIncident(q, m, nodeIds) {
  const { rows } = await q.query("SELECT id, node_id FROM incidents WHERE status='open' AND freeze_exchange ORDER BY opened_at");
  return rows.find(r => nodeIds.some(n => n && withinNode(m.nodes, r.node_id, n))) || null;
}

/**
 * Alerts, most severe first. `threshold`: denied decisions by one operator
 * within the last hour that count as an alert.
 */
export async function securityAlerts(db, { currentFingerprint = null, threshold = 10 } = {}) {
  const alerts = [];
  const chain = await verifyAudit(db);
  if (!chain.ok) alerts.push({ severity: "critical", kind: "audit_chain_broken", detail: chain });
  if (currentFingerprint) {
    const { rows: [k] } = await db.query("SELECT status FROM signing_keys WHERE fingerprint=$1", [currentFingerprint]);
    if (k?.status === "revoked") alerts.push({ severity: "critical", kind: "revoked_key_configured", detail: { fingerprint: currentFingerprint } });
  }
  const { rows: denials } = await db.query(`SELECT actor, count(*)::int AS n FROM audit_log
     WHERE decision='denied' AND at > now() - interval '1 hour' GROUP BY actor HAVING count(*) >= $1 ORDER BY 2 DESC`, [threshold]);
  for (const d of denials) alerts.push({ severity: "high", kind: "repeated_denials", detail: { actor: d.actor, lastHour: d.n } });
  const { rows: incidents } = await db.query("SELECT id, node_id, severity, freeze_exchange, opened_at FROM incidents WHERE status='open' ORDER BY opened_at");
  for (const i of incidents) alerts.push({ severity: i.severity === "critical" || i.severity === "high" ? "high" : "info", kind: "open_incident",
    detail: { id: i.id, nodeId: i.node_id, severity: i.severity, freezeExchange: i.freeze_exchange, openedAt: i.opened_at } });
  const order = { critical: 0, high: 1, info: 2 };
  return alerts.sort((a, b) => order[a.severity] - order[b.severity]);
}
