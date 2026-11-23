// DEV-01: classroom rooms and the device registry (db/108).
//
//   GET  /api/rooms                      rooms in scope, with their devices
//   POST /api/rooms                      add a room (principal / VP: own school; IT: any school)
//   PUT  /api/rooms/:id                  rename etc.
//   POST /api/rooms/:id/archive          archive (its devices leave the room)
//
//   GET  /api/devices?status=&schoolId=  devices in scope
//   POST /api/devices                    a school asks for one (pending); IT registers one (approved)
//   PUT  /api/devices/:id                change it (anything but the name needs approving again)
//   POST /api/devices/:id/decision       IT: approved / rejected, with a note
//   POST /api/devices/:id/place          the school puts an approved device in a room (or takes it out)
//   POST /api/devices/:id/retire         retire it
//   GET  /api/devices/:id/events         its history
//
// What a device can be told to do is a fixed list per kind. There is no
// screen-viewing capability for student devices, here or in the database.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { parseDevice } from "./device-registry.js";

const READERS = ["it_admin", "superintendent", "principal", "vice_principal", "teacher"];
const MANAGERS = ["it_admin", "principal", "vice_principal"];
const optText = (v, max) => v == null || v === "" ? true : cleanText(v, max);
const orNull = v => typeof v === "string" && v.trim() ? v.trim() : null;

const deviceOut = d => ({ id: d.id, schoolId: d.school_id, school: d.school_name, kind: d.kind, name: d.name, maker: d.maker, model: d.model, serial: d.serial,
  capabilities: d.capabilities, status: d.status, roomId: d.room_id, room: d.room_name, requestedBy: d.requested_by_name, requestedAt: d.requested_at,
  decidedBy: d.decided_by_name, decidedAt: d.decided_at, note: d.decision_note, hasKey: Boolean(d.token_hash), lastSeenAt: d.last_seen_at ?? null });
const DEVICE_SELECT = `SELECT d.*,s.name AS school_name,r.name AS room_name,rq.display_name AS requested_by_name,dc.display_name AS decided_by_name
  FROM classroom_devices d JOIN schools s ON s.id=d.school_id LEFT JOIN classroom_rooms r ON r.id=d.room_id
  JOIN users rq ON rq.id=d.requested_by LEFT JOIN users dc ON dc.id=d.decided_by`;

