// DEV-02: the room timetable and pairing a teacher's own device (db/109).
//
// School leaders (and IT):
//   GET  /api/rooms/:id/timetable              who teaches in the room, when
//   POST /api/rooms/:id/timetable              add a slot {teacherId, weekdays[1-7], starts "HH:MM", ends, label}
//   POST /api/room-timetable/:id/end           end a slot (its pairings end too)
//   GET  /api/pairings                         active pairings in scope
// District IT:
//   POST /api/devices/:id/key                  issue (or replace) the device key; shown once
//   POST /api/devices/:id/key/revoke
// The room display (device key, no session):
//   POST /api/classroom-agent/code             a fresh 6-digit code to show, plus who is paired
// Teachers:
//   GET  /api/my/rooms                         rooms I'm timetabled in, whether now, my pairing
//   POST /api/rooms/:id/pair {code, controllerName}
//   POST /api/pairings/:id/end                 (also leaders)
import crypto from "node:crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { pool, withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";

const MANAGERS = ["it_admin", "principal", "vice_principal"];
const LEADERS = ["it_admin", "superintendent", "principal", "vice_principal"];
export const KEY_RE = /^cdk1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CODE_TTL = 300;
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
// Codes are stored only as hashes; a code works only in its own room.
export const codeHash = code => sha256(`classroom-pair:${code}`);
export const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

export function parseSlot(b) {
  const days = Array.isArray(b.weekdays) ? [...new Set(b.weekdays)].sort() : null;
  if (!validId(b.teacherId) || !days?.length || !days.every(d => Number.isInteger(d) && d >= 1 && d <= 7)) return null;
  if (!TIME_RE.test(b.starts || "") || !TIME_RE.test(b.ends || "") || b.ends <= b.starts) return null;
  if (b.label != null && b.label !== "" && !cleanText(b.label, 80)) return null;
  if (b.courseId != null && b.courseId !== "" && !validId(b.courseId)) return null;
  return { teacherId: b.teacherId, weekdays: days, starts: b.starts, ends: b.ends, label: typeof b.label === "string" && b.label.trim() ? b.label.trim() : null, courseId: b.courseId || null };
}

const hhmm = t => String(t).slice(0, 5);
const slotOut = t => ({ id: t.id, roomId: t.room_id, teacherId: t.teacher_user_id, teacher: t.teacher, weekdays: t.weekdays.map(Number), starts: hhmm(t.starts), ends: hhmm(t.ends), label: t.label,
  courseId: t.course_id ?? null, course: t.course ?? null });
const pairingOut = p => ({ id: p.id, roomId: p.room_id, room: p.room, teacherId: p.teacher_user_id, teacher: p.teacher, controller: p.controller_name, pairedAt: p.paired_at, until: p.expires_at, via: p.via });

