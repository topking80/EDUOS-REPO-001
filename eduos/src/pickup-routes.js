// 32.5.0 car pick-up verification.
//   guardians   manage authorized adults for their own children (the school
//               approves), get pick-up passes (a code + QR), request early
//               dismissal, and see their children's pick-up log.
//   staff       (principal or teacher at the school) verify a pass, look at
//               the adult's photo ID, and release. A do-not-release flag
//               blocks the release and alerts the office; a custody order
//               must be acknowledged first.
//   leads       approve adults, manage restrictions, approve early dismissals.
// Only a hash of each pass code is stored. ID checks are a person looking at
// an ID card: no photo, scan, face data or document number is collected.
import rateLimit from "express-rate-limit";
import QRCode from "qrcode";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { enqueueNotifications } from "./notify.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { newPassCode, normalizePassCode, hashPassCode, releaseDecision } from "./safety-model.js";

/** QR modules as rows of "0"/"1" (the app draws them as SVG; no image upload/CSP change). */
export function qrRows(text) {
  const m = QRCode.create(text, { errorCorrectionLevel: "M" }).modules;
  const out = [];
  for (let r = 0; r < m.size; r++) { let line = ""; for (let c = 0; c < m.size; c++) line += m.data[r * m.size + c] ? "1" : "0"; out.push(line); }
  return out;
}

/** Today's queue from the ordered event log: waiting = verified since the last
 * release and not refused since; released = the latest release per learner. */
export function queueFrom(events) {
  const state = new Map();
  for (const e of events) {
    const st = state.get(e.student_id) || { waiting: null, released: null };
    if (e.event === "verified") st.waiting = e;
    else if (e.event === "released") { st.released = e; st.waiting = null; }
    else st.waiting = null;
    state.set(e.student_id, st);
  }
  const all = [...state.values()];
  return { waiting: all.filter(s => s.waiting).map(s => s.waiting), released: all.filter(s => s.released).map(s => s.released).sort((a, b) => new Date(b.at) - new Date(a.at)) };
}

const firstName = n => String(n || "").split(/\s+/)[0];
// Leads of the CALLER's school (families: the session school). Parents with
// children at several schools are scoped by the session school.
const leadsOf = async (client) => (await rows(client, `SELECT user_id FROM eduos_school_leads()`)).map(r => r.user_id);
const guardiansOf = async (client, studentId) => (await rows(client, `SELECT user_id FROM eduos_pickup_guardians($1)`, [studentId])).map(r => r.user_id);

async function lookup(client, code) {
  const norm = normalizePassCode(code);
  if (!norm) return null;
  const list = await rows(client, `SELECT * FROM eduos_pickup_lookup($1)`, [hashPassCode(norm)]);
  return list.length ? list : null;
}
const liveIncident = (client, schoolId) => one(client, `SELECT id,status,kind,is_drill FROM safety_incidents WHERE school_id=$1 AND status IN ('active','reunification')`, [schoolId]);

