// 32.4.0 shared helpers for the role-app APIs (transport, Christie, Comms Hub).
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validId = v => typeof v === "string" && UUID_RE.test(v);
export const cleanText = (v, max, min = 1) => typeof v === "string" && v.trim().length >= min && v.trim().length <= max;

/** Append-only audit row inside the caller's tenant transaction. */
export function audit(client, req, action, resourceType, resourceId = null, detail = null, outcome = "success") {
  return client.query(
    `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [req.actor.districtId, req.actor.userId, req.actor.role, action, resourceType, resourceId, outcome,
     detail === null ? null : String(detail).slice(0, 1000), req.requestId]);
}

export const rows = async (client, sql, params = []) => (await client.query(sql, params)).rows;
export const one = async (client, sql, params = []) => (await client.query(sql, params)).rows[0] || null;

/** Thrown inside a transaction to roll back and answer with an HTTP error. */
export class HttpError extends Error {
  constructor(status, code, extra = {}) { super(code); this.status = status; this.code = code; this.extra = extra; }
}
export function sendError(res, next, e) {
  if (e instanceof HttpError) return res.status(e.status).json({ error: e.code, ...e.extra });
  // RLS WITH CHECK violations surface as 42501; report them as forbidden.
  if (e?.code === "42501") return res.status(403).json({ error: "forbidden" });
  return next(e);
}
export const roleIn = (...roles) => (req, res, next) =>
  roles.includes(req.actor?.role) ? next() : res.status(403).json({ error: "role_not_allowed", allowed: roles });
