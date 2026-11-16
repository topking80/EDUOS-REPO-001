// 32.5.0 SafetyOS: emergency alerts (lockdown, shelter, evacuate, hold) with a
// two-step confirm and a drill flag, a full-screen state in every role app at
// the school, per-class roll call, a live accountability board, reunification
// and all-clear, and an append-only incident log for the debrief.
//
// Not here, by design: location tracking, cameras, facial recognition, threat
// detection or scoring. An incident starts because a person starts it.
//
// Families get generic in-app notices only (no student, staff or room detail);
// during reunification they see their own children's release status.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { enqueueNotifications } from "./notify.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { INCIDENT_KINDS, ROLLCALL_STATUSES, LIVE, KIND_LABEL, audienceFor, incidentMessage, familyTitle, confirmMatches, accountability } from "./safety-model.js";
import { queuedAt, idempotencyKey, claimReplay } from "./offline-replay.js";

const INCIDENT_COLS = `i.id,i.school_id,sc.name AS school_name,i.kind,i.is_drill,i.status,i.instructions,i.reunification_point,
  i.initiated_by,i.initiated_at,i.confirm_by,i.confirmed_at,i.reunification_at,i.closed_at,i.debrief`;

function logEvent(client, req, incident, event, detail = null) {
  return client.query(`INSERT INTO safety_events(district_id,school_id,incident_id,event,actor_user_id,actor_role,detail) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [req.actor.districtId, incident.school_id, incident.id, event, req.actor.userId, req.actor.role, detail === null ? null : String(detail).slice(0, 500)]);
}

async function notifyIncident(client, req, incident, status) {
  const staff = (await rows(client, `SELECT user_id FROM eduos_safety_recipients($1,'staff')`, [incident.id])).map(r => r.user_id);
  const families = (await rows(client, `SELECT user_id FROM eduos_safety_recipients($1,'families')`, [incident.id])).map(r => r.user_id);
  const drill = incident.is_drill ? " (drill)" : "";
  const staffTitle = status === "closed" ? `All clear${drill}: ${KIND_LABEL[incident.kind]} ended` : status === "reunification" ? `Reunification started${drill}`
    : `${KIND_LABEL[incident.kind]}${drill} at ${incident.school_name}`;
  const base = { districtId: req.actor.districtId, schoolId: incident.school_id, kind: "safety", refType: "safety_incident", refId: incident.id };
  const a = await enqueueNotifications(client, { ...base, recipients: staff, title: staffTitle, body: status === "closed" ? "Normal operations resume." : incidentMessage(incident.kind, status, "staff", { reunificationPoint: incident.reunification_point }) });
  const b = await enqueueNotifications(client, { ...base, recipients: families.filter(u => !staff.includes(u)), title: familyTitle(incident.kind, incident.is_drill, incident.school_name, status),
    body: status === "closed" ? "The school has given the all clear. Thank you for your patience." : incidentMessage(incident.kind, status, "family", { reunificationPoint: incident.reunification_point }) });
  return notificationSummary(staff.length, families.filter(u => !staff.includes(u)).length, a + b);
}

/**
 * What an incident change put in the outbox. In-app notices are available to
 * the recipient as soon as the transaction commits; email/SMS/push rows are
 * only queued here (src/notify-dispatch.js hands them to a channel adapter
 * later, and only an adapter can confirm a delivery). EduOS never contacts
 * emergency services.
 */
export function notificationSummary(staff, families, rowsWritten) {
  const inApp = staff + families;
  return { recipients: { staff, families }, inAppAvailable: inApp, externalQueued: rowsWritten - inApp, externalDelivered: 0,
    emergencyServicesContacted: false };
}

/** Delivery report rows (channel, status, n, read_n) -> counts for the board. */
export function deliveryReport(rows) {
  const out = { inApp: { available: 0, read: 0 }, external: { pending: 0, delivered: 0, skipped: 0, failed: 0 }, byChannel: {}, emergencyServicesContacted: false };
  for (const r of rows) {
    if (r.channel === "in_app") { out.inApp.available += r.n; out.inApp.read += r.read_n; continue; }
    out.external[r.status] = (out.external[r.status] || 0) + r.n;
    (out.byChannel[r.channel] ||= { pending: 0, delivered: 0, skipped: 0, failed: 0 })[r.status] += r.n;
  }
  return out;
}

const loadIncident = (client, id) => one(client, `SELECT ${INCIDENT_COLS} FROM safety_incidents i JOIN schools sc ON sc.id=i.school_id WHERE i.id=$1`, [id]);

/** The view of an incident for one audience. Families never get instructions written by staff. */
function present(i, role, userId) {
  const audience = audienceFor(role);
  const out = { id: i.id, schoolId: i.school_id, schoolName: i.school_name, kind: i.kind, label: KIND_LABEL[i.kind], isDrill: i.is_drill, status: i.status,
    startedAt: i.confirmed_at || i.initiated_at, reunificationAt: i.reunification_at, closedAt: i.closed_at,
    message: incidentMessage(i.kind, i.status, audience, { reunificationPoint: i.reunification_point }), audience };
  if (audience !== "family") out.instructions = i.instructions;
  if (i.status === "reunification" || audience === "family") out.reunificationPoint = i.status === "reunification" ? i.reunification_point : null;
  if (i.status === "pending") { out.confirmBy = i.confirm_by; out.mine = i.initiated_by === userId; }
  return out;
}

export function registerSafetyRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: config.safetyRateLimit, standardHeaders: true, legacyHeaders: false });
  const lead = requirePermission("safety", "lead");

  // ---- everyone: is anything live for me? (polled by the role apps) ----
  // The superintendent sees the district; a parent sees schools where they
  // have a child (an active parent/guardian link); everyone else sees their
  // own school. Row-level security enforces the same (scope_read on
  // safety_incidents); the query states it too rather than relying on it.
  app.get("/api/safety/status", requireSession, requirePermission("safety", "read"), async (req, res, next) => {
    const a = req.actor;
    try {
      const data = await withTenantTransaction(a, async client => {
        const list = await rows(client, `SELECT ${INCIDENT_COLS} FROM safety_incidents i JOIN schools sc ON sc.id=i.school_id
            WHERE (i.status IN ('active','reunification') OR (i.status='pending' AND i.initiated_by=$1 AND i.confirm_by>now()))
              AND ($3='superintendent'
                OR ($3='parent' AND EXISTS(SELECT 1 FROM student_user_links l JOIN students s ON s.id=l.student_id AND s.district_id=l.district_id
                      WHERE l.user_id=$1 AND l.status='active' AND l.relationship IN ('parent','guardian') AND s.school_id=i.school_id))
                OR ($3 NOT IN ('superintendent','parent') AND i.school_id=$2))
            ORDER BY i.initiated_at`, [a.userId, a.schoolId, a.role]);
        const incidents = list.map(i => present(i, a.role, a.userId));
        // Families: their own children at a school in reunification, with release status.
        if (a.role === "parent" && incidents.some(i => i.status === "reunification")) {
          const kids = await rows(client, `SELECT s.id,s.display_name,s.school_id,
                (SELECT json_build_object('at',e.at,'adult',pa.full_name) FROM pickup_events e LEFT JOIN pickup_adults pa ON pa.id=e.adult_id
                  WHERE e.student_id=s.id AND e.event='released' AND e.incident_id=ANY($2::uuid[]) ORDER BY e.at DESC LIMIT 1) AS released
              FROM students s JOIN student_user_links l ON l.student_id=s.id
             WHERE l.user_id=$1 AND l.status='active' AND l.relationship IN ('parent','guardian') ORDER BY s.display_name`, [a.userId, incidents.map(i => i.id)]);
          for (const i of incidents) i.children = kids.filter(k => k.school_id === i.schoolId).map(k => ({ id: k.id, name: k.display_name, released: k.released }));
        }
        return { incidents, canInitiate: canInitiate(a), canLead: ["principal", "superintendent"].includes(a.role) };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // ---- step 1: start (pending; nothing is broadcast yet) ----
  app.post("/api/safety/incidents", limiter, requireSession, requireCsrf, requirePermission("safety", "initiate"), async (req, res, next) => {
    const a = req.actor;
    const { kind, isDrill, instructions = null, schoolId: bodySchool } = req.body || {};
    if (!INCIDENT_KINDS.includes(kind) || typeof isDrill !== "boolean" || (instructions !== null && !cleanText(instructions, 500)))
      return res.status(400).json({ error: "invalid_incident", kinds: INCIDENT_KINDS });
    if (!canInitiate(a)) return res.status(403).json({ error: "not_authorized_to_initiate" });
    const schoolId = a.role === "superintendent" ? bodySchool : a.schoolId;
    if (!validId(schoolId)) return res.status(400).json({ error: "invalid_school_id" });
    try {
      const out = await withTenantTransaction(a, async client => {
        const live = await one(client, `SELECT id,kind,status FROM safety_incidents WHERE school_id=$1 AND status IN ('active','reunification')`, [schoolId]);
        if (live) throw new HttpError(409, "incident_already_live", { incidentId: live.id });
        // Unconfirmed starts that ran out of time are closed off and logged.
        const stale = await rows(client, `UPDATE safety_incidents SET status='cancelled',closed_at=now(),closed_by=$2
            WHERE school_id=$1 AND status='pending' AND (confirm_by<=now() OR initiated_by=$2) RETURNING id,school_id`, [schoolId, a.userId]);
        for (const s of stale) await logEvent(client, req, s, "expired", "replaced by a new start");
        const i = await one(client, `INSERT INTO safety_incidents(district_id,school_id,kind,is_drill,instructions,initiated_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,school_id`,
          [a.districtId, schoolId, kind, isDrill, instructions?.trim() || null, a.userId]);
        await logEvent(client, req, i, "initiated", `${kind}${isDrill ? " drill" : ""}`);
        await audit(client, req, "initiate", "safety_incident", i.id, `${kind};drill=${isDrill}`);
        return present(await loadIncident(client, i.id), a.role, a.userId);
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  // ---- step 2: confirm (repeats kind + drill flag) -> live everywhere ----
  app.post("/api/safety/incidents/:id/confirm", limiter, requireSession, requireCsrf, requirePermission("safety", "initiate"), async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_incident_id" });
    const a = req.actor;
    try {
      const out = await withTenantTransaction(a, async client => {
        const i = await loadIncident(client, req.params.id);
        if (!i) throw new HttpError(404, "incident_not_found");
        if (i.initiated_by !== a.userId && !["principal", "superintendent"].includes(a.role)) throw new HttpError(403, "not_your_incident");
        if (i.status !== "pending") throw new HttpError(409, "incident_not_pending", { status: i.status });
        if (new Date(i.confirm_by) <= new Date()) {
          await client.query(`UPDATE safety_incidents SET status='cancelled',closed_at=now(),closed_by=$2 WHERE id=$1`, [i.id, a.userId]);
          await logEvent(client, req, i, "expired", "not confirmed in time");
          return { expired: true };
        }
        if (!confirmMatches(i, req.body)) throw new HttpError(400, "confirmation_mismatch");
        try {
          await client.query(`UPDATE safety_incidents SET status='active',confirmed_by=$2,confirmed_at=now() WHERE id=$1`, [i.id, a.userId]);
        } catch (e) { if (e?.code === "23505") throw new HttpError(409, "incident_already_live"); throw e; }
        await logEvent(client, req, i, "confirmed", i.is_drill ? "drill" : "real");
        const sent = await notifyIncident(client, req, i, "active");
        await audit(client, req, "confirm", "safety_incident", i.id, `${i.kind};drill=${i.is_drill};staff=${sent.recipients.staff};families=${sent.recipients.families};external_queued=${sent.externalQueued}`);
        return { ...present(await loadIncident(client, i.id), a.role, a.userId), notifications: sent };
      });
      if (out.expired) return res.status(410).json({ error: "confirmation_expired" });
      res.json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/safety/incidents/:id/cancel", limiter, requireSession, requireCsrf, requirePermission("safety", "initiate"), async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_incident_id" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const i = await loadIncident(client, req.params.id);
        if (!i) throw new HttpError(404, "incident_not_found");
        if (i.status !== "pending") throw new HttpError(409, "only_pending_can_be_cancelled");
        await client.query(`UPDATE safety_incidents SET status='cancelled',closed_at=now(),closed_by=$2 WHERE id=$1`, [i.id, req.actor.userId]);
        await logEvent(client, req, i, "cancelled");
        await audit(client, req, "cancel", "safety_incident", i.id);
        return { id: i.id, status: "cancelled" };
      });
      res.json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  // ---- teachers: roll call for their class (roster) ----
  app.get("/api/safety/incidents/:id/rollcall", requireSession, requirePermission("safety", "read"), async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_incident_id" });
    if (!["teacher", "principal"].includes(req.actor.role)) return res.status(403).json({ error: "role_not_allowed" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const i = await loadIncident(client, req.params.id);
        if (!i || i.school_id !== req.actor.schoolId) throw new HttpError(404, "incident_not_found");
        const latest = await rows(client, `SELECT DISTINCT ON (e.student_id) e.student_id,e.status,e.note,e.recorded_at FROM safety_rollcall_entries e
            WHERE e.incident_id=$1 AND e.recorded_by=$2 ORDER BY e.student_id,coalesce(e.observed_at,e.recorded_at) DESC,e.id DESC`, [i.id, req.actor.userId]);
        const by = new Map(latest.map(l => [l.student_id, l]));
        const roster = await rows(client, `SELECT DISTINCT s.id,s.display_name,s.grade_level FROM teacher_student_rosters r JOIN students s ON s.id=r.student_id
            WHERE r.teacher_user_id=$1 AND s.school_id=$2 ORDER BY s.display_name`, [req.actor.userId, i.school_id]);
        const learners = roster.map(s => ({ studentId: s.id, name: s.display_name, grade: s.grade_level, status: by.get(s.id)?.status || null, note: by.get(s.id)?.note || null }));
        const rosterIds = new Set(roster.map(s => s.id));
        const extraIds = latest.filter(l => !rosterIds.has(l.student_id)).map(l => l.student_id);
        const extras = [];
        for (const id of extraIds) {
          const s = (await rows(client, `SELECT * FROM eduos_safety_student_at_school($1,$2)`, [i.id, id]))[0]
            || { student_id: id, display_name: "Learner (not on your roster)", grade_level: null };
          extras.push({ studentId: id, name: s.display_name, grade: s.grade_level, status: by.get(id).status, note: by.get(id).note });
        }
        return { incident: present(i, req.actor.role, req.actor.userId), learners, extras, submittedAt: latest.length ? latest.map(l => l.recorded_at).sort().at(-1) : null };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.get("/api/safety/incidents/:id/students", requireSession, requirePermission("safety", "read"), async (req, res, next) => {
    if (!validId(req.params.id) || !cleanText(req.query.q, 60, 2)) return res.status(400).json({ error: "invalid_search" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const found = await rows(client, `SELECT * FROM eduos_safety_find_student($1,$2)`, [req.params.id, String(req.query.q)]);
        await audit(client, req, "search", "safety_student", req.params.id, `results=${found.length}`);
        return found.map(s => ({ studentId: s.student_id, name: s.display_name, grade: s.grade_level }));
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/safety/incidents/:id/rollcall", limiter, requireSession, requireCsrf, requirePermission("safety", "read"), async (req, res, next) => {
    const a = req.actor;
    if (!["teacher", "principal"].includes(a.role)) return res.status(403).json({ error: "role_not_allowed" });
    const entries = req.body?.entries;
    if (!validId(req.params.id) || !Array.isArray(entries) || entries.length < 1 || entries.length > 300 ||
        !entries.every(e => validId(e?.studentId) && ROLLCALL_STATUSES.includes(e.status) && (e.note === undefined || e.note === null || cleanText(e.note, 200))))
      return res.status(400).json({ error: "invalid_rollcall", statuses: ROLLCALL_STATUSES });
    let observed;
    try { observed = queuedAt(req); idempotencyKey(req); } catch (e) { return res.status(e.status).json({ error: e.code }); }
    try {
      const out = await withTenantTransaction(a, async client => {
        const i = await loadIncident(client, req.params.id);
        if (!i || i.school_id !== a.schoolId) throw new HttpError(404, "incident_not_found");
        // 32.7.0: a roll call queued offline while the incident was live is
        // still accepted after it closed (history is append-only); live writes are not.
        const lateButValid = observed && i.closed_at && observed <= new Date(i.closed_at) && observed >= new Date(i.initiated_at);
        if (!LIVE.includes(i.status) && !lateButValid) throw new HttpError(409, "incident_not_live");
        if (await claimReplay(client, req, "rollcall", observed)) return { duplicate: true, recorded: 0, counts: Object.fromEntries(ROLLCALL_STATUSES.map(s => [s, 0])) };
        const roster = new Set((await rows(client, `SELECT student_id FROM teacher_student_rosters WHERE teacher_user_id=$1 AND school_id=$2`, [a.userId, i.school_id])).map(r => r.student_id));
        for (const e of entries) {
          const onRoster = roster.has(e.studentId);
          if (a.role === "teacher" && !onRoster && e.status !== "extra") throw new HttpError(400, "not_on_roster", { studentId: e.studentId });
          if (!onRoster && !(await one(client, `SELECT student_id FROM eduos_safety_student_at_school($1,$2)`, [i.id, e.studentId]))) throw new HttpError(404, "student_not_at_school");
        }
        await client.query(`INSERT INTO safety_rollcall_entries(district_id,school_id,incident_id,student_id,status,note,recorded_by,observed_at,queued)
            SELECT $1,$2,$3,x.s,x.st,x.n,$4,$8,$9 FROM unnest($5::uuid[],$6::text[],$7::text[]) AS x(s,st,n)`,
          [a.districtId, i.school_id, i.id, a.userId, entries.map(e => e.studentId), entries.map(e => e.status), entries.map(e => e.note?.trim() || null), observed, Boolean(observed)]);
        const counts = Object.fromEntries(ROLLCALL_STATUSES.map(s => [s, entries.filter(e => e.status === s).length]));
        await logEvent(client, req, i, "rollcall", ROLLCALL_STATUSES.map(s => `${s}=${counts[s]}`).join(" ") + (observed ? ` (queued offline, observed ${observed.toISOString()})` : ""));
        await audit(client, req, "rollcall", "safety_incident", i.id, JSON.stringify(counts));
        if ((counts.missing || counts.injured) && !lateButValid) {
          const leads = (await rows(client, `SELECT user_id FROM eduos_school_leads()`)).map(r => r.user_id);
          await enqueueNotifications(client, { districtId: a.districtId, schoolId: i.school_id, recipients: leads, kind: "safety", refType: "safety_incident", refId: i.id,
            title: `Roll call: ${counts.missing} missing, ${counts.injured} injured`, body: "Open the accountability board." });
        }
        return { recorded: entries.length, counts };
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  // ---- leads: accountability board, log, reunification, all-clear, debrief ----
  // ---- SRO coordination status (lead-only; does not dispatch law enforcement) ----
  app.get("/api/safety/incidents/:id/sro-status", requireSession, requirePermission("safety", "sro_update"), async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_incident_id" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const i = await loadIncident(client, req.params.id);
        if (!i || i.school_id !== req.actor.schoolId) throw new HttpError(404, "incident_not_found");
        if (!LIVE.includes(i.status)) throw new HttpError(409, "incident_not_live");
        const events = await rows(client, `SELECT detail,at FROM safety_events WHERE incident_id=$1 AND event='responders' ORDER BY at DESC,id DESC`, [i.id]);
        const updates = events.map(e => { try { const v=JSON.parse(e.detail || "{}"); return v.type === "sro_status" ? { ...v, recordedAt:e.at } : null; } catch { return null; } }).filter(Boolean);
        await audit(client, req, "read", "safety_sro_status", i.id);
        return { incident: present(i, req.actor.role, req.actor.userId), updates };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/safety/incidents/:id/sro-status", limiter, requireSession, requireCsrf, requirePermission("safety", "sro_update"), async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_incident_id" });
    const { status, officerName = null, unit = null, note = null } = req.body || {};
    const allowed = ["requested", "notified", "responding", "on_scene", "cleared", "unavailable"];
    if (!allowed.includes(status) || (officerName !== null && !cleanText(officerName, 100)) ||
        (unit !== null && !cleanText(unit, 100)) || (note !== null && !cleanText(note, 300)))
      return res.status(400).json({ error: "invalid_sro_status", statuses: allowed });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const i = await loadIncident(client, req.params.id);
        if (!i || i.school_id !== req.actor.schoolId) throw new HttpError(404, "incident_not_found");
        if (!LIVE.includes(i.status)) throw new HttpError(409, "incident_not_live");
        const detail = JSON.stringify({ type: "sro_status", status, officerName: officerName?.trim() || null,
          unit: unit?.trim() || null, note: note?.trim() || null });
        await logEvent(client, req, i, "responders", detail);
        await audit(client, req, "sro_status", "safety_incident", i.id, `status=${status}`);
        return { incidentId: i.id, status, recordedAt: new Date().toISOString() };
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  // 35.6.0: incident-specific SRO assignment and acknowledgement. This is
  // internal coordination only; it does not dispatch emergency services.
  app.get("/api/safety/incidents/:id/sro-assignment", requireSession, requirePermission("safety", "read"), async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_incident_id" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const i = await loadIncident(client, req.params.id);
        if (!i || i.school_id !== req.actor.schoolId) throw new HttpError(404, "incident_not_found");
        if (!(["principal", "superintendent", "it_admin", "sro"].includes(req.actor.role))) throw new HttpError(403, "role_not_allowed");
        const events = await rows(client, `SELECT detail,at,actor_role FROM safety_events WHERE incident_id=$1 AND event='responders' ORDER BY at,id`, [i.id]);
        const timeline = events.map(e => { try { const v=JSON.parse(e.detail || "{}"); return ["sro_assignment","sro_assignment_response"].includes(v.type) ? { ...v, at:e.at, actorRole:e.actor_role } : null; } catch { return null; } }).filter(Boolean);
        const visible = req.actor.role === "sro" ? timeline.filter(e => e.sroUserId === req.actor.userId) : timeline;
        await audit(client, req, "read", "safety_sro_assignment", i.id);
        return { incident: present(i, req.actor.role, req.actor.userId), timeline: visible };
      });
      res.setHeader("Cache-Control", "no-store"); res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/safety/incidents/:id/sro-assignment", limiter, requireSession, requireCsrf, lead, async (req, res, next) => {
    const { sroUserId, note = null } = req.body || {};
    if (!validId(req.params.id) || !validId(sroUserId) || (note !== null && !cleanText(note, 180))) return res.status(400).json({ error: "invalid_sro_assignment" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const i = await loadIncident(client, req.params.id);
        if (!i || i.school_id !== req.actor.schoolId) throw new HttpError(404, "incident_not_found");
        if (!LIVE.includes(i.status)) throw new HttpError(409, "incident_not_live");
        const member = await one(client, `SELECT user_id FROM memberships WHERE district_id=$1 AND school_id=$2 AND user_id=$3 AND role='sro' AND status='active'`, [req.actor.districtId, i.school_id, sroUserId]);
        if (!member) throw new HttpError(400, "sro_not_authorized_for_school");
        const policy = await one(client, `SELECT allowed_school_ids FROM sro_district_policies WHERE district_id=$1`, [req.actor.districtId]);
        if (policy && policy.allowed_school_ids !== null && !policy.allowed_school_ids.includes(i.school_id)) throw new HttpError(403, "school_not_allowed_by_district_policy");
        const detail = JSON.stringify({ type:"sro_assignment", sroUserId, assignedBy:req.actor.userId, note:note?.trim() || null });
        await logEvent(client, req, i, "responders", detail);
        await audit(client, req, "assign_sro", "safety_incident", i.id, `sro=${sroUserId}`);
        return { incidentId:i.id, sroUserId, status:"assigned", recordedAt:new Date().toISOString() };
      });
      res.status(201).json({ data:out });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/safety/incidents/:id/sro-assignment-response", limiter, requireSession, requireCsrf, requirePermission("safety", "sro_update"), async (req, res, next) => {
    const { response, note = null } = req.body || {};
    if (!validId(req.params.id) || !["acknowledged","declined"].includes(response) || (note !== null && !cleanText(note, 180))) return res.status(400).json({ error:"invalid_sro_assignment_response" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const i = await loadIncident(client, req.params.id);
        if (!i || i.school_id !== req.actor.schoolId) throw new HttpError(404, "incident_not_found");
        if (!LIVE.includes(i.status)) throw new HttpError(409, "incident_not_live");
        const assigned = await rows(client, `SELECT detail FROM safety_events WHERE incident_id=$1 AND event='responders' ORDER BY at DESC,id DESC`, [i.id]);
        const latest = assigned.map(e=>{try{return JSON.parse(e.detail||"{}")}catch{return null}}).find(v=>v?.type==="sro_assignment" && v.sroUserId===req.actor.userId);
        if (!latest) throw new HttpError(403, "sro_not_assigned_to_incident");
        const detail = JSON.stringify({ type:"sro_assignment_response", sroUserId:req.actor.userId, response, note:note?.trim() || null });
        await logEvent(client, req, i, "responders", detail);
        await audit(client, req, `sro_assignment_${response}`, "safety_incident", i.id);
        return { incidentId:i.id, response, recordedAt:new Date().toISOString() };
      });
      res.status(201).json({ data:out });
    } catch (e) { sendError(res, next, e); }
  });

  // ---- lead-only reunification manifest: latest student status + guardian eligibility ----
  app.get("/api/safety/incidents/:id/reunification-manifest", requireSession, lead, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_incident_id" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const i = await loadIncident(client, req.params.id);
        if (!i) throw new HttpError(404, "incident_not_found");
        if (i.status !== "reunification") throw new HttpError(409, "incident_not_in_reunification");
        const learners = await rows(client, `SELECT s.id AS student_id,s.display_name,s.grade_level,
            latest.status AS rollcall_status,latest.recorded_at AS status_at,
            (SELECT count(*)::int FROM student_user_links l
              WHERE l.student_id=s.id AND l.status='active' AND l.relationship IN ('parent','guardian')) AS eligible_guardians,
            released.at AS released_at,released.adult_name
          FROM students s
          LEFT JOIN LATERAL (
            SELECT e.status,e.recorded_at FROM safety_rollcall_entries e
            WHERE e.incident_id=$1 AND e.student_id=s.id
            ORDER BY coalesce(e.observed_at,e.recorded_at) DESC,e.id DESC LIMIT 1
          ) latest ON true
          LEFT JOIN LATERAL (
            SELECT e.at,pa.full_name AS adult_name FROM pickup_events e
            LEFT JOIN pickup_adults pa ON pa.id=e.adult_id AND pa.district_id=e.district_id
            WHERE e.incident_id=$1 AND e.student_id=s.id AND e.event='released'
            ORDER BY e.at DESC LIMIT 1
          ) released ON true
          WHERE s.school_id=$2 AND s.district_id=$3 ORDER BY s.display_name LIMIT 1000`,
          [i.id, i.school_id, req.actor.districtId]);
        const summary = {
          enrolled: learners.length,
          accountedFor: learners.filter(x => ["present","released","injured","missing","extra"].includes(x.rollcall_status)).length,
          missing: learners.filter(x => x.rollcall_status === "missing").length,
          injured: learners.filter(x => x.rollcall_status === "injured").length,
          awaitingRollcall: learners.filter(x => !x.rollcall_status).length,
          released: learners.filter(x => x.released_at).length,
          awaitingGuardianRelease: learners.filter(x => !x.released_at).length
        };
        await audit(client, req, "read", "safety_reunification_manifest", i.id, JSON.stringify(summary));
        return { incident: present(i, req.actor.role, req.actor.userId), summary,
          learners: learners.map(x => ({ studentId:x.student_id,name:x.display_name,grade:x.grade_level,
            rollcallStatus:x.rollcall_status,statusAt:x.status_at,eligibleGuardians:x.eligible_guardians,
            releasedAt:x.released_at,releasedTo:x.adult_name })) };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.get("/api/safety/incidents/:id/board", requireSession, lead, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_incident_id" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const i = await loadIncident(client, req.params.id);
        if (!i) throw new HttpError(404, "incident_not_found");
        const enrolled = (await one(client, `SELECT count(*)::int AS n FROM students WHERE school_id=$1`, [i.school_id])).n;
        const latest = await rows(client, `SELECT DISTINCT ON (e.student_id) e.student_id,e.status,e.note,e.recorded_by,e.recorded_at,s.display_name,s.grade_level,u.display_name AS recorded_by_name
            FROM safety_rollcall_entries e JOIN students s ON s.id=e.student_id JOIN users u ON u.id=e.recorded_by
           WHERE e.incident_id=$1 ORDER BY e.student_id,coalesce(e.observed_at,e.recorded_at) DESC,e.id DESC`, [i.id]);
        const totals = accountability(enrolled, latest);
        const teachers = await rows(client, `SELECT u.id,u.display_name,
              (SELECT count(DISTINCT r.student_id)::int FROM teacher_student_rosters r WHERE r.teacher_user_id=u.id AND r.school_id=$2) AS roster,
              (SELECT max(e.recorded_at) FROM safety_rollcall_entries e WHERE e.incident_id=$1 AND e.recorded_by=u.id) AS submitted_at
            FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.school_id=$2 AND m.role='teacher' AND m.status='active' ORDER BY u.display_name`, [i.id, i.school_id]);
        const reported = new Set(latest.map(l => l.student_id));
        const unaccounted = (await rows(client, `SELECT id,display_name,grade_level FROM students WHERE school_id=$1 ORDER BY display_name LIMIT 500`, [i.school_id]))
          .filter(s => !reported.has(s.id)).slice(0, 50).map(s => ({ studentId: s.id, name: s.display_name, grade: s.grade_level }));
        const released = (await one(client, `SELECT count(DISTINCT student_id)::int AS n FROM pickup_events WHERE incident_id=$1 AND event='released'`, [i.id])).n;
        const events = await rows(client, `SELECT e.event,e.detail,e.at,e.actor_role,u.display_name AS actor_name FROM safety_events e JOIN users u ON u.id=e.actor_user_id
            WHERE e.incident_id=$1 ORDER BY e.at,e.id`, [i.id]);
        const pick = st => latest.filter(l => l.status === st).map(l => ({ studentId: l.student_id, name: l.display_name, grade: l.grade_level, note: l.note, by: l.recorded_by_name, at: l.recorded_at }));
        const notifications = deliveryReport(await rows(client, `SELECT channel,status,n,read_n FROM eduos_safety_delivery($1)`, [i.id]));
        await audit(client, req, "read", "safety_board", i.id, `enrolled=${enrolled}`);
        return { incident: { ...present(i, req.actor.role, req.actor.userId), debrief: i.debrief }, totals: { ...totals, released }, notifications,
          teachers: teachers.map(t => ({ name: t.display_name, roster: t.roster, submittedAt: t.submitted_at })),
          missing: pick("missing"), injured: pick("injured"), extra: pick("extra"), unaccounted, events };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.get("/api/safety/incidents", requireSession, lead, async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, async client => rows(client, `SELECT ${INCIDENT_COLS} FROM safety_incidents i JOIN schools sc ON sc.id=i.school_id
          WHERE ($1::uuid IS NULL OR i.school_id=$1) ORDER BY i.initiated_at DESC LIMIT 50`, [req.actor.role === "superintendent" ? null : req.actor.schoolId]));
      res.json({ data: data.map(i => ({ ...present(i, req.actor.role, req.actor.userId), debrief: i.debrief })) });
    } catch (e) { sendError(res, next, e); }
  });

  const transition = (path, handler) => app.post(`/api/safety/incidents/:id/${path}`, limiter, requireSession, requireCsrf, lead, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_incident_id" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const i = await loadIncident(client, req.params.id);
        if (!i) throw new HttpError(404, "incident_not_found");
        return handler(client, req, i);
      });
      res.json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  // A staff member's note that first responders were called or are on scene,
  // or a free-text log note (no student data expected). EduOS records what
  // staff report; it does not contact emergency services itself.
  transition("events", async (client, req, i) => {
    const { event, detail = null } = req.body || {};
    if (!["responders", "note"].includes(event) || (detail !== null && !cleanText(detail, 500))) throw new HttpError(400, "invalid_event");
    if (!LIVE.includes(i.status) && event === "responders") throw new HttpError(409, "incident_not_live");
    await logEvent(client, req, i, event, detail?.trim() || (event === "responders" ? "Staff reported a first-responder update" : null));
    await audit(client, req, event, "safety_incident", i.id);
    return { logged: event };
  });

  transition("reunification", async (client, req, i) => {
    const point = req.body?.point;
    if (!cleanText(point, 200)) throw new HttpError(400, "reunification_point_required");
    if (i.status !== "active") throw new HttpError(409, "incident_not_active");
    await client.query(`UPDATE safety_incidents SET status='reunification',reunification_at=now(),reunification_point=$2 WHERE id=$1`, [i.id, point.trim()]);
    await logEvent(client, req, i, "reunification", point.trim());
    const fresh = await loadIncident(client, i.id);
    const sent = await notifyIncident(client, req, fresh, "reunification");
    await audit(client, req, "reunification", "safety_incident", i.id, `families=${sent.recipients.families};external_queued=${sent.externalQueued}`);
    return { ...present(fresh, req.actor.role, req.actor.userId), notifications: sent };
  });

  // All clear is also two-step in the app; the API wants the kind repeated.
  transition("all-clear", async (client, req, i) => {
    if (!LIVE.includes(i.status)) throw new HttpError(409, "incident_not_live");
    if (req.body?.kind !== i.kind) throw new HttpError(400, "confirmation_mismatch");
    await client.query(`UPDATE safety_incidents SET status='closed',closed_at=now(),closed_by=$2 WHERE id=$1`, [i.id, req.actor.userId]);
    await logEvent(client, req, i, "all_clear");
    const sent = await notifyIncident(client, req, i, "closed");
    await audit(client, req, "all_clear", "safety_incident", i.id, `families=${sent.recipients.families};external_queued=${sent.externalQueued}`);
    return { id: i.id, status: "closed", notifications: sent };
  });

  transition("debrief", async (client, req, i) => {
    const text = req.body?.text;
    if (!cleanText(text, 4000)) throw new HttpError(400, "invalid_debrief");
    if (i.status !== "closed") throw new HttpError(409, "incident_not_closed");
    await client.query(`UPDATE safety_incidents SET debrief=$2 WHERE id=$1`, [i.id, text.trim()]);
    await logEvent(client, req, i, "debrief", `${text.trim().length} characters`);
    await audit(client, req, "debrief", "safety_incident", i.id);
    return { id: i.id, debrief: true };
  });
}

function canInitiate(a) {
  if (a.role === "teacher") return config.safetyTeachersMayInitiate;
  return a.role === "principal" || a.role === "superintendent";
}
