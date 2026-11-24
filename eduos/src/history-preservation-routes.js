// TC-08: preserving student history (db/131).
//
// The records office (principal / vice principal for their school, the superintendent for all):
//   GET  /api/history/preservation               policy, capacity per school (counts, no names), integrity, recent problems
//   GET  /api/students/:id/legal-holds           holds on one student
//   POST /api/students/:id/legal-holds           {reason, matterRef?}: place a hold
// Superintendent:
//   PUT  /api/history/preservation-policy        {verifyEveryDays, archiveAfterDays|null, capacityAlertPercent, recordsScheduleRef}
//   GET  /api/history/legal-holds                every active hold in the district
//   POST /api/legal-holds/:id/release            {note}
//
// A hold keeps everything about the student: items can't be withdrawn for
// deletion, photos aren't released from storage, and Time Capsules aren't
// released until it is lifted. Donations play no part in any limit here.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { audit, rows, one, validId, HttpError, sendError } from "./role-app-util.js";
import { historyMedia } from "./history-media-routes.js";

const OFFICE = ["principal", "vice_principal", "superintendent"];
const PG_ERRORS = { P0002: 404, "55000": 409, "42501": 403, "22023": 400 };
const DEFAULT_POLICY = { verifyEveryDays: 90, archiveAfterDays: null, capacityAlertPercent: 80, recordsScheduleRef: "" };
const policyOut = p => p ? { verifyEveryDays: p.verify_every_days, archiveAfterDays: p.archive_after_days, capacityAlertPercent: p.capacity_alert_percent,
  recordsScheduleRef: p.records_schedule_ref, setAt: p.set_at } : DEFAULT_POLICY;
const holdOut = h => ({ id: h.id, student: h.student_name ? { id: h.student_id, name: h.student_name } : undefined, school: h.school_name, reason: h.reason,
  matterRef: h.matter_ref, placedBy: h.placed_by_name, placedAt: h.placed_at, releasedBy: h.released_by_name || null, releasedAt: h.released_at, releaseNote: h.release_note });
const HOLDS_SQL = `SELECT h.*,st.display_name AS student_name,s.name AS school_name,p.display_name AS placed_by_name,r.display_name AS released_by_name
    FROM history_legal_holds h JOIN students st ON st.id=h.student_id JOIN schools s ON s.id=h.school_id
    JOIN users p ON p.id=h.placed_by LEFT JOIN users r ON r.id=h.released_by`;
const PROBLEM_TEXT = { mismatch: "failed its integrity check", missing: "is missing from storage", archive_failed: "couldn't move to archive storage" };