export function registerPickupRoutes(app) {
  const verifyLimiter = rateLimit({ windowMs: 60_000, limit: config.pickupVerifyRateLimit, standardHeaders: true, legacyHeaders: false });
  const limiter = rateLimit({ windowMs: 60_000, limit: config.safetyRateLimit, standardHeaders: true, legacyHeaders: false });
  const staffOnly = (req, res, next) => ["principal", "teacher"].includes(req.actor?.role) ? next() : res.status(403).json({ error: "school_staff_only" });

  // ---------------- families ----------------
  app.get("/api/pickup/family", requireSession, requirePermission("pickup", "request"), async (req, res, next) => {
    const a = req.actor;
    try {
      const data = await withTenantTransaction(a, async client => {
        const kids = await rows(client, `SELECT s.id,s.display_name,s.grade_level,s.school_id,sc.name AS school_name FROM students s JOIN schools sc ON sc.id=s.school_id
            JOIN student_user_links l ON l.student_id=s.id WHERE l.user_id=$1 AND l.status='active' AND l.relationship IN ('parent','guardian') ORDER BY s.display_name`, [a.userId]);
        for (const k of kids) {
          await client.query(`SELECT eduos_pickup_ensure_guardian($1)`, [k.id]);
          k.adults = await rows(client, `SELECT pa.id,pa.full_name,pa.relationship,pa.kind,pa.status,pa.user_id=$2 AS is_me,pa.decision_note,
                (SELECT json_build_object('id',t.id,'hint',t.code_hint,'expiresAt',t.expires_at) FROM pickup_tags t
                  WHERE t.adult_id=pa.id AND t.revoked_at IS NULL AND t.expires_at>now() ORDER BY t.issued_at DESC LIMIT 1) AS pass
              FROM pickup_adults pa WHERE pa.student_id=$1 AND pa.status<>'revoked' ORDER BY pa.kind,pa.full_name`, [k.id, a.userId]);
          k.earlyDismissals = await rows(client, `SELECT e.id,e.dismissal_date,to_char(e.dismissal_time,'HH24:MI') AS time,e.reason,e.status,pa.full_name AS adult_name
              FROM pickup_early_dismissals e JOIN pickup_adults pa ON pa.id=e.adult_id WHERE e.student_id=$1 AND e.dismissal_date>=eduos_school_today(e.school_id)
              ORDER BY e.dismissal_date,e.dismissal_time`, [k.id]);
          k.log = await rows(client, `SELECT e.event,e.at,pa.full_name AS adult_name,pa.relationship FROM pickup_events e LEFT JOIN pickup_adults pa ON pa.id=e.adult_id
              WHERE e.student_id=$1 AND e.event IN ('released') ORDER BY e.at DESC LIMIT 10`, [k.id]);
        }
        await audit(client, req, "read", "pickup_family", null, `children=${kids.length}`);
        return { children: kids };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/pickup/adults", limiter, requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor;
    if (!["parent", "principal", "superintendent"].includes(a.role)) return res.status(403).json({ error: "role_not_allowed" });
    const { studentId, fullName, relationship } = req.body || {};
    if (!validId(studentId) || !cleanText(fullName, 120, 2) || !cleanText(relationship, 40)) return res.status(400).json({ error: "invalid_adult" });
    try {
      const out = await withTenantTransaction(a, async client => {
        const s = await one(client, `SELECT id,school_id,display_name FROM students WHERE id=$1`, [studentId]);
        if (!s) throw new HttpError(404, "student_not_found");
        const isLead = a.role !== "parent";
        const row = await one(client, `INSERT INTO pickup_adults(district_id,school_id,student_id,full_name,relationship,kind,status,requested_by,decided_by,decided_at)
            VALUES($1,$2,$3,$4,$5,'authorized',$6,$7,$8,$9) RETURNING id,status`,
          [a.districtId, s.school_id, s.id, fullName.trim(), relationship.trim(), isLead ? "approved" : "pending", a.userId, isLead ? a.userId : null, isLead ? new Date() : null]);
        await audit(client, req, "create", "pickup_adult", row.id, `status=${row.status}`);
        if (!isLead) await enqueueNotifications(client, { districtId: a.districtId, schoolId: s.school_id, recipients: await leadsOf(client), kind: "pickup",
          title: "A family added a pick-up adult to approve", body: `For ${firstName(s.display_name)}. Review in Pick-up.`, refType: "pickup_adult", refId: row.id });
        return row;
      });
      res.status(201).json({ data: out });
    } catch (e) {
      if (e?.code === "23505") return res.status(409).json({ error: "adult_already_listed" });
      sendError(res, next, e);
    }
  });

  app.post("/api/pickup/adults/:id/revoke", limiter, requireSession, requireCsrf, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_adult_id" });
    if (!["parent", "principal", "superintendent"].includes(req.actor.role)) return res.status(403).json({ error: "role_not_allowed" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const row = await one(client, `SELECT id,kind,user_id FROM pickup_adults WHERE id=$1 AND status IN ('pending','approved')`, [req.params.id]);
        if (!row) throw new HttpError(404, "adult_not_found");
        if (row.kind === "guardian" && req.actor.role === "parent") throw new HttpError(409, "guardian_row_managed_by_school");
        await client.query(`UPDATE pickup_tags SET revoked_at=now() WHERE adult_id=$1 AND revoked_at IS NULL`, [row.id]);
        await client.query(`UPDATE pickup_adults SET status='revoked' WHERE id=$1`, [row.id]);
        await audit(client, req, "revoke", "pickup_adult", row.id);
        return { id: row.id, status: "revoked" };
      });
      res.json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  // A pass for an approved adult. Issuing a new one revokes the old one.
  app.post("/api/pickup/tags", limiter, requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor;
    if (!["parent", "principal", "superintendent"].includes(a.role)) return res.status(403).json({ error: "role_not_allowed" });
    const { adultId, days } = req.body || {};
    if (!validId(adultId) || (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 30))) return res.status(400).json({ error: "invalid_pass_request" });
    try {
      const out = await withTenantTransaction(a, async client => {
        const adult = await one(client, `SELECT id,school_id,kind,status,full_name,user_id FROM pickup_adults WHERE id=$1`, [adultId]);
        if (!adult) throw new HttpError(404, "adult_not_found");
        if (adult.status !== "approved") throw new HttpError(409, "adult_not_approved");
        const valid = days ?? (adult.kind === "guardian" ? 30 : 1);
        await client.query(`UPDATE pickup_tags SET revoked_at=now() WHERE adult_id=$1 AND revoked_at IS NULL`, [adult.id]);
        const code = newPassCode();
        const norm = normalizePassCode(code);
        const t = await one(client, `INSERT INTO pickup_tags(district_id,school_id,adult_id,code_hash,code_hint,issued_by,expires_at)
            VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(days=>$7)) RETURNING id,expires_at`,
          [a.districtId, adult.school_id, adult.id, hashPassCode(norm), norm.slice(-2), a.userId, valid]);
        await audit(client, req, "issue", "pickup_tag", t.id, `adult=${adult.id};days=${valid}`);
        return { id: t.id, code, qr: qrRows(code), expiresAt: t.expires_at, adultName: adult.full_name, note: "Shown once. EduOS keeps only a fingerprint of this code." };
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/pickup/early-dismissals", limiter, requireSession, requireCsrf, requirePermission("pickup", "request"), async (req, res, next) => {
    const a = req.actor;
    const { studentId, adultId, date, time, reason } = req.body || {};
    if (!validId(studentId) || !validId(adultId) || !/^\d{4}-\d\d-\d\d$/.test(date || "") || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || "") || !cleanText(reason, 200))
      return res.status(400).json({ error: "invalid_early_dismissal" });
    try {
      const out = await withTenantTransaction(a, async client => {
        const adult = await one(client, `SELECT id,school_id,student_id,status FROM pickup_adults WHERE id=$1 AND student_id=$2`, [adultId, studentId]);
        if (!adult || adult.status !== "approved") throw new HttpError(409, "adult_not_approved");
        const ok = await one(client, `SELECT $1::date >= eduos_school_today($2) AND $1::date <= eduos_school_today($2) + 60 AS ok`, [date, adult.school_id]);
        if (!ok?.ok) throw new HttpError(400, "date_out_of_range");
        const row = await one(client, `INSERT INTO pickup_early_dismissals(district_id,school_id,student_id,adult_id,dismissal_date,dismissal_time,reason,requested_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,status`, [a.districtId, adult.school_id, studentId, adultId, date, time, reason.trim(), a.userId]);
        await audit(client, req, "create", "pickup_early_dismissal", row.id);
        await enqueueNotifications(client, { districtId: a.districtId, schoolId: adult.school_id, recipients: await leadsOf(client), kind: "pickup",
          title: "Early dismissal request", body: `${date} at ${time}. Review in Pick-up.`, refType: "pickup_early_dismissal", refId: row.id });
        return row;
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/pickup/early-dismissals/:id/cancel", limiter, requireSession, requireCsrf, requirePermission("pickup", "request"), async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    try {
      const n = await withTenantTransaction(req.actor, async client => {
        const r = await client.query(`UPDATE pickup_early_dismissals SET status='cancelled' WHERE id=$1 AND status IN ('requested','approved') RETURNING id`, [req.params.id]);
        if (r.rowCount) await audit(client, req, "cancel", "pickup_early_dismissal", req.params.id);
        return r.rowCount;
      });
      if (!n) return res.status(404).json({ error: "not_found" });
      res.json({ data: { status: "cancelled" } });
    } catch (e) { sendError(res, next, e); }
  });

  // ---------------- district/school release accountability ----------------
  // A scoped, read-only daily ledger for principals and district leaders.
  app.get("/api/pickup/accountability", requireSession, requirePermission("pickup", "manage"), async (req, res, next) => {
    const a = req.actor;
    const schoolId = a.role === "principal" ? a.schoolId : (validId(req.query.schoolId) ? req.query.schoolId : null);
    if (!schoolId) return res.status(400).json({ error: "school_id_required" });
    try {
      const data = await withTenantTransaction(a, async client => {
        const school = await one(client, `SELECT id,name,timezone FROM schools WHERE id=$1 AND district_id=$2`, [schoolId, a.districtId]);
        if (!school) throw new HttpError(404, "school_not_found");
        if (a.role === "principal" && a.schoolId !== school.id) throw new HttpError(403, "school_scope_denied");
        const totals = await one(client, `SELECT
            count(*) FILTER (WHERE event='released')::int AS released,
            count(*) FILTER (WHERE event='verified')::int AS verified,
            count(*) FILTER (WHERE event='denied')::int AS denied,
            count(*) FILTER (WHERE event='blocked')::int AS blocked,
            count(DISTINCT student_id) FILTER (WHERE event='released')::int AS learners_released
          FROM pickup_events WHERE district_id=$1 AND school_id=$2
            AND service_date=eduos_school_today($2)`, [a.districtId, school.id]);
        const events = await rows(client, `SELECT e.id,e.event,e.at,e.reason,s.display_name AS student_name,
            pa.full_name AS adult_name,pa.relationship,u.display_name AS recorded_by
          FROM pickup_events e JOIN students s ON s.id=e.student_id AND s.district_id=e.district_id
          LEFT JOIN pickup_adults pa ON pa.id=e.adult_id AND pa.district_id=e.district_id
          LEFT JOIN users u ON u.id=e.recorded_by
          WHERE e.district_id=$1 AND e.school_id=$2 AND e.service_date=eduos_school_today($2)
          ORDER BY e.at DESC LIMIT 100`, [a.districtId, school.id]);
        await audit(client, req, "read", "pickup_accountability", school.id, `events=${events.length}`);
        return { school: { id: school.id, name: school.name }, totals, events };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // ---------------- staff on pick-up duty ----------------
  app.get("/api/pickup/queue", requireSession, requirePermission("pickup", "verify"), staffOnly, async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const today = await rows(client, `SELECT * FROM eduos_pickup_today()`);
        const early = (await rows(client, `SELECT * FROM eduos_pickup_early_today()`)).map(e => ({ ...e, time: e.dismissal_time }));
        const incident = await liveIncident(client, req.actor.schoolId);
        const map = r => ({ studentId: r.student_id, name: r.display_name, grade: r.grade_level, adult: r.adult_name, relationship: r.relationship, at: r.at, by: r.by_name, reason: r.reason, reunification: Boolean(r.incident_id) });
        const { waiting, released } = queueFrom(today);
        return { waiting: waiting.map(map), released: released.map(map),
          blocked: today.filter(t => t.event === "blocked").length, denied: today.filter(t => t.event === "denied").length, earlyDismissals: early,
          incident: incident ? { status: incident.status, kind: incident.kind, isDrill: incident.is_drill } : null };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // Step 1: check the pass. Logs "verified" (queue) or "blocked"/"denied".
  app.post("/api/pickup/verify", verifyLimiter, requireSession, requireCsrf, requirePermission("pickup", "verify"), staffOnly, async (req, res, next) => {
    const a = req.actor;
    try {
      const out = await withTenantTransaction(a, async client => {
        const found = await lookup(client, req.body?.code);
        if (!found) {
          await audit(client, req, "verify", "pickup_tag", null, "unknown_pass", "failure");
          throw new HttpError(404, "unknown_pass");
        }
        const incident = await liveIncident(client, a.schoolId);
        const today = (await one(client, `SELECT eduos_school_today($1) AS d`, [a.schoolId])).d;
        const students = [];
        for (const row of found) {
          const d = releaseDecision(row, { incidentStatus: incident?.status });
          const early = d.ok ? await one(client, `SELECT id,to_char(dismissal_time,'HH24:MI') AS time FROM pickup_early_dismissals
              WHERE student_id=$1 AND adult_id=$2 AND dismissal_date=$3 AND status='approved'`, [row.student_id, row.adult_id, today]) : null;
          const event = d.ok ? "verified" : d.blocked ? "blocked" : "denied";
          await client.query(`INSERT INTO pickup_events(district_id,school_id,student_id,adult_id,tag_id,event,reason,incident_id,recorded_by,service_date)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [a.districtId, a.schoolId, row.student_id, row.adult_id, row.tag_id, event, d.reason || null,
              incident?.status === "reunification" ? incident.id : null, a.userId, today]);
          if (d.blocked) {
            await enqueueNotifications(client, { districtId: a.districtId, schoolId: a.schoolId, recipients: await leadsOf(client), kind: "pickup",
              title: "Pick-up blocked: do-not-release flag", body: `A pass for ${firstName(row.student_name)} was presented. Go to the pick-up point now.`, refType: "pickup_tag", refId: row.tag_id });
          }
          students.push({ studentId: row.student_id, name: row.student_name, grade: row.grade_level, eligible: d.ok, reason: d.reason || null,
            custodyOrder: d.ok ? d.custodyOrder : false, flagDetail: d.ok && d.custodyOrder ? row.restriction_detail : null,
            earlyDismissal: early ? { id: early.id, time: early.time } : null });
        }
        const f = found[0];
        await audit(client, req, "verify", "pickup_tag", f.tag_id, students.map(s => s.eligible ? "ok" : s.reason).join(","), students.some(s => s.eligible) ? "success" : "failure");
        return { tagId: f.tag_id, pass: f.tag_state, adult: { name: f.adult_name, relationship: f.relationship, kind: f.adult_kind, status: f.adult_status },
          students, blocked: students.some(s => s.reason === "do_not_release"), reunification: incident?.status === "reunification",
          instructions: students.some(s => s.reason === "do_not_release") ? "Do not release. The office has been alerted. Keep the learner inside with staff." :
            "Check the adult's photo ID matches the name above, then release." };
      });
      res.json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  // Step 2: staff confirm the photo ID check and release (re-checks the pass).
  app.post("/api/pickup/release", verifyLimiter, requireSession, requireCsrf, requirePermission("pickup", "verify"), staffOnly, async (req, res, next) => {
    const a = req.actor;
    const { code, studentIds, idChecked, custodyAcknowledged = false } = req.body || {};
    if (idChecked !== true) return res.status(400).json({ error: "photo_id_check_required" });
    if (!Array.isArray(studentIds) || studentIds.length < 1 || studentIds.length > 10 || !studentIds.every(validId)) return res.status(400).json({ error: "invalid_students" });
    try {
      const out = await withTenantTransaction(a, async client => {
        const found = await lookup(client, code);
        if (!found) throw new HttpError(404, "unknown_pass");
        const incident = await liveIncident(client, a.schoolId);
        const today = (await one(client, `SELECT eduos_school_today($1) AS d`, [a.schoolId])).d;
        const released = [];
        for (const sid of studentIds) {
          const row = found.find(r => r.student_id === sid);
          if (!row) throw new HttpError(403, "adult_not_authorized_for_student");
          const d = releaseDecision(row, { incidentStatus: incident?.status });
          if (!d.ok) throw new HttpError(409, d.blocked ? "release_blocked" : d.reason);
          if (d.custodyOrder && custodyAcknowledged !== true) throw new HttpError(409, "custody_order_acknowledgement_required");
          const early = await one(client, `UPDATE pickup_early_dismissals SET status='released' WHERE student_id=$1 AND adult_id=$2 AND dismissal_date=$3 AND status='approved' RETURNING id`, [sid, row.adult_id, today]);
          const reunify = incident?.status === "reunification" ? incident.id : null;
          const ev = await one(client, `INSERT INTO pickup_events(district_id,school_id,student_id,adult_id,tag_id,event,id_checked,early_dismissal_id,incident_id,reason,recorded_by,service_date)
              VALUES($1,$2,$3,$4,$5,'released',true,$6,$7,$8,$9,$10) RETURNING id,at`, [a.districtId, a.schoolId, sid, row.adult_id, row.tag_id, early?.id || null, reunify,
              d.custodyOrder ? "custody order acknowledged" : null, a.userId, today]);
          if (reunify) await client.query(`INSERT INTO safety_events(district_id,school_id,incident_id,event,actor_user_id,actor_role,detail) VALUES($1,$2,$3,'released',$4,$5,$6)`,
            [a.districtId, a.schoolId, reunify, a.userId, a.role, "1 learner released to an approved adult"]);
          await audit(client, req, "release", "pickup_event", ev.id, `tag=${row.tag_id};custody=${d.custodyOrder};reunification=${Boolean(reunify)}`);
          const time = new Date(ev.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: (await one(client, `SELECT timezone FROM schools WHERE id=$1`, [a.schoolId]))?.timezone || "UTC" });
          await enqueueNotifications(client, { districtId: a.districtId, schoolId: a.schoolId, recipients: await guardiansOf(client, sid), kind: "pickup",
            title: `${firstName(row.student_name)} was picked up by ${row.adult_name} (${row.relationship}) at ${time}`, refType: "pickup_event", refId: ev.id });
          released.push({ studentId: sid, name: row.student_name, at: ev.at });
        }
        return { released };
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/pickup/deny", verifyLimiter, requireSession, requireCsrf, requirePermission("pickup", "verify"), staffOnly, async (req, res, next) => {
    const a = req.actor;
    const { code, reason } = req.body || {};
    if (!cleanText(reason, 300)) return res.status(400).json({ error: "reason_required" });
    try {
      const out = await withTenantTransaction(a, async client => {
        const found = await lookup(client, code);
        if (!found) throw new HttpError(404, "unknown_pass");
        const today = (await one(client, `SELECT eduos_school_today($1) AS d`, [a.schoolId])).d;
        for (const row of found)
          await client.query(`INSERT INTO pickup_events(district_id,school_id,student_id,adult_id,tag_id,event,reason,recorded_by,service_date) VALUES($1,$2,$3,$4,$5,'denied',$6,$7,$8)`,
            [a.districtId, a.schoolId, row.student_id, row.adult_id, row.tag_id, reason.trim(), a.userId, today]);
        await audit(client, req, "deny", "pickup_tag", found[0].tag_id, reason.trim().slice(0, 200));
        await enqueueNotifications(client, { districtId: a.districtId, schoolId: a.schoolId, recipients: await leadsOf(client), kind: "pickup",
          title: "Pick-up refused at the pick-up point", body: "A staff member refused a release. See the pick-up log.", refType: "pickup_tag", refId: found[0].tag_id });
        return { denied: found.length };
      });
      res.json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  // ---------------- school leads ----------------
  app.get("/api/pickup/admin", requireSession, requirePermission("pickup", "manage"), async (req, res, next) => {
    const school = req.actor.role === "principal" ? req.actor.schoolId : (validId(req.query.schoolId) ? req.query.schoolId : null);
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const pending = await rows(client, `SELECT pa.id,pa.full_name,pa.relationship,pa.requested_at,s.display_name AS student_name,u.display_name AS requested_by_name
            FROM pickup_adults pa JOIN students s ON s.id=pa.student_id JOIN users u ON u.id=pa.requested_by WHERE pa.status='pending' AND ($1::uuid IS NULL OR pa.school_id=$1) ORDER BY pa.requested_at`, [school]);
        const restrictions = await rows(client, `SELECT r.id,r.kind,r.person_name,r.detail,r.document_on_file,r.created_at,s.display_name AS student_name,r.student_id
            FROM pickup_restrictions r JOIN students s ON s.id=r.student_id WHERE r.status='active' AND ($1::uuid IS NULL OR r.school_id=$1) ORDER BY s.display_name`, [school]);
        const early = await rows(client, `SELECT e.id,e.dismissal_date,to_char(e.dismissal_time,'HH24:MI') AS time,e.reason,e.status,s.display_name AS student_name,pa.full_name AS adult_name
            FROM pickup_early_dismissals e JOIN students s ON s.id=e.student_id JOIN pickup_adults pa ON pa.id=e.adult_id
           WHERE e.status='requested' AND ($1::uuid IS NULL OR e.school_id=$1) ORDER BY e.dismissal_date,e.dismissal_time`, [school]);
        const log = await rows(client, `SELECT e.event,e.at,e.reason,e.id_checked,s.display_name AS student_name,pa.full_name AS adult_name,u.display_name AS by_name
            FROM pickup_events e JOIN students s ON s.id=e.student_id LEFT JOIN pickup_adults pa ON pa.id=e.adult_id JOIN users u ON u.id=e.recorded_by
           WHERE ($1::uuid IS NULL OR e.school_id=$1) ORDER BY e.at DESC LIMIT 50`, [school]);
        await audit(client, req, "read", "pickup_admin", school, `pending=${pending.length};restrictions=${restrictions.length}`);
        return { pendingAdults: pending, restrictions, earlyDismissals: early, log };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/pickup/adults/:id/decision", limiter, requireSession, requireCsrf, requirePermission("pickup", "manage"), async (req, res, next) => {
    const { decision, note = null } = req.body || {};
    if (!validId(req.params.id) || !["approve", "reject"].includes(decision) || (note !== null && !cleanText(note, 300))) return res.status(400).json({ error: "invalid_decision" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const r = await one(client, `UPDATE pickup_adults SET status=$2,decided_by=$3,decided_at=now(),decision_note=$4 WHERE id=$1 AND status='pending'
            RETURNING id,status,student_id,school_id,full_name,requested_by`, [req.params.id, decision === "approve" ? "approved" : "rejected", req.actor.userId, note?.trim() || null]);
        if (!r) throw new HttpError(404, "pending_adult_not_found");
        await audit(client, req, decision, "pickup_adult", r.id);
        await enqueueNotifications(client, { districtId: req.actor.districtId, schoolId: r.school_id, recipients: [r.requested_by], kind: "pickup",
          title: `${r.full_name} was ${decision === "approve" ? "approved" : "not approved"} for pick-up`, body: note?.trim() || null, refType: "pickup_adult", refId: r.id });
        return { id: r.id, status: r.status };
      });
      res.json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/pickup/restrictions", limiter, requireSession, requireCsrf, requirePermission("pickup", "manage"), async (req, res, next) => {
    const { studentId, kind, personName = null, adultId = null, detail, documentOnFile = false } = req.body || {};
    if (!validId(studentId) || !["do_not_release", "custody_order"].includes(kind) || (personName !== null && !cleanText(personName, 120, 2)) ||
        (adultId !== null && !validId(adultId)) || !cleanText(detail, 500) || typeof documentOnFile !== "boolean" || (kind === "do_not_release" && !personName && !adultId))
      return res.status(400).json({ error: "invalid_restriction" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const s = await one(client, `SELECT id,school_id FROM students WHERE id=$1`, [studentId]);
        if (!s) throw new HttpError(404, "student_not_found");
        const r = await one(client, `INSERT INTO pickup_restrictions(district_id,school_id,student_id,kind,person_name,adult_id,detail,document_on_file,created_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [req.actor.districtId, s.school_id, s.id, kind, personName?.trim() || null, adultId, detail.trim(), documentOnFile, req.actor.userId]);
        if (kind === "do_not_release" && adultId) await client.query(`UPDATE pickup_tags SET revoked_at=now() WHERE adult_id=$1 AND revoked_at IS NULL`, [adultId]);
        await audit(client, req, "create", "pickup_restriction", r.id, kind);
        return r;
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/pickup/restrictions/:id/lift", limiter, requireSession, requireCsrf, requirePermission("pickup", "manage"), async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    try {
      const n = await withTenantTransaction(req.actor, async client => {
        const r = await client.query(`UPDATE pickup_restrictions SET status='lifted',lifted_by=$2,lifted_at=now() WHERE id=$1 AND status='active' RETURNING id`, [req.params.id, req.actor.userId]);
        if (r.rowCount) await audit(client, req, "lift", "pickup_restriction", req.params.id);
        return r.rowCount;
      });
      if (!n) return res.status(404).json({ error: "not_found" });
      res.json({ data: { status: "lifted" } });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/pickup/early-dismissals/:id/decision", limiter, requireSession, requireCsrf, requirePermission("pickup", "manage"), async (req, res, next) => {
    const { decision } = req.body || {};
    if (!validId(req.params.id) || !["approve", "decline"].includes(decision)) return res.status(400).json({ error: "invalid_decision" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const r = await one(client, `UPDATE pickup_early_dismissals SET status=$2,decided_by=$3,decided_at=now() WHERE id=$1 AND status='requested'
            RETURNING id,status,requested_by,school_id,dismissal_date,to_char(dismissal_time,'HH24:MI') AS time`, [req.params.id, decision === "approve" ? "approved" : "declined", req.actor.userId]);
        if (!r) throw new HttpError(404, "request_not_found");
        await audit(client, req, decision, "pickup_early_dismissal", r.id);
        await enqueueNotifications(client, { districtId: req.actor.districtId, schoolId: r.school_id, recipients: [r.requested_by], kind: "pickup",
          title: `Early dismissal ${decision === "approve" ? "approved" : "declined"} for ${r.time}`, refType: "pickup_early_dismissal", refId: r.id });
        return { id: r.id, status: r.status };
      });
      res.json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });
}
