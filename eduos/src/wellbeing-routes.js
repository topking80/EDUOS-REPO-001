// EduOS 37.6.0 well-being check-ins. A learner tells a HUMAN counselor how
// they are doing. No scoring, prediction or risk ranking of minors (p21).
//
//   pupil           sends a check-in (mood, needs, optional note) when the
//                   district has turned check-ins on AND a guardian opted in
//                   under the current notice; sees only "a counselor saw it"
//   parent          reads the district notice and opts each child in or out
//   counselor       the school's check-ins and crisis alerts (two plain
//                   buckets, oldest first) and an append-only actions log
//   superintendent  district switch, notice text and retention
// Principals, teachers and the district office have NO access to check-ins.
//
// Crisis language (src/wellbeing-model.js, a fixed published phrase list)
// always shows the 988 Suicide & Crisis Lifeline and alerts the school's
// counselors at once, and opens an URGENT item in the existing counseling
// queue (school_service_work). If the school has no counselor, the principal
// gets a generic notice with no content. If the learner is NOT opted in, the
// text is not stored, but the alert (learner id only) still goes to a human:
// safety before data collection. See docs/WELLBEING.md.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { config } from "./config.js";
import { enqueueNotifications, registerNotificationKind } from "./notify.js";
import { audit, rows, one, validId, HttpError } from "./role-app-util.js";
import { wrap, created, need, str } from "./route-helpers.js";
import { validateCheckin, detectCrisis, CRISIS_RESPONSE, orderQueue, MOODS, NEEDS, DEFAULT_NOTICE } from "./wellbeing-model.js";

registerNotificationKind("wellbeing");
const ACTIONS = ["seen", "assigned", "met_with_student", "contacted_family", "referred", "note", "closed", "reopened"];
const RATE = (() => {
  const v = Number(process.env.WELLBEING_RATE_LIMIT_PER_MIN || 20);
  if (!Number.isInteger(v) || v < 1 || v > 100000) throw new Error("WELLBEING_RATE_LIMIT_PER_MIN must be an integer from 1 to 100000");
  return v;
})();

async function settings(client) {
  return (await one(client, `SELECT checkins_enabled,notice_version,notice_text,retention_days FROM wellbeing_settings LIMIT 1`))
    || { checkins_enabled: false, notice_version: "v1", notice_text: DEFAULT_NOTICE, retention_days: 365 };
}
async function myStudent(client, actor) {
  return one(client, `SELECT s.id,s.display_name,s.school_id FROM student_user_links l JOIN students s ON s.id=l.student_id
      WHERE l.user_id=$1 AND l.relationship='pupil' AND l.status='active' LIMIT 1`, [actor.userId]);
}

/**
 * Crisis: alert + URGENT counseling-queue item + immediate in-app notification
 * to a human. Content never goes in the notification or the queue item.
 */
export async function raiseCrisisAlert(client, req, studentId, source, checkinId = null) {
  const r = await rows(client, `SELECT * FROM eduos_wellbeing_raise_alert($1,$2,$3)`, [studentId, source, checkinId]);
  const counselors = r.filter(x => !x.fallback && x.recipient).map(x => x.recipient);
  const fallback = r.filter(x => x.fallback && x.recipient).map(x => x.recipient);
  const schoolId = r[0]?.school_id || null, alertId = r[0]?.alert_id || null;
  if (counselors.length) await enqueueNotifications(client, { districtId: req.actor.districtId, schoolId, recipients: counselors, kind: "wellbeing",
    title: "Urgent: a student needs a counselor now", body: source === "christie" ? "Crisis words in a Christie chat. Open Well-being alerts." : "Crisis words in a check-in. Open Well-being alerts.",
    refType: "wellbeing_alert", refId: alertId });
  if (fallback.length) await enqueueNotifications(client, { districtId: req.actor.districtId, schoolId, recipients: fallback, kind: "wellbeing",
    title: "Urgent: a student needs a trained adult now", body: "A student used crisis words and no counselor is set up for your school. Please check on the student in person and add a counselor.",
    refType: "wellbeing_alert", refId: alertId });
  await audit(client, req, "crisis_alert", "wellbeing_alert", alertId, `source=${source} notified=${counselors.length + fallback.length} queue=${r[0]?.work_id ? "yes" : "no"}`);
  return { alertId, workId: r[0]?.work_id || null, notified: counselors.length + fallback.length };
}

