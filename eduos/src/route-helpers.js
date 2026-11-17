// 37.6.0 shared route helpers (same contract as learning-routes: {data} JSON,
// one tenant transaction per request, Cache-Control: no-store).
import { withTenantTransaction } from "./db.js";
import { sendError, HttpError } from "./role-app-util.js";

export const wrap = fn => async (req, res, next) => {
  try {
    const out = await withTenantTransaction(req.actor, client => fn(client, req, res));
    if (res.headersSent) return;
    res.setHeader("Cache-Control", "no-store");
    res.status(out?.__status || 200).json({ data: out?.__status ? out.data : out });
  } catch (e) {
    if (e?.code === "23505") return res.status(409).json({ error: "already_exists" });
    if (e?.code === "23514" || e?.code === "22P02" || e?.code === "22023" || e?.code === "22007" || e?.code === "22008") return res.status(400).json({ error: "invalid_value" });
    if (e?.code === "P0002") return res.status(404).json({ error: "not_found" });
    sendError(res, next, e);
  }
};
export const created = data => ({ __status: 201, data });
export const need = (cond, status, code, extra) => { if (!cond) throw new HttpError(status, code, extra); };
export const str = (v, max, { min = 1, optional = false } = {}) => {
  if (v === undefined || v === null || v === "") { if (optional) return null; throw new HttpError(400, "missing_field"); }
  if (typeof v !== "string") throw new HttpError(400, "invalid_value");
  const t = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (t.length < min || t.length > max) throw new HttpError(400, "invalid_length", { max });
  return t;
};
export const isoDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z"));
export const isoTime = v => typeof v === "string" && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v);