export function registerPairingRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  // Guessing a code: a few tries per person per ten minutes.
  const pairLimiter = rateLimit({ windowMs: 600_000, limit: 8, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => `pair:${req.actor?.userId || ipKeyGenerator(req.ip)}` });
  const agentLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => { const m = KEY_RE.exec(String(req.headers.authorization || "").replace(/^Bearer\s+/i, "")); return m ? `cdk:${m[1]}` : `cdk-ip:${ipKeyGenerator(req.ip)}`; } });
  const only = roles => (req, res, next) => roles.includes(req.actor?.role) ? next() : res.status(403).json({ error: "forbidden" });
  const run = (fn, ok = 200) => async (req, res, next) => {
    try { const out = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(ok).json({ data: out }); }
    catch (e) {
      if (e.code === "42501") return res.status(403).json({ error: "forbidden" });
      sendError(res, next, e);
    }
  };

  // ---------- timetable ----------
  app.get("/api/rooms/:id/timetable", requireSession, only([...LEADERS, "teacher"]), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    if (!(await one(c, `SELECT 1 FROM classroom_rooms WHERE id=$1 AND archived_at IS NULL`, [req.params.id]))) throw new HttpError(404, "room_not_found");
    return (await rows(c, `SELECT t.*,u.display_name AS teacher,co.title AS course FROM classroom_room_teachers t JOIN users u ON u.id=t.teacher_user_id
        LEFT JOIN courses co ON co.id=t.course_id WHERE t.room_id=$1 AND t.ended_at IS NULL ORDER BY t.starts,u.display_name`, [req.params.id])).map(slotOut);
  }));

  app.get("/api/rooms/:id/teachers", requireSession, only(MANAGERS), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const room = await one(c, `SELECT school_id FROM classroom_rooms WHERE id=$1 AND archived_at IS NULL`, [req.params.id]);
    if (!room) throw new HttpError(404, "room_not_found");
    const teachers = await rows(c, `SELECT user_id AS id,name FROM eduos_school_teachers($1)`, [room.school_id]);
    const courses = await rows(c, `SELECT id,title,teacher_user_id FROM courses WHERE school_id=$1 AND status<>'archived' ORDER BY title`, [room.school_id]);
    return teachers.map(t => ({ ...t, courses: courses.filter(x => x.teacher_user_id === t.id).map(x => ({ id: x.id, title: x.title })) }));
  }));

  app.post("/api/rooms/:id/timetable", limiter, requireSession, requireCsrf, only(MANAGERS), run(async (c, req) => {
    const v = parseSlot(req.body || {});
    if (!validId(req.params.id) || !v) throw new HttpError(400, "invalid_slot");
    const room = await one(c, `SELECT id,school_id FROM classroom_rooms WHERE id=$1 AND archived_at IS NULL`, [req.params.id]);
    if (!room) throw new HttpError(404, "room_not_found");
    const ok = (await one(c, `SELECT eduos_is_school_teacher($1,$2) AS ok`, [v.teacherId, room.school_id])).ok;
    if (!ok) throw new HttpError(400, "teacher_at_this_school_required");
    if (v.courseId && !(await one(c, `SELECT 1 FROM courses WHERE id=$1 AND school_id=$2 AND teacher_user_id=$3 AND status<>'archived'`, [v.courseId, room.school_id, v.teacherId])))
      throw new HttpError(400, "course_of_this_teacher_required");
    const t = await one(c, `INSERT INTO classroom_room_teachers(district_id,school_id,room_id,teacher_user_id,weekdays,starts,ends,label,course_id,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [req.actor.districtId, room.school_id, room.id, v.teacherId, v.weekdays, v.starts, v.ends, v.label, v.courseId, req.actor.userId]);
    await audit(c, req, "create", "room_timetable", t.id, `${v.weekdays.join("")} ${v.starts}-${v.ends}`);
    return t;
  }, 201));

  app.post("/api/room-timetable/:id/end", limiter, requireSession, requireCsrf, only(MANAGERS), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const t = await one(c, `UPDATE classroom_room_teachers SET ended_at=now(),ended_by=$2 WHERE id=$1 AND ended_at IS NULL RETURNING id`, [req.params.id, req.actor.userId]);
    if (!t) throw new HttpError(404, "slot_not_found");
    const ended = await rows(c, `UPDATE classroom_pairings SET ended_at=now(),ended_by=$2,end_reason='schedule' WHERE schedule_id=$1 AND ended_at IS NULL AND expires_at>now() RETURNING id`, [t.id, req.actor.userId]);
    await audit(c, req, "end", "room_timetable", t.id, `pairings=${ended.length}`);
    return { ended: true, pairingsEnded: ended.length };
  }));

  // ---------- device keys (IT) ----------
  app.post("/api/devices/:id/key", limiter, requireSession, requireCsrf, only(["it_admin"]), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const secret = crypto.randomBytes(32).toString("base64url");
    const d = await one(c, `UPDATE classroom_devices SET token_hash=$2,token_issued_at=now(),token_issued_by=$3 WHERE id=$1 AND status='approved' RETURNING id,name`,
      [req.params.id, sha256(secret), req.actor.userId]);
    if (!d) throw new HttpError(409, "device_not_approved");
    await audit(c, req, "issue_key", "classroom_device", d.id, null);
    return { deviceId: d.id, key: `cdk1.${d.id}.${secret}`, note: "Shown once. Enter it in the room display's EduOS agent." };
  }));

  app.post("/api/devices/:id/key/revoke", limiter, requireSession, requireCsrf, only(["it_admin"]), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const d = await one(c, `UPDATE classroom_devices SET token_hash=NULL,token_issued_at=now(),token_issued_by=$2 WHERE id=$1 RETURNING id`, [req.params.id, req.actor.userId]);
    if (!d) throw new HttpError(404, "device_not_found");
    await audit(c, req, "revoke_key", "classroom_device", d.id, null);
    return { revoked: true };
  }));

  // ---------- the room display ----------
  app.post("/api/classroom-agent/code", agentLimiter, async (req, res, next) => {
    const m = KEY_RE.exec(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!m) return res.status(401).json({ error: "device_key_required" });
    const code = newCode();
    try {
      const r = (await pool.query(`SELECT eduos_classroom_agent_code($1,$2,$3,$4) AS out`, [m[1], sha256(m[2]), codeHash(code), CODE_TTL])).rows[0].out;
      if (!r) return res.status(401).json({ error: "invalid_device_key" });
      res.setHeader("Cache-Control", "no-store");
      if (!r.room) return res.json({ data: { code: null, reason: r.reason } });
      res.json({ data: { code, room: r.room, expiresAt: r.expiresAt, pairedWith: r.pairedWith } });
    } catch (e) { next(e); }
  });

  // ---------- teachers ----------
  app.get("/api/my/rooms", requireSession, only(["teacher"]), run(async (c, req) => {
    const slots = await rows(c, `SELECT t.*,r.name AS room,s.timezone,
        (extract(isodow FROM now() AT TIME ZONE s.timezone)::smallint = ANY(t.weekdays)
          AND now() AT TIME ZONE s.timezone >= (now() AT TIME ZONE s.timezone)::date + t.starts - interval '10 minutes'
          AND now() AT TIME ZONE s.timezone < (now() AT TIME ZONE s.timezone)::date + t.ends) AS now
        FROM classroom_room_teachers t JOIN classroom_rooms r ON r.id=t.room_id JOIN schools s ON s.id=t.school_id
        WHERE t.teacher_user_id=$1 AND t.ended_at IS NULL AND r.archived_at IS NULL ORDER BY r.name,t.starts`, [req.actor.userId]);
    const pairings = await rows(c, `SELECT p.*,r.name AS room,u.display_name AS teacher,d.name AS via FROM classroom_pairings p JOIN classroom_rooms r ON r.id=p.room_id
        JOIN users u ON u.id=p.teacher_user_id JOIN classroom_devices d ON d.id=p.via_device_id WHERE p.teacher_user_id=$1 AND p.ended_at IS NULL AND p.expires_at>now()`, [req.actor.userId]);
    const ids = [...new Set(slots.map(s => s.room_id))];
    const devices = ids.length ? await rows(c, `SELECT id,room_id,kind,name,capabilities FROM classroom_devices WHERE room_id = ANY($1) AND status='approved' ORDER BY name`, [ids]) : [];
    return ids.map(id => {
      const mine = slots.filter(s => s.room_id === id);
      return { id, name: mine[0].room, now: mine.some(s => s.now), slots: mine.map(slotOut),
        devices: devices.filter(d => d.room_id === id).map(d => ({ id: d.id, kind: d.kind, name: d.name, capabilities: d.capabilities })),
        pairing: (p => p ? pairingOut(p) : null)(pairings.find(p => p.room_id === id)) };
    });
  }));

  app.post("/api/rooms/:id/pair", requireSession, pairLimiter, requireCsrf, only(["teacher"]), run(async (c, req) => {
    const { code, controllerName } = req.body || {};
    if (!validId(req.params.id) || !/^\d{6}$/.test(String(code || "")) || !cleanText(controllerName, 60)) throw new HttpError(400, "invalid_pairing");
    const r = (await one(c, `SELECT eduos_classroom_pair($1,$2,$3) AS out`, [req.params.id, codeHash(code), controllerName.trim()])).out;
    if (r.error) {
      throw new HttpError(r.error === "room_not_found" ? 404 : r.error === "wrong_code" ? 400 : 403, r.error);
    }
    await audit(c, req, "pair", "classroom_room", req.params.id, `pairing=${r.id}`);
    return r;
  }, 201));

  app.get("/api/pairings", requireSession, only(LEADERS), run(async (c, req) =>
    (await rows(c, `SELECT p.*,r.name AS room,u.display_name AS teacher,d.name AS via FROM classroom_pairings p JOIN classroom_rooms r ON r.id=p.room_id
       JOIN users u ON u.id=p.teacher_user_id JOIN classroom_devices d ON d.id=p.via_device_id WHERE p.ended_at IS NULL AND p.expires_at>now() ORDER BY r.name`)).map(pairingOut)));

  app.post("/api/pairings/:id/end", limiter, requireSession, requireCsrf, only([...MANAGERS, "teacher"]), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const p = await one(c, `UPDATE classroom_pairings SET ended_at=now(),ended_by=$2,end_reason=CASE WHEN teacher_user_id=$2 THEN 'teacher' ELSE 'school' END
        WHERE id=$1 AND ended_at IS NULL AND expires_at>now() RETURNING id`, [req.params.id, req.actor.userId]);
    if (!p) throw new HttpError(404, "pairing_not_found");
    await audit(c, req, "end", "classroom_pairing", p.id, null);
    return { ended: true };
  }));
}