export function registerDeviceRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const only = roles => (req, res, next) => roles.includes(req.actor?.role) ? next() : res.status(403).json({ error: "forbidden" });
  const run = (fn, ok = 200) => async (req, res, next) => {
    try { const out = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(ok).json({ data: out }); }
    catch (e) {
      if (e.code === "42501") return res.status(403).json({ error: "forbidden" });
      if (e.code === "23505") return res.status(409).json({ error: "already_exists" });
      sendError(res, next, e);
    }
  };
  // The school a request acts on: IT names one; school staff act on their own.
  const schoolFor = (req, given) => {
    if (req.actor.role === "it_admin") { if (!validId(given)) throw new HttpError(400, "school_required"); return given; }
    return req.actor.schoolId;
  };
  const event = (c, req, deviceId, ev, detail = null) =>
    c.query(`INSERT INTO classroom_device_events(district_id,device_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)`, [req.actor.districtId, deviceId, req.actor.userId, ev, detail]);
  const getDevice = async (c, id) => {
    if (!validId(id)) throw new HttpError(400, "invalid_id");
    const d = await one(c, `${DEVICE_SELECT} WHERE d.id=$1`, [id]);
    if (!d) throw new HttpError(404, "device_not_found");
    return d;
  };

  // ---------- rooms ----------
  app.get("/api/rooms", requireSession, only(READERS), run(async (c, req) => {
    const school = validId(req.query.schoolId) ? req.query.schoolId : null;
    const list = await rows(c, `SELECT r.id,r.school_id,s.name AS school,r.name,r.building,r.capacity FROM classroom_rooms r JOIN schools s ON s.id=r.school_id
        WHERE r.archived_at IS NULL AND ($1::uuid IS NULL OR r.school_id=$1) ORDER BY s.name,r.name`, [school]);
    const devices = await rows(c, `SELECT id,room_id,kind,name FROM classroom_devices WHERE room_id IS NOT NULL AND status='approved' ORDER BY name`);
    return list.map(r => ({ id: r.id, schoolId: r.school_id, school: r.school, name: r.name, building: r.building, capacity: r.capacity,
      devices: devices.filter(d => d.room_id === r.id).map(d => ({ id: d.id, kind: d.kind, name: d.name })) }));
  }));

  const parseRoom = b => cleanText(b.name, 80) && optText(b.building, 80) && (b.capacity == null || b.capacity === "" || (Number.isInteger(+b.capacity) && +b.capacity >= 1 && +b.capacity <= 1000))
    ? [b.name.trim(), orNull(b.building), b.capacity == null || b.capacity === "" ? null : +b.capacity] : null;

  app.post("/api/rooms", limiter, requireSession, requireCsrf, only(MANAGERS), run(async (c, req) => {
    const v = parseRoom(req.body || {});
    if (!v) throw new HttpError(400, "invalid_room");
    const r = await one(c, `INSERT INTO classroom_rooms(district_id,school_id,name,building,capacity,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.actor.districtId, schoolFor(req, req.body.schoolId), ...v, req.actor.userId]);
    await audit(c, req, "create", "classroom_room", r.id, v[0]);
    return r;
  }, 201));

  app.put("/api/rooms/:id", limiter, requireSession, requireCsrf, only(MANAGERS), run(async (c, req) => {
    const v = parseRoom(req.body || {});
    if (!validId(req.params.id) || !v) throw new HttpError(400, "invalid_room");
    const r = await one(c, `UPDATE classroom_rooms SET name=$2,building=$3,capacity=$4 WHERE id=$1 AND archived_at IS NULL RETURNING id`, [req.params.id, ...v]);
    if (!r) throw new HttpError(404, "room_not_found");
    await audit(c, req, "update", "classroom_room", r.id, v[0]);
    return r;
  }));

  app.post("/api/rooms/:id/archive", limiter, requireSession, requireCsrf, only(MANAGERS), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const moved = await rows(c, `UPDATE classroom_devices SET room_id=NULL WHERE room_id=$1 RETURNING id`, [req.params.id]);
    for (const d of moved) await event(c, req, d.id, "removed", "room archived");
    const r = await one(c, `UPDATE classroom_rooms SET archived_at=now() WHERE id=$1 AND archived_at IS NULL RETURNING id`, [req.params.id]);
    if (!r) throw new HttpError(404, "room_not_found");
    await audit(c, req, "archive", "classroom_room", r.id, `devices=${moved.length}`);
    return { archived: true, devicesRemoved: moved.length };
  }));

  // ---------- devices ----------
  app.get("/api/devices", requireSession, only(READERS), run(async (c, req) => {
    const status = ["pending", "approved", "rejected", "retired"].includes(req.query.status) ? req.query.status : null;
    const school = validId(req.query.schoolId) ? req.query.schoolId : null;
    return (await rows(c, `${DEVICE_SELECT} WHERE ($1::text IS NULL AND d.status<>'retired' OR d.status=$1) AND ($2::uuid IS NULL OR d.school_id=$2)
        ORDER BY (d.status='pending') DESC,s.name,d.name LIMIT 2000`, [status, school])).map(deviceOut);
  }));

  app.post("/api/devices", limiter, requireSession, requireCsrf, only(MANAGERS), run(async (c, req) => {
    const v = parseDevice(req.body || {});
    if (!v) throw new HttpError(400, "invalid_device");
    const it = req.actor.role === "it_admin";
    const d = await one(c, `INSERT INTO classroom_devices(district_id,school_id,kind,name,maker,model,serial,capabilities,status,requested_by,decided_by,decided_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [req.actor.districtId, schoolFor(req, req.body.schoolId), v.kind, v.name, v.maker, v.model, v.serial, v.capabilities,
       it ? "approved" : "pending", req.actor.userId, it ? req.actor.userId : null, it ? new Date() : null]);
    await event(c, req, d.id, it ? "registered" : "requested", v.capabilities.join(","));
    await audit(c, req, "create", "classroom_device", d.id, it ? "registered" : "requested");
    return deviceOut(await getDevice(c, d.id));
  }, 201));

  app.put("/api/devices/:id", limiter, requireSession, requireCsrf, only(MANAGERS), run(async (c, req) => {
    const v = parseDevice(req.body || {});
    if (!v) throw new HttpError(400, "invalid_device");
    const before = await getDevice(c, req.params.id);
    if (before.status === "retired") throw new HttpError(409, "device_retired");
    await c.query(`UPDATE classroom_devices SET kind=$2,name=$3,maker=$4,model=$5,serial=$6,capabilities=$7 WHERE id=$1`, [before.id, v.kind, v.name, v.maker, v.model, v.serial, v.capabilities]);
    const d = await getDevice(c, before.id);
    await event(c, req, d.id, "changed", d.status !== before.status ? `needs approval again (${v.capabilities.join(",")})` : null);
    await audit(c, req, "update", "classroom_device", d.id, `status=${d.status}`);
    return deviceOut(d);
  }));

  app.post("/api/devices/:id/decision", limiter, requireSession, requireCsrf, only(["it_admin"]), run(async (c, req) => {
    const { decision, note = null } = req.body || {};
    if (!["approved", "rejected"].includes(decision) || !optText(note, 500)) throw new HttpError(400, "invalid_decision");
    const before = await getDevice(c, req.params.id);
    if (before.status === "retired") throw new HttpError(409, "device_retired");
    await c.query(`UPDATE classroom_devices SET status=$2,decided_by=$3,decided_at=now(),decision_note=$4,room_id=CASE WHEN $2='approved' THEN room_id ELSE NULL END WHERE id=$1`,
      [before.id, decision, req.actor.userId, orNull(note)]);
    await event(c, req, before.id, decision, orNull(note));
    await audit(c, req, "decide", "classroom_device", before.id, decision);
    return deviceOut(await getDevice(c, before.id));
  }));

  app.post("/api/devices/:id/place", limiter, requireSession, requireCsrf, only(MANAGERS), run(async (c, req) => {
    const roomId = req.body?.roomId ?? null;
    if (roomId !== null && !validId(roomId)) throw new HttpError(400, "invalid_room");
    const before = await getDevice(c, req.params.id);
    if (roomId && before.status !== "approved") throw new HttpError(409, "device_not_approved");
    if (roomId && !(await one(c, `SELECT 1 FROM classroom_rooms WHERE id=$1 AND school_id=$2 AND archived_at IS NULL`, [roomId, before.school_id]))) throw new HttpError(404, "room_not_found");
    await c.query(`UPDATE classroom_devices SET room_id=$2 WHERE id=$1`, [before.id, roomId]);
    const d = await getDevice(c, before.id);
    await event(c, req, d.id, roomId ? "placed" : "removed", roomId ? d.room_name : before.room_name);
    await audit(c, req, "update", "classroom_device", d.id, roomId ? "placed" : "removed");
    return deviceOut(d);
  }));

  app.post("/api/devices/:id/retire", limiter, requireSession, requireCsrf, only(MANAGERS), run(async (c, req) => {
    const before = await getDevice(c, req.params.id);
    if (before.status === "retired") throw new HttpError(409, "device_retired");
    await c.query(`UPDATE classroom_devices SET status='retired',room_id=NULL,retired_at=now() WHERE id=$1`, [before.id]);
    await event(c, req, before.id, "retired", orNull(req.body?.note));
    await audit(c, req, "retire", "classroom_device", before.id, null);
    return { retired: true };
  }));

  app.get("/api/devices/:id/events", requireSession, only(READERS), run(async (c, req) => {
    const d = await getDevice(c, req.params.id);
    return rows(c, `SELECT e.event,e.detail,e.at,u.display_name AS by FROM classroom_device_events e JOIN users u ON u.id=e.actor_id WHERE e.device_id=$1 ORDER BY e.at,e.id`, [d.id]);
  }));
}
