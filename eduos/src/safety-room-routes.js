// SAFE-01: room status during an emergency.
//
// While an incident is live, every adult in a room at the school reports how
// it stands: secured, not secured, needs help, or moved out. Leads and the
// school's resource officers see a board of every room, and "needs help"
// alerts them at once. Reports carry counts and a short note, never student
// names or locations; a person picks the room.
//
// Row-level security (db/119) enforces who reports and who sees the board;
// the routes check the same so the answers are clear.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { enqueueNotifications } from "./notify.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { LIVE, KIND_LABEL, HAZARDS, HAZARD_LABEL } from "./safety-model.js";
import { queuedAt, idempotencyKey, claimReplay } from "./offline-replay.js";
import { ROOM_STATUSES, ROOM_NEEDS, REPORTER_ROLES, VIEWER_ROLES, NEED_TEXT, parseRoomReport, roomBoard } from "./safety-rooms.js";

const REPORT_COLS = `r.id,r.room_id,r.place,r.status,r.need,r.students,r.adults,r.note,r.reporter_role,coalesce(r.observed_at,r.reported_at) AS at,u.display_name AS by_name`;
const shape = r => ({ id: r.id, roomId: r.room_id, place: r.place, status: r.status, need: r.need, students: r.students, adults: r.adults, note: r.note,
  by: r.by_name, role: r.reporter_role, at: r.at });

