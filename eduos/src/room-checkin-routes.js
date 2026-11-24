// ROOM-01: scanning into a classroom or the media center (db/111).
//
// The room display (device key):
//   POST /api/classroom-agent/checkin-code        a QR to show, good for 90 seconds
// A kiosk in the room (device key):
//   POST /api/classroom-agent/kiosk-checkin {studentNumber}
// Signed in (students with their own account, staff):
//   POST /api/rooms/:id/checkin {code} | {door}   from the display QR or the door QR
//   GET  /api/my/checkins                          today's
// School leaders / IT:
//   POST /api/rooms/:id/door-qr                    make (or replace) the printed door QR
// Teacher timetabled in the room, leaders, the librarian (media center):
//   GET  /api/rooms/:id/roll                        today: each period's class list with who checked in, and everyone else
//
// A check-in records presence only. The teacher confirms attendance through the
// attendance route, as before.
import { deviceSafetyView } from "./safety-model.js";
import crypto from "node:crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { pool, withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, HttpError, sendError } from "./role-app-util.js";
import { KEY_RE } from "./pairing-routes.js";
import { qrRows } from "./pickup-routes.js";

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const keyOf = req => KEY_RE.exec(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
const SECRET_RE = /^[A-Za-z0-9_-]{22,64}$/;
export const checkinHash = secret => sha256(`room-checkin:${secret}`);
export const scanPath = (roomId, param, secret) => `/app/#/scan?r=${roomId}&${param}=${secret}`;
const MANAGERS = ["it_admin", "principal", "vice_principal"];
const ROLL_READERS = ["teacher", "principal", "vice_principal", "it_admin", "superintendent", "librarian"];
const hhmm = t => String(t).slice(0, 5);

export function registerRoomCheckinRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const scanLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `scan:${req.actor?.userId || ipKeyGenerator(req.ip)}` });
  // A kiosk at the media-center door scans a whole class in a minute or two.
  const agentLimiter = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => { const m = keyOf(req); return m ? `cdk-in:${m[1]}` : `cdk-in-ip:${ipKeyGenerator(req.ip)}`; } });
  const run = (fn, ok = 200) => async (req, res, next) => {
    try { const out = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(ok).json({ data: out }); }
    catch (e) { sendError(res, next, e); }
  };
  const agent = fn => async (req, res, next) => {
    const m = keyOf(req);
    if (!m) return res.status(401).json({ error: "device_key_required" });
    try { const out = await fn(m[1], sha256(m[2]), req); if (out === null) return res.status(401).json({ error: "invalid_device_key" }); res.setHeader("Cache-Control", "no-store"); res.json({ data: out }); }
    catch (e) { next(e); }
  };

  // SAFE-02: check-in pauses while a safety alert is live at the school; people stay where they are.
  const agentSafety = async (device, keyHash) => (await pool.query(`SELECT eduos_classroom_agent_safety($1,$2) AS out`, [device, keyHash])).rows[0].out;

  app.post("/api/classroom-agent/checkin-code", agentLimiter, agent(async (device, keyHash) => {
    const live = await agentSafety(device, keyHash);
    if (!live) return null;
    if (live.incident) return { path: null, paused: true, safety: deviceSafetyView(live) };
    const secret = crypto.randomBytes(16).toString("base64url");
    const r = (await pool.query(`SELECT eduos_classroom_agent_checkin_code($1,$2,$3) AS out`, [device, keyHash, checkinHash(secret)])).rows[0].out;
    if (!r) return null;
    if (!r.room) return { path: null };
    const path = scanPath(r.roomId, "c", secret);
    return { path, qr: qrRows(path), room: r.room, expiresAt: r.expiresAt };
  }));

  app.post("/api/classroom-agent/kiosk-checkin", agentLimiter, agent(async (device, keyHash, req) => {
    const n = req.body?.studentNumber;
    if (typeof n !== "string" || n.trim().length < 1 || n.length > 40) return { error: "not_found" };
    const live = await agentSafety(device, keyHash);
    if (!live) return null;
    if (live.incident) return { error: "paused_for_safety", safety: deviceSafetyView(live) };
    return (await pool.query(`SELECT eduos_classroom_agent_kiosk_checkin($1,$2,$3) AS out`, [device, keyHash, n])).rows[0].out;
  }));

  app.post("/api/rooms/:id/checkin", requireSession, scanLimiter, requireCsrf, run(async (c, req) => {
    const { code, door } = req.body || {};
    const secret = code ?? door, method = code != null ? "display_qr" : "door_qr";
    if (!validId(req.params.id) || typeof secret !== "string" || !SECRET_RE.test(secret)) throw new HttpError(400, "invalid_checkin");
    if (req.actor.schoolId && (await one(c, `SELECT eduos_safety_live_at($1) AS live`, [req.actor.schoolId])).live) throw new HttpError(409, "paused_for_safety");
    const r = (await one(c, `SELECT eduos_room_checkin($1,$2,$3) AS out`, [req.params.id, method, checkinHash(secret)])).out;
    if (r.error) throw new HttpError(r.error === "room_not_found" ? 404 : r.error === "code_expired" ? 410 : 403, r.error);
    return { ...r, method };
  }, 201));

  app.get("/api/my/checkins", requireSession, run(async (c, req) =>
    (await rows(c, `SELECT * FROM eduos_my_room_checkins()`))
      .map(k => ({ roomId: k.room_id, room: k.room, kind: k.kind, method: k.method, at: k.checked_in_at, class: k.class }))));

  app.post("/api/rooms/:id/door-qr", limiter, requireSession, requireCsrf, (req, res, next) => MANAGERS.includes(req.actor.role) ? next() : res.status(403).json({ error: "forbidden" }),
    run(async (c, req) => {
      if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
      const secret = crypto.randomBytes(18).toString("base64url");
      const r = await one(c, `UPDATE classroom_rooms SET door_secret_hash=$2,door_secret_set_at=now() WHERE id=$1 AND archived_at IS NULL RETURNING id,name`, [req.params.id, checkinHash(secret)]);
      if (!r) throw new HttpError(404, "room_not_found");
      await audit(c, req, "issue_door_qr", "classroom_room", r.id, null);
      const path = scanPath(r.id, "d", secret);
      return { room: r.name, path, qr: qrRows(path), note: "Print it now: it isn't shown again. Making a new one stops the old poster working." };
    }));

  app.get("/api/rooms/:id/roll", requireSession, (req, res, next) => ROLL_READERS.includes(req.actor.role) ? next() : res.status(403).json({ error: "forbidden" }),
    run(async (c, req) => {
      if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
      const room = await one(c, `SELECT r.id,r.name,r.kind,r.school_id,eduos_room_local_date(r.id) AS today,eduos_room_slot_now(r.id) AS now_slot,
          eduos_can_read_room_checkins(r.id,r.school_id) AS can FROM classroom_rooms r WHERE r.id=$1 AND r.archived_at IS NULL`, [req.params.id]);
      if (!room || !room.can) throw new HttpError(404, "room_not_found");
      const today = room.today instanceof Date ? room.today.toISOString().slice(0, 10) : String(room.today).slice(0, 10);
      const isoDay = ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
      const slots = (await rows(c, `SELECT t.id,t.starts,t.ends,t.label,t.course_id,t.teacher_user_id,u.display_name AS teacher,co.title AS course FROM classroom_room_teachers t
          JOIN users u ON u.id=t.teacher_user_id LEFT JOIN courses co ON co.id=t.course_id WHERE t.room_id=$1 AND t.ended_at IS NULL AND $2::smallint = ANY(t.weekdays) ORDER BY t.starts`, [room.id, isoDay]))
        // A teacher sees their own periods' class lists; leaders and the librarian see every period.
        .filter(t => req.actor.role !== "teacher" || t.teacher_user_id === req.actor.userId);
      const checkins = await rows(c, `SELECT k.*,coalesce(s.display_name,u.display_name) AS name FROM room_checkins k LEFT JOIN students s ON s.id=k.student_id
          LEFT JOIN users u ON u.id=k.user_id WHERE k.room_id=$1 AND k.local_date=$2 ORDER BY k.checked_in_at`, [room.id, today]);
      const shown = new Set();
      const out = [];
      for (const t of slots) {
        const roster = t.course_id ? await rows(c, `SELECT s.id,s.display_name AS name,
            (SELECT a.status FROM attendance_events a WHERE a.student_id=s.id AND a.event_date=$2 ORDER BY a.observed_at DESC LIMIT 1) AS attendance
            FROM course_enrollments e JOIN students s ON s.id=e.student_id WHERE e.course_id=$1 AND e.status='active' ORDER BY s.display_name`, [t.course_id, today]) : [];
        const here = checkins.filter(k => k.slot_id === t.id);
        // ROOM-02: students who joined the class's remote lesson today.
        const remote = t.course_id ? await rows(c, `SELECT k.student_id,k.checked_in_at FROM remote_lesson_checkins k JOIN class_remote_lessons s ON s.id=k.session_id
            WHERE s.course_id=$1 AND s.lesson_date=$2 AND s.cancelled_at IS NULL`, [t.course_id, today]) : [];
        here.forEach(k => shown.add(k.id));
        out.push({ id: t.id, starts: hhmm(t.starts), ends: hhmm(t.ends), class: t.label || t.course, course: t.course, courseId: t.course_id, teacher: t.teacher, now: t.id === room.now_slot,
          roster: roster.map(s => { const k = here.find(x => x.student_id === s.id), rm = remote.find(x => x.student_id === s.id);
            return { studentId: s.id, name: s.name, checkedInAt: k?.checked_in_at ?? rm?.checked_in_at ?? null, method: k?.method ?? (rm ? "remote" : null), attendance: s.attendance ?? null }; }),
          others: here.filter(k => !roster.some(s => s.id === k.student_id)).map(k => ({ name: k.name, kind: k.person_kind, at: k.checked_in_at, method: k.method })) });
      }
      // Outside a period (or in the media center): everyone who checked in today.
      const unscheduled = req.actor.role === "teacher" ? [] : checkins.filter(k => !shown.has(k.id)).map(k => ({ name: k.name, kind: k.person_kind, at: k.checked_in_at, method: k.method }));
      await audit(c, req, "read", "room_roll", room.id, today);
      return { id: room.id, name: room.name, kind: room.kind, date: today, periods: out, unscheduled };
    }));
}
