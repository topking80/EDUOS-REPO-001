// Hash-chained audit log for Master Control decisions.
import crypto from "node:crypto";

export const GENESIS = "0".repeat(64);

/** Canonical JSON: sorted keys, no whitespace. */
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
const FIELDS = ["at", "actor", "action", "target_type", "target_id", "node_id", "capability", "decision", "reason", "basis", "detail"];
export function entryHash(prevHash, e) {
  const body = Object.fromEntries(FIELDS.map(k => [k, k === "at" ? new Date(e.at).toISOString() : (e[k] ?? null)]));
  return crypto.createHash("sha256").update(`${prevHash}\n${canonical(body)}`).digest("hex");
}

/** Append one entry inside the caller's (serialized) transaction. */
export async function appendAudit(c, e) {
  const { rows: [last] } = await c.query("SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1");
  const prev = last?.hash || GENESIS;
  const at = new Date(Math.floor(Date.now() / 1000) * 1000); // whole seconds: stable through timestamptz
  const entry = { ...e, at };
  const hash = entryHash(prev, entry);
  const { rows: [row] } = await c.query(`INSERT INTO audit_log(at, actor, action, target_type, target_id, node_id, capability, decision, reason, basis, detail, prev_hash, hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING seq`,
    [at, e.actor, e.action, e.target_type, e.target_id ?? null, e.node_id ?? null, e.capability ?? null, e.decision, e.reason ?? null,
      e.basis === undefined ? null : JSON.stringify(e.basis), e.detail === undefined ? null : JSON.stringify(e.detail), prev, hash]);
  return { seq: Number(row.seq), hash };
}

/** Walk the whole chain. Returns {ok, entries, brokenAt?}. */
export async function verifyAudit(db) {
  const { rows } = await db.query("SELECT * FROM audit_log ORDER BY seq");
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || entryHash(prev, r) !== r.hash) return { ok: false, entries: rows.length, brokenAt: Number(r.seq) };
    prev = r.hash;
  }
  return { ok: true, entries: rows.length, head: prev };
}