export function registerSafetyRoomRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: config.safetyRateLimit, standardHeaders: true, legacyHeaders: false });
  const loadIncident = (client, id) => one(client, `SELECT i.id,i.school_id,i.kind,i.hazard,i.is_drill,i.status,sc.name AS school_name FROM safety_incidents i JOIN schools sc ON sc.id=i.school_id WHERE i.id=$1`, [id]);

  // My room: the rooms to choose from, the one I'm timetabled in, and what I last sent.
  app.get("/api/safety/incidents/:id/my-room", requireSession, requirePermission("safety", "read"), async (req, res, next) => {
    const a = req.actor;
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_incident_id" });
    if (!REPORTER_ROLES.includes(a.role)) return res.status(403).json({ error: "role_not_allowed" });
    try {
      const data = await withTenantTransaction(a, async client => {
        const i = await loadIncident(client, req.params.id);
        if (!i || i.school_id !== a.schoolId) throw new HttpError(404, "incident_not_found");
        const rooms = await rows(client, `SELECT * FROM eduos_safety_school_rooms($1)`, [i.id]);
        const now = (await one(client, `SELECT eduos_safety_my_room_now() AS id`)).id;
        const mine = await rows(client, `SELECT ${REPORT_COLS} FROM safety_room_reports r JOIN users u ON u.id=r.reported_by
            WHERE r.incident_id=$1 AND r.reported_by=$2 ORDER BY coalesce(r.observed_at,r.reported_at) DESC,r.id DESC LIMIT 5`, [i.id, a.userId]);
        // SAFE-03: each room's shelter area for this hazard (else the school default).
        const areas = i.hazard ? await rows(client, `SELECT room_id,area,route FROM school_shelter_areas WHERE school_id=$1 AND hazard=$2 AND ended_at IS NULL`, [i.school_id, i.hazard]) : [];
        const fallback = areas.find(x => !x.room_id) || null;
        const areaFor = id => { const x = areas.find(y => y.room_id === id) || fallback; return x ? { area: x.area, route: x.route } : null; };
        return { incidentId: i.id, live: LIVE.includes(i.status), hazard: i.hazard, hazardLabel: i.hazard ? HAZARD_LABEL[i.hazard] : null,
          defaultArea: fallback ? { area: fallback.area, route: fallback.route } : null,
          rooms: rooms.map(r => ({ id: r.id, name: r.name, building: r.building, kind: r.kind, shelter: i.hazard ? areaFor(r.id) : null })),
          suggestedRoomId: mine[0]?.room_id || now || null, last: mine[0] ? shape(mine[0]) : null };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/safety/incidents/:id/room-status", limiter, requireSession, requireCsrf, requirePermission("safety", "read"), async (req, res, next) => {
    const a = req.actor;
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_incident_id" });
    if (!REPORTER_ROLES.includes(a.role)) return res.status(403).json({ error: "role_not_allowed" });
    const r = parseRoomReport(req.body);
    if (!r) return res.status(400).json({ error: "invalid_room_status", statuses: ROOM_STATUSES, needs: ROOM_NEEDS });
    let observed;
    try { observed = queuedAt(req); idempotencyKey(req); } catch (e) { return res.status(e.status).json({ error: e.code }); }
    try {
      const out = await withTenantTransaction(a, async client => {
        const i = await loadIncident(client, req.params.id);
        if (!i || i.school_id !== a.schoolId) throw new HttpError(404, "incident_not_found");
        if (!LIVE.includes(i.status)) throw new HttpError(409, "incident_not_live");
        if (await claimReplay(client, req, "room_status", observed)) return { duplicate: true };
        let roomName = r.place;
        if (r.roomId) {
          const room = await one(client, `SELECT name FROM eduos_safety_school_rooms($1) WHERE id=$2`, [i.id, r.roomId]);
          if (!room) throw new HttpError(404, "room_not_found");
          roomName = room.name;
        }
        const row = await one(client, `INSERT INTO safety_room_reports(district_id,school_id,incident_id,room_id,place,status,need,students,adults,note,reported_by,reporter_role,observed_at,queued)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id,reported_at`,
          [a.districtId, i.school_id, i.id, r.roomId, r.place, r.status, r.need, r.students, r.adults, r.note, a.userId, a.role, observed, Boolean(observed)]);
        await audit(client, req, "room_status", "safety_incident", i.id, `status=${r.status}${r.need ? ` need=${r.need}` : ""}`);
        let alerted = 0;
        if (r.status === "needs_help" || r.status === "not_secured") {
          const to = (await rows(client, `SELECT user_id FROM eduos_safety_room_alert_recipients($1)`, [i.id])).map(x => x.user_id).filter(u => u !== a.userId);
          if (to.length) {
            await enqueueNotifications(client, { districtId: a.districtId, schoolId: i.school_id, recipients: to, kind: "safety", refType: "safety_incident", refId: i.id,
              title: r.status === "needs_help" ? `${roomName} needs ${NEED_TEXT[r.need]}` : `${roomName} is not secured`,
              body: `${KIND_LABEL[i.kind]}${i.is_drill ? " (drill)" : ""}. Open the room board.${r.note ? ` Note: ${r.note}` : ""}` });
            alerted = to.length;
          }
        }
        return { id: row.id, status: r.status, room: roomName, alerted, at: observed || row.reported_at };
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  // ---- SAFE-03: shelter areas, per room and hazard (and a school default) ----
  const AREA_READERS = ["principal", "superintendent", "sro", "teacher"];
  app.get("/api/safety/shelter-areas", requireSession, requirePermission("safety", "read"), async (req, res, next) => {
    const a = req.actor;
    if (!AREA_READERS.includes(a.role)) return res.status(403).json({ error: "role_not_allowed" });
    const schoolId = a.role === "superintendent" ? req.query.schoolId : a.schoolId;
    if (!validId(schoolId)) return res.status(400).json({ error: "invalid_school_id" });
    try {
      const data = await withTenantTransaction(a, async client => {
        const rooms = await rows(client, `SELECT id,name,building FROM classroom_rooms WHERE school_id=$1 AND archived_at IS NULL ORDER BY building NULLS FIRST,name`, [schoolId]);
        const areas = await rows(client, `SELECT a.id,a.room_id,a.hazard,a.area,a.route,a.set_at,u.display_name AS set_by FROM school_shelter_areas a JOIN users u ON u.id=a.set_by
            WHERE a.school_id=$1 AND a.ended_at IS NULL`, [schoolId]);
        const pick = room => Object.fromEntries(areas.filter(x => x.room_id === room).map(x => [x.hazard, { id: x.id, area: x.area, route: x.route, setBy: x.set_by, setAt: x.set_at }]));
        return { schoolId, hazards: HAZARDS.map(h => ({ key: h, label: HAZARD_LABEL[h] })), canEdit: ["principal", "superintendent"].includes(a.role),
          defaults: pick(null), rooms: rooms.map(r => ({ id: r.id, name: r.name, building: r.building, areas: pick(r.id) })) };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // Set (or clear, with an empty area) a room's area for a hazard; roomId null = the school default.
  app.put("/api/safety/shelter-areas", limiter, requireSession, requireCsrf, requirePermission("safety", "read"), async (req, res, next) => {
    const a = req.actor;
    if (!["principal", "superintendent"].includes(a.role)) return res.status(403).json({ error: "role_not_allowed" });
    const { roomId = null, hazard, area = "", route = null } = req.body || {};
    const schoolId = a.role === "superintendent" ? req.body?.schoolId : a.schoolId;
    const clear = typeof area === "string" && area.trim() === "";
    if (!validId(schoolId) || (roomId !== null && !validId(roomId)) || !HAZARDS.includes(hazard) || typeof area !== "string"
        || (!clear && !cleanText(area, 120, 2)) || (route !== null && route !== "" && !cleanText(route, 300)))
      return res.status(400).json({ error: "invalid_shelter_area", hazards: HAZARDS });
    try {
      const data = await withTenantTransaction(a, async client => {
        if (roomId && !(await one(client, `SELECT id FROM classroom_rooms WHERE id=$1 AND school_id=$2 AND archived_at IS NULL`, [roomId, schoolId]))) throw new HttpError(404, "room_not_found");
        if (!roomId && !(await one(client, `SELECT id FROM schools WHERE id=$1`, [schoolId]))) throw new HttpError(404, "school_not_found");
        await client.query(`UPDATE school_shelter_areas SET ended_at=now(),ended_by=$4 WHERE school_id=$1 AND room_id IS NOT DISTINCT FROM $2 AND hazard=$3 AND ended_at IS NULL`, [schoolId, roomId, hazard, a.userId]);
        let id = null;
        if (!clear) id = (await one(client, `INSERT INTO school_shelter_areas(district_id,school_id,room_id,hazard,area,route,set_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [a.districtId, schoolId, roomId, hazard, area.trim(), route?.trim() || null, a.userId])).id;
        await audit(client, req, clear ? "clear" : "set", "shelter_area", roomId || schoolId, hazard);
        return { id, roomId, hazard, area: clear ? null : area.trim() };
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // SAFE-02: which displays, kiosks and student devices have switched to the alert.
  app.get("/api/safety/incidents/:id/displays", requireSession, requirePermission("safety", "read"), async (req, res, next) => {
    const a = req.actor;
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_incident_id" });
    if (!VIEWER_ROLES.includes(a.role)) return res.status(403).json({ error: "role_not_allowed" });
    try {
      const data = await withTenantTransaction(a, async client => {
        const i = await loadIncident(client, req.params.id);
        if (!i || (a.role !== "superintendent" && i.school_id !== a.schoolId)) throw new HttpError(404, "incident_not_found");
        const list = await rows(client, `SELECT * FROM eduos_safety_displays($1)`, [i.id]);
        return { total: list.length, switched: list.filter(d => d.switched).length,
          devices: list.map(d => ({ id: d.id, name: d.name, kind: d.kind, room: d.room, lastSeenAt: d.last_seen_at, switched: d.switched })) };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // The room board: leads, vice principals, resource officers, the superintendent.
  app.get("/api/safety/incidents/:id/rooms", requireSession, requirePermission("safety", "read"), async (req, res, next) => {
    const a = req.actor;
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_incident_id" });
    if (!VIEWER_ROLES.includes(a.role)) return res.status(403).json({ error: "role_not_allowed" });
    try {
      const data = await withTenantTransaction(a, async client => {
        const i = await loadIncident(client, req.params.id);
        if (!i || (a.role !== "superintendent" && i.school_id !== a.schoolId)) throw new HttpError(404, "incident_not_found");
        const rooms = await rows(client, `SELECT * FROM eduos_safety_school_rooms($1)`, [i.id]);
        const reports = (await rows(client, `SELECT ${REPORT_COLS} FROM safety_room_reports r JOIN users u ON u.id=r.reported_by
            WHERE r.incident_id=$1 ORDER BY coalesce(r.observed_at,r.reported_at) DESC,r.id DESC LIMIT 2000`, [i.id])).map(shape);
        await audit(client, req, "read", "safety_room_board", i.id, `reports=${reports.length}`);
        return { incident: { id: i.id, kind: i.kind, label: KIND_LABEL[i.kind], isDrill: i.is_drill, status: i.status, schoolName: i.school_name }, ...roomBoard(rooms, reports) };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });
}
