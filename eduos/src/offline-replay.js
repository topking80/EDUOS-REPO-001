// EduOS 32.7.0: phones keep working when the school's uplink (or Wi-Fi) drops.
// A small allow-list of writes (roll call, bus check-ins, attendance) may be
// queued on the phone and replayed later. Replays carry:
//   Idempotency-Key      one per queued write; a second delivery is a no-op
//   X-EduOS-Queued-At    when the adult actually recorded it (ISO 8601)
// Conflict rules: these tables are append-only, so a replay never overwrites
// anything; "latest status" is ordered by when it was OBSERVED
// (coalesce(observed_at, recorded_at)), so a late replay of an older
// observation cannot hide a newer one (e.g. "missing" stays "missing").
const KEY = /^[A-Za-z0-9_-]{16,80}$/;
export const QUEUE_MAX_AGE_MS = 24 * 60 * 60_000;
const FUTURE_SKEW_MS = 2 * 60_000;

export class ReplayError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

/** The queued-at time of a replayed write, or null for a live write. */
export function queuedAt(req, now = Date.now()) {
  const raw = req.get?.("x-eduos-queued-at") ?? req.headers?.["x-eduos-queued-at"];
  if (raw === undefined || raw === null || raw === "") return null;
  const t = Date.parse(String(raw));
  if (!/^\d{4}-\d{2}-\d{2}T/.test(String(raw)) || !Number.isFinite(t)) throw new ReplayError(400, "invalid_queued_at");
  if (t > now + FUTURE_SKEW_MS) throw new ReplayError(400, "queued_at_in_future");
  if (t < now - QUEUE_MAX_AGE_MS) throw new ReplayError(409, "queued_write_too_old");
  return new Date(t);
}
export function idempotencyKey(req) {
  const raw = req.get?.("idempotency-key") ?? req.headers?.["idempotency-key"];
  if (raw === undefined || raw === null || raw === "") return null;
  if (!KEY.test(String(raw))) throw new ReplayError(400, "invalid_idempotency_key");
  return String(raw);
}
/**
 * Claim the replay receipt INSIDE the write's transaction: if the write fails,
 * the claim rolls back with it and the phone can retry. Returns true when this
 * key was already used (the caller answers "duplicate" and writes nothing).
 */
export async function claimReplay(client, req, route, at) {
  const key = idempotencyKey(req);
  if (!key) return false;
  const r = await client.query(
    `INSERT INTO offline_replays(district_id,user_id,idem_key,route,status_code,queued_at) VALUES($1,$2,$3,$4,201,$5)
     ON CONFLICT (user_id,idem_key) DO NOTHING RETURNING idem_key`,
    [req.actor.districtId, req.actor.userId, key, route, at || null]);
  return r.rowCount === 0;
}