export function registerWellbeingRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: RATE, standardHeaders: true, legacyHeaders: false });
  const staffLimiter = rateLimit({ windowMs: 60_000, limit: config.commsRateLimit, standardHeaders: true, legacyHeaders: false });

  // ---- learner ----
  app.get("/api/wellbeing/status", requireSession, requirePermission("wellbeing", "checkin"), wrap(async (client, req) => {
    const me = await myStudent(client, req.actor);
    need(me, 404, "no_linked_learner");
    const allowed = Boolean((await one(client, `SELECT eduos_wellbeing_allowed($1) AS ok`, [me.id])).ok);
    const recent = allowed ? await rows(client, `SELECT id,mood,status,created_at FROM wellbeing_checkins WHERE student_id=$1 ORDER BY created_at DESC LIMIT 5`, [me.id]) : [];
    return { allowed, moods: MOODS, needs: NEEDS, crisis: CRISIS_RESPONSE,
      recent: recent.map(c => ({ id: c.id, mood: c.mood, at: c.created_at, seen: c.status !== "new" })),
      privacy: "Only school counselors read check-ins. Nothing is scored or used to predict anything about you." };
  }));
  app.post("/api/wellbeing/checkins", limiter, requireSession, requireCsrf, requirePermission("wellbeing", "checkin"), wrap(async (client, req) => {
    const me = await myStudent(client, req.actor);
    need(me, 404, "no_linked_learner");
    const body = req.body || {};
    // Crisis words route to a human even when the check-in itself can't be stored.
    const crisis = detectCrisis(typeof body.note === "string" ? body.note : "");
    const allowed = Boolean((await one(client, `SELECT eduos_wellbeing_allowed($1) AS ok`, [me.id])).ok);
    let v = null;
    try { v = validateCheckin(body); } catch (e) { if (!crisis.crisis) throw new HttpError(400, e.message); }
    if (!allowed || !v) {
      if (crisis.crisis) {
        const alert = await raiseCrisisAlert(client, req, me.id, "checkin", null);
        return created({ stored: false, crisis: true, response: CRISIS_RESPONSE, alerted: alert.notified > 0 });
      }
      throw new HttpError(403, "wellbeing_not_enabled", { message: "Check-ins need a family opt-in first. You can always talk to a counselor in person." });
    }
    const r = await one(client, `INSERT INTO wellbeing_checkins(district_id,school_id,student_id,mood,needs,note,wants_talk,crisis)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,created_at`, [req.actor.districtId, me.school_id, me.id, v.mood, v.needs, v.note, v.wantsTalk, crisis.crisis]);
    let alert = null;
    if (crisis.crisis) alert = await raiseCrisisAlert(client, req, me.id, "checkin", r.id);
    else if (v.wantsTalk || v.needs.includes("safety")) {
      await one(client, `SELECT eduos_wellbeing_request_talk($1) AS id`, [r.id]);
      const counselors = await rows(client, `SELECT user_id FROM memberships WHERE school_id=$1 AND role='counselor' AND status='active'`, [me.school_id]);
      if (counselors.length) await enqueueNotifications(client, { districtId: req.actor.districtId, schoolId: me.school_id, recipients: counselors.map(c => c.user_id), kind: "wellbeing",
        title: "A student asked to talk", body: "Open Well-being check-ins.", refType: "wellbeing_checkin", refId: r.id });
    }
    await audit(client, req, "create", "wellbeing_checkin", r.id, crisis.crisis ? "crisis_rule" : null);
    return created({ id: r.id, stored: true, crisis: crisis.crisis, response: crisis.crisis ? CRISIS_RESPONSE : null, alerted: Boolean(alert?.notified),
      message: v.wantsTalk ? "Thanks. A counselor will find a time to talk with you." : "Thanks for checking in. A counselor will read this." });
  }));

  // ---- family notice and consent ----
  app.get("/api/wellbeing/consent", requireSession, requirePermission("wellbeing", "consent"), wrap(async (client, req) => {
    const s = await settings(client);
    const kids = await rows(client, `SELECT s.id,s.display_name,s.grade_level,sc.name AS school_name,c.decision,c.decided_at,c.notice_version
      FROM student_user_links l JOIN students s ON s.id=l.student_id JOIN schools sc ON sc.id=s.school_id
      LEFT JOIN LATERAL (SELECT decision,decided_at,notice_version FROM wellbeing_consents c WHERE c.student_id=s.id ORDER BY c.decided_at DESC LIMIT 1) c ON true
     WHERE l.user_id=$1 AND l.relationship IN ('parent','guardian') AND l.status='active' ORDER BY s.display_name`, [req.actor.userId]);
    return { enabled: s.checkins_enabled, noticeVersion: s.notice_version, notice: s.notice_text, retentionDays: s.retention_days,
      children: kids.map(k => ({ id: k.id, name: k.display_name, grade: k.grade_level, school: k.school_name, decision: k.decision, decidedAt: k.decided_at,
        needsNewDecision: k.decision === "opted_in" && k.notice_version !== s.notice_version,
        active: s.checkins_enabled && k.decision === "opted_in" && k.notice_version === s.notice_version })) };
  }));
  app.post("/api/wellbeing/consent", staffLimiter, requireSession, requireCsrf, requirePermission("wellbeing", "consent"), wrap(async (client, req) => {
    const { studentId, decision, noticeVersion } = req.body || {};
    need(validId(studentId) && ["opted_in", "opted_out"].includes(decision), 400, "invalid_value");
    const kid = await one(client, `SELECT s.id,s.school_id FROM students s WHERE s.id=$1 AND eduos_is_linked_student(s.id)`, [studentId]);
    need(kid, 404, "not_found");
    const s = await settings(client);
    // An opt-in must name the notice the guardian actually read.
    need(decision === "opted_out" || noticeVersion === s.notice_version, 409, "notice_changed_please_reread");
    await client.query(`INSERT INTO wellbeing_consents(district_id,school_id,student_id,decision,notice_version,decided_by) VALUES($1,$2,$3,$4,$5,$6)`,
      [req.actor.districtId, kid.school_id, kid.id, decision, s.notice_version, req.actor.userId]);
    await audit(client, req, `consent.${decision}`, "wellbeing_consent", kid.id, s.notice_version);
    return created({ studentId, decision, noticeVersion: s.notice_version });
  }));

  // ---- counselor ----
  app.get("/api/wellbeing/queue", requireSession, requirePermission("wellbeing", "queue"), wrap(async (client, req) => {
    need(req.actor.schoolId, 403, "school_scope_required");
    const list = await rows(client, `SELECT c.*, s.display_name, s.grade_level, u.display_name AS assigned_name FROM wellbeing_checkins c JOIN students s ON s.id=c.student_id
        LEFT JOIN users u ON u.id=c.assigned_to WHERE c.school_id=$1 AND (c.status<>'closed' OR c.closed_at > now() - interval '7 days') ORDER BY c.created_at`, [req.actor.schoolId]);
    const ids = list.map(c => c.id);
    const actions = ids.length ? await rows(client, `SELECT a.checkin_id,a.action,a.note,a.at,u.display_name FROM wellbeing_actions a JOIN users u ON u.id=a.actor_user_id
        WHERE a.checkin_id=ANY($1::uuid[]) ORDER BY a.at`, [ids]) : [];
    const alerts = await rows(client, `SELECT a.id,a.source,a.created_at,a.checkin_id,a.work_id,s.display_name,s.grade_level FROM wellbeing_alerts a JOIN students s ON s.id=a.student_id
        WHERE a.school_id=$1 AND a.acknowledged_at IS NULL ORDER BY a.created_at`, [req.actor.schoolId]);
    await audit(client, req, "read", "wellbeing_queue", req.actor.schoolId, `items=${list.length} alerts=${alerts.length}`);
    const ordered = orderQueue(list).map(c => ({ id: c.id, bucket: c.bucket, student: { id: c.student_id, name: c.display_name, grade: c.grade_level },
      mood: c.mood, needs: c.needs, note: c.note, wantsTalk: c.wants_talk, crisis: c.crisis, status: c.status, assignedTo: c.assigned_name, createdAt: c.created_at,
      workId: c.work_id, actions: actions.filter(a => a.checkin_id === c.id).map(a => ({ action: a.action, note: a.note, at: a.at, by: a.display_name })) }));
    return { alerts: alerts.map(a => ({ id: a.id, source: a.source, at: a.created_at, checkinId: a.checkin_id, workId: a.work_id, student: { name: a.display_name, grade: a.grade_level } })),
      now: ordered.filter(c => c.bucket === "now"), today: ordered.filter(c => c.bucket === "today"), closed: ordered.filter(c => c.bucket === "closed"),
      rule: "“Needs a person now” = crisis words, asked to talk, or checked “safety”. Everything else: oldest first. No scores or rankings.",
      crisis: CRISIS_RESPONSE };
  }));
  app.post("/api/wellbeing/checkins/:id/actions", staffLimiter, requireSession, requireCsrf, requirePermission("wellbeing", "queue"), wrap(async (client, req) => {
    need(validId(req.params.id), 400, "invalid_checkin_id");
    const action = req.body?.action;
    need(ACTIONS.includes(action), 400, "invalid_action");
    const c = await one(client, `SELECT id,school_id,status,work_id FROM wellbeing_checkins WHERE id=$1`, [req.params.id]);
    need(c, 404, "not_found");
    const note = str(req.body?.note, 1000, { optional: true });
    await client.query(`INSERT INTO wellbeing_actions(district_id,school_id,checkin_id,actor_user_id,action,note) VALUES($1,$2,$3,$4,$5,$6)`,
      [req.actor.districtId, c.school_id, c.id, req.actor.userId, action, note]);
    const next = action === "closed" ? "closed" : action === "reopened" ? "in_progress" : action === "seen" ? (c.status === "new" ? "seen" : c.status) : (c.status === "closed" ? "closed" : "in_progress");
    await client.query(`UPDATE wellbeing_checkins SET status=$2, closed_at=CASE WHEN $2='closed' THEN now() ELSE NULL END,
        assigned_to=CASE WHEN $3 THEN $4::uuid ELSE assigned_to END WHERE id=$1`, [c.id, next, action === "assigned", req.actor.userId]);
    // Keep the linked counseling-queue item in step.
    if (c.work_id) await client.query(`UPDATE school_service_work SET status=$2, assigned_to=CASE WHEN $3 THEN $4::uuid ELSE assigned_to END, updated_at=now()
        WHERE id=$1 AND domain='counseling' AND school_id=$5`, [c.work_id, next === "closed" ? "completed" : "in_progress", action === "assigned", req.actor.userId, c.school_id]);
    await audit(client, req, `action.${action}`, "wellbeing_checkin", c.id);
    return { id: c.id, status: next };
  }));
  app.post("/api/wellbeing/alerts/:id/ack", staffLimiter, requireSession, requireCsrf, requirePermission("wellbeing", "queue"), wrap(async (client, req) => {
    need(validId(req.params.id), 400, "invalid_alert_id");
    const r = await one(client, `UPDATE wellbeing_alerts SET acknowledged_by=$2, acknowledged_at=now() WHERE id=$1 AND acknowledged_at IS NULL RETURNING id,work_id,school_id`, [req.params.id, req.actor.userId]);
    need(r, 404, "not_found");
    // Acknowledged = a counselor is on it; the queue item stays open until they complete it.
    if (r.work_id) await client.query(`UPDATE school_service_work SET status='in_progress', assigned_to=$2, updated_at=now() WHERE id=$1 AND domain='counseling' AND school_id=$3 AND status='open'`,
      [r.work_id, req.actor.userId, r.school_id]);
    await audit(client, req, "acknowledge", "wellbeing_alert", req.params.id);
    return { id: req.params.id, acknowledged: true };
  }));

  // ---- district settings ----
  app.get("/api/wellbeing/settings", requireSession, requirePermission("wellbeing", "settings"), wrap(async client => {
    const s = await settings(client);
    return { enabled: s.checkins_enabled, noticeVersion: s.notice_version, notice: s.notice_text, retentionDays: s.retention_days, defaultNotice: DEFAULT_NOTICE };
  }));
  app.put("/api/wellbeing/settings", staffLimiter, requireSession, requireCsrf, requirePermission("wellbeing", "settings"), wrap(async (client, req) => {
    const b = req.body || {};
    need(typeof b.enabled === "boolean", 400, "invalid_value");
    const notice = str(b.notice, 3000, { min: 20 });
    const days = Number(b.retentionDays ?? 365);
    need(Number.isInteger(days) && days >= 30 && days <= 2555, 400, "invalid_retention_days");
    const prev = await settings(client);
    // A changed notice gets a new version, and families must opt in again.
    const version = prev.notice_text === notice ? prev.notice_version : `v${Date.now().toString(36)}`;
    await client.query(`INSERT INTO wellbeing_settings(district_id,checkins_enabled,notice_version,notice_text,retention_days,updated_by) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT (district_id) DO UPDATE SET checkins_enabled=EXCLUDED.checkins_enabled, notice_version=EXCLUDED.notice_version,
          notice_text=EXCLUDED.notice_text, retention_days=EXCLUDED.retention_days, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [req.actor.districtId, b.enabled, version, notice, days, req.actor.userId]);
    await audit(client, req, "settings.update", "wellbeing_settings", null, `enabled=${b.enabled} v=${version}`);
    return { noticeVersion: version };
  }));
}