export function registerHistoryPreservationRoutes(app, providers = historyMedia()) {
  const storageReady = Boolean(providers.storage);
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `hp:${req.actor?.userId}` });
  const only = roles => (req, res, next) => roles.includes(req.actor?.role) ? next() : res.status(403).json({ error: "forbidden" });
  const run = (fn, ok = 200) => async (req, res, next) => {
    try { const out = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(ok).json({ data: out }); }
    catch (e) {
      const status = PG_ERRORS[e?.code];
      if (!(e instanceof HttpError) && status) return res.status(status).json({ error: /^[a-z_]+$/.test(e.message || "") ? e.message : "invalid_request" });
      sendError(res, next, e);
    }
  };

  app.get("/api/history/preservation", requireSession, only(OFFICE), run(async (c, req) => {
    const policy = await one(c, `SELECT * FROM district_history_preservation_policies WHERE district_id=$1`, [req.actor.districtId]);
    const media = await one(c, `SELECT max_bytes_per_student FROM district_history_media_policies WHERE district_id=$1`, [req.actor.districtId]);
    const schools = (await rows(c, `SELECT * FROM eduos_history_capacity_report()`)).map(r => ({ schoolId: r.school_id, school: r.school_name,
      studentsWithMedia: Number(r.students_with_media), usedBytes: Number(r.used_bytes), archiveBytes: Number(r.archive_bytes),
      nearLimit: Number(r.near_limit), atLimit: Number(r.at_limit), activeHolds: Number(r.active_holds),
      integrity: { unverified: Number(r.unverified), ok: Number(r.verified), mismatch: Number(r.mismatch), missing: Number(r.missing) } }));
    const problems = await rows(c, `SELECT e.kind,e.at,s.name AS school FROM history_preservation_events e LEFT JOIN schools s ON s.id=e.school_id
       WHERE e.district_id=$1 AND e.kind IN ('mismatch','missing','archive_failed') ORDER BY e.at DESC LIMIT 20`, [req.actor.districtId]);
    const last = await one(c, `SELECT max(verified_at) AS at FROM private_media_objects WHERE district_id=$1 AND purpose='history'`, [req.actor.districtId]);
    await audit(c, req, "read", "history_preservation", req.actor.districtId, null);
    return { policy: policyOut(policy), canEdit: req.actor.role === "superintendent", storageReady,
      archiveStorageClass: config.historyArchiveStorageClass || null, maxBytesPerStudent: Number(media?.max_bytes_per_student ?? 262144000),
      lastCheckedAt: last?.at || null, schools,
      problems: problems.map(p => ({ kind: p.kind, school: p.school, at: p.at, text: `A photo${p.school ? ` at ${p.school}` : ""} ${PROBLEM_TEXT[p.kind]}` })),
      donationsAffectLimits: false };
  }));

  app.put("/api/history/preservation-policy", limiter, requireSession, requireCsrf, only(["superintendent"]), run(async (c, req) => {
    const b = req.body || {};
    const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
    if (!int(b.verifyEveryDays, 7, 365) || !(b.archiveAfterDays === null || int(b.archiveAfterDays, 30, 3650)) || !int(b.capacityAlertPercent, 50, 99)
        || typeof (b.recordsScheduleRef ?? "") !== "string" || (b.recordsScheduleRef ?? "").length > 300)
      throw new HttpError(400, "invalid_preservation_policy");
    if (b.archiveAfterDays !== null && !config.historyArchiveStorageClass) throw new HttpError(409, "archive_storage_class_not_configured");
    const row = await one(c, `INSERT INTO district_history_preservation_policies(district_id,verify_every_days,archive_after_days,capacity_alert_percent,records_schedule_ref,set_by)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (district_id) DO UPDATE SET verify_every_days=EXCLUDED.verify_every_days,archive_after_days=EXCLUDED.archive_after_days,
        capacity_alert_percent=EXCLUDED.capacity_alert_percent,records_schedule_ref=EXCLUDED.records_schedule_ref,set_by=EXCLUDED.set_by,set_at=now() RETURNING *`,
      [req.actor.districtId, b.verifyEveryDays, b.archiveAfterDays, b.capacityAlertPercent, (b.recordsScheduleRef ?? "").trim(), req.actor.userId]);
    await audit(c, req, "set", "history_preservation_policy", req.actor.districtId, JSON.stringify(policyOut(row)));
    return policyOut(row);
  }));

  app.get("/api/students/:id/legal-holds", requireSession, only(OFFICE), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const s = await one(c, `SELECT id,display_name FROM students WHERE id=$1 AND eduos_records_office(school_id)`, [req.params.id]);
    if (!s) throw new HttpError(404, "student_not_found");
    const holds = await rows(c, `${HOLDS_SQL} WHERE h.student_id=$1 ORDER BY h.placed_at DESC`, [s.id]);
    return { student: { id: s.id, name: s.display_name }, onHold: holds.some(h => !h.released_at), canRelease: req.actor.role === "superintendent", holds: holds.map(holdOut) };
  }));

  app.post("/api/students/:id/legal-holds", limiter, requireSession, requireCsrf, only(OFFICE), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const matter = req.body?.matterRef == null ? null : typeof req.body.matterRef === "string" ? req.body.matterRef.trim() : undefined;
    if (reason.length < 5 || reason.length > 500 || matter === undefined || (matter && matter.length > 120)) throw new HttpError(400, "invalid_legal_hold", { hint: "reason: 5 to 500 characters; matter reference: up to 120" });
    const id = (await one(c, `SELECT eduos_history_hold_place($1,$2,$3) AS id`, [req.params.id, reason, matter])).id;
    await audit(c, req, "place", "history_legal_hold", id, `student=${req.params.id}`);
    return { id };
  }, 201));

  app.get("/api/history/legal-holds", requireSession, only(["superintendent"]), run(async c =>
    (await rows(c, `${HOLDS_SQL} WHERE h.released_at IS NULL ORDER BY h.placed_at DESC LIMIT 500`)).map(holdOut)));

  app.post("/api/legal-holds/:id/release", limiter, requireSession, requireCsrf, only(["superintendent"]), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (note.length < 5 || note.length > 500) throw new HttpError(400, "invalid_release_note");
    const released = (await one(c, `SELECT eduos_history_hold_release($1,$2) AS ok`, [req.params.id, note])).ok;
    if (released) await audit(c, req, "release", "history_legal_hold", req.params.id, null);
    return { released };
  }));
}
