// STATE-01: the state index and educators' licenses (db/107, src/state-index-data.js).
//
//   GET  /api/states                          every state: how many checked entries per category
//   GET  /api/states/:code                    one state's index: curated + this district's entries
//   PUT  /api/district/state                  the district's state (superintendent)
//   POST /api/states/:code/entries            add a district entry with its source (superintendent)
//   POST /api/state-entries/:id/retire        retire one (superintendent)
//
//   GET  /api/licenses/mine                   my licenses, days to expiry
//   POST /api/licenses                        record one (self-reported)
//   PUT  /api/licenses/:id                    change mine (it needs verifying again)
//   POST /api/licenses/:id/retire             retire mine
//   GET  /api/licenses?expiringWithin=90      people's licenses: superintendent (district), principal (their school)
//   POST /api/licenses/:id/verify             superintendent: verified / not_verified, with a note
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { CATEGORIES, JURISDICTIONS, STATE_NAME, ENTRIES, NATIONAL, curatedFor } from "./state-index-data.js";

const EDUCATORS = ["teacher", "principal", "vice_principal", "superintendent", "coach", "librarian", "counselor"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = d => typeof d === "string" && DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
const https = u => { try { const x = new URL(u); return x.protocol === "https:" && !x.username && !x.password && u.length <= 500; } catch { return false; } };
const daysLeft = d => d ? Math.round((Date.parse(`${(d instanceof Date ? d.toISOString() : d).slice(0, 10)}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 864e5) : null;
const ymd = d => d instanceof Date ? d.toISOString().slice(0, 10) : d;
const licenseOut = l => ({ id: l.id, userId: l.user_id, name: l.name, stateCode: l.state_code, state: STATE_NAME[l.state_code] || l.state_code, number: l.license_number,
  type: l.license_type, endorsements: l.endorsements, issuedOn: ymd(l.issued_on), expiresOn: ymd(l.expires_on), daysLeft: daysLeft(l.expires_on),
  status: l.status, verifiedBy: l.verified_by_name, verifiedAt: l.verified_at, note: l.verify_note });

function parseLicense(b) {
  const ok = typeof b.stateCode === "string" && STATE_NAME[b.stateCode] && cleanText(b.number, 40) && cleanText(b.type, 120)
    && (b.endorsements == null || b.endorsements === "" || cleanText(b.endorsements, 300))
    && (b.issuedOn == null || b.issuedOn === "" || validDate(b.issuedOn)) && (b.expiresOn == null || b.expiresOn === "" || validDate(b.expiresOn));
  if (!ok) return null;
  const issued = b.issuedOn || null, expires = b.expiresOn || null;
  if (issued && expires && expires < issued) return null;
  return [b.stateCode, b.number.trim(), b.type.trim(), b.endorsements?.trim() || null, issued, expires];
}

export function registerStateRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const only = roles => (req, res, next) => roles.includes(req.actor?.role) ? next() : res.status(403).json({ error: "forbidden" });
  const run = (fn, ok = 200) => async (req, res, next) => {
    try { const out = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(ok).json({ data: out }); }
    catch (e) { sendError(res, next, e); }
  };

  // ---------- the index (everyone signed in can read it) ----------
  app.get("/api/states", requireSession, run(async (c, req) => {
    const mine = await one(c, `SELECT state_code FROM district_state_settings WHERE district_id=$1`, [req.actor.districtId]);
    const local = await rows(c, `SELECT state_code,category,count(*)::int AS n FROM district_state_entries WHERE retired_at IS NULL GROUP BY 1,2`);
    return { districtState: mine?.state_code || null, categories: CATEGORIES,
      states: JURISDICTIONS.map(([code, name]) => {
        const counts = Object.fromEntries(Object.keys(CATEGORIES).map(k => [k, (ENTRIES[code] || []).filter(e => e.category === k).length + (local.find(l => l.state_code === code && l.category === k)?.n || 0)]));
        return { code, name, counts, complete: Object.values(counts).every(n => n > 0) };
      }) };
  }));

  app.get("/api/states/:code", requireSession, run(async (c, req) => {
    const code = String(req.params.code || "").toUpperCase();
    if (!STATE_NAME[code]) throw new HttpError(404, "state_not_found");
    const local = await rows(c, `SELECT e.id,e.category,e.title,e.url,e.description,e.source_url,e.verified_on,u.display_name AS added_by FROM district_state_entries e
        JOIN users u ON u.id=e.added_by WHERE e.state_code=$1 AND e.retired_at IS NULL ORDER BY e.category,e.title`, [code]);
    const entries = [...curatedFor(code).map(e => ({ ...e, from: e.scope === "national" ? "national" : "eduos" })),
      ...local.map(e => ({ id: e.id, category: e.category, title: e.title, url: e.url, description: e.description, source: e.source_url, checked: ymd(e.verified_on), from: "district", addedBy: e.added_by }))];
    return { code, name: STATE_NAME[code], categories: CATEGORIES,
      sections: Object.entries(CATEGORIES).map(([key, label]) => ({ key, label, entries: entries.filter(e => e.category === key) })) };
  }));

  app.put("/api/district/state", limiter, requireSession, requireCsrf, only(["superintendent"]), run(async (c, req) => {
    const code = req.body?.stateCode;
    if (!STATE_NAME[code]) throw new HttpError(400, "invalid_state");
    await c.query(`INSERT INTO district_state_settings(district_id,state_code,updated_by) VALUES($1,$2,$3)
        ON CONFLICT(district_id) DO UPDATE SET state_code=EXCLUDED.state_code,updated_by=EXCLUDED.updated_by,updated_at=now()`, [req.actor.districtId, code, req.actor.userId]);
    await audit(c, req, "update", "district_state", req.actor.districtId, code);
    return { stateCode: code };
  }));

  app.post("/api/states/:code/entries", limiter, requireSession, requireCsrf, only(["superintendent"]), run(async (c, req) => {
    const code = String(req.params.code || "").toUpperCase(), b = req.body || {};
    if (!STATE_NAME[code] || !CATEGORIES[b.category] || !cleanText(b.title, 160) || !https(b.url) || (b.description != null && b.description !== "" && !cleanText(b.description, 1000))
        || (b.sourceUrl != null && b.sourceUrl !== "" && !https(b.sourceUrl)) || !validDate(b.verifiedOn) || b.verifiedOn > new Date().toISOString().slice(0, 10))
      throw new HttpError(400, "invalid_state_entry");
    const e = await one(c, `INSERT INTO district_state_entries(district_id,state_code,category,title,url,description,source_url,verified_on,added_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [req.actor.districtId, code, b.category, b.title.trim(), b.url, b.description?.trim() || null, b.sourceUrl || null, b.verifiedOn, req.actor.userId]);
    await audit(c, req, "create", "state_entry", e.id, `${code}/${b.category}`);
    return e;
  }, 201));

  app.post("/api/state-entries/:id/retire", limiter, requireSession, requireCsrf, only(["superintendent"]), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const e = await one(c, `UPDATE district_state_entries SET retired_at=now(),retired_by=$2 WHERE id=$1 AND retired_at IS NULL RETURNING id`, [req.params.id, req.actor.userId]);
    if (!e) throw new HttpError(404, "entry_not_found");
    await audit(c, req, "retire", "state_entry", e.id, null);
    return { retired: true };
  }));

  // ---------- licenses ----------
  app.get("/api/licenses/mine", requireSession, only(EDUCATORS), run(async (c, req) =>
    (await rows(c, `SELECT l.*,v.display_name AS verified_by_name FROM educator_licenses l LEFT JOIN users v ON v.id=l.verified_by
       WHERE l.user_id=$1 AND l.retired_at IS NULL ORDER BY l.expires_on NULLS LAST`, [req.actor.userId])).map(licenseOut)));

  app.post("/api/licenses", limiter, requireSession, requireCsrf, only(EDUCATORS), run(async (c, req) => {
    const v = parseLicense(req.body || {});
    if (!v) throw new HttpError(400, "invalid_license");
    const l = await one(c, `INSERT INTO educator_licenses(district_id,user_id,state_code,license_number,license_type,endorsements,issued_on,expires_on)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [req.actor.districtId, req.actor.userId, ...v]);
    await audit(c, req, "create", "educator_license", l.id, l.state_code);
    return licenseOut(l);
  }, 201));

  app.put("/api/licenses/:id", limiter, requireSession, requireCsrf, only(EDUCATORS), run(async (c, req) => {
    const v = parseLicense(req.body || {});
    if (!validId(req.params.id) || !v) throw new HttpError(400, "invalid_license");
    const l = await one(c, `UPDATE educator_licenses SET state_code=$3,license_number=$4,license_type=$5,endorsements=$6,issued_on=$7,expires_on=$8
        WHERE id=$1 AND user_id=$2 AND retired_at IS NULL RETURNING *`, [req.params.id, req.actor.userId, ...v]);
    if (!l) throw new HttpError(404, "license_not_found");
    await audit(c, req, "update", "educator_license", l.id, `status=${l.status}`);
    return licenseOut(l);
  }));

  app.post("/api/licenses/:id/retire", limiter, requireSession, requireCsrf, only(EDUCATORS), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const l = await one(c, `UPDATE educator_licenses SET retired_at=now() WHERE id=$1 AND user_id=$2 AND retired_at IS NULL RETURNING id`, [req.params.id, req.actor.userId]);
    if (!l) throw new HttpError(404, "license_not_found");
    await audit(c, req, "retire", "educator_license", l.id, null);
    return { retired: true };
  }));

  app.get("/api/licenses", requireSession, only(["superintendent", "principal"]), run(async (c, req) => {
    const within = Number(req.query.expiringWithin);
    const days = Number.isInteger(within) && within >= 0 && within <= 3650 ? within : null;
    const status = ["self_reported", "verified", "not_verified"].includes(req.query.status) ? req.query.status : null;
    const list = await rows(c, `SELECT l.*,u.display_name AS name,v.display_name AS verified_by_name FROM educator_licenses l JOIN users u ON u.id=l.user_id
        LEFT JOIN users v ON v.id=l.verified_by WHERE l.retired_at IS NULL AND ($1::int IS NULL OR (l.expires_on IS NOT NULL AND l.expires_on <= current_date + $1::int))
          AND ($2::text IS NULL OR l.status=$2) ORDER BY l.expires_on NULLS LAST,u.display_name LIMIT 1000`, [days, status]);
    await audit(c, req, "read", "educator_licenses", null, `n=${list.length}`);
    return list.map(licenseOut);
  }));

  app.post("/api/licenses/:id/verify", limiter, requireSession, requireCsrf, only(["superintendent"]), run(async (c, req) => {
    const { decision, note = null } = req.body || {};
    if (!validId(req.params.id) || !["verified", "not_verified"].includes(decision) || (note !== null && note !== "" && !cleanText(note, 500))) throw new HttpError(400, "invalid_verification");
    const l = await one(c, `UPDATE educator_licenses SET status=$2,verified_by=$3,verified_at=now(),verify_note=$4 WHERE id=$1 AND retired_at IS NULL RETURNING *`,
      [req.params.id, decision, req.actor.userId, note?.trim() || null]);
    if (!l) throw new HttpError(404, "license_not_found");
    await audit(c, req, "verify", "educator_license", l.id, decision);
    return licenseOut(l);
  }));
}
