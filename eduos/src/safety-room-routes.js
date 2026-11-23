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
import { audit, rows, one, validId, HttpError, sendError } from "./role-app-util.js";
import { LIVE, KIND_LABEL } from "./safety-model.js";
import { queuedAt, idempotencyKey, claimReplay } from "./offline-replay.js";
import { ROOM_STATUSES, ROOM_NEEDS, REPORTER_ROLES, VIEWER_ROLES, NEED_TEXT, parseRoomReport, roomBoard } from "./safety-rooms.js";

const REPORT_COLS = `r.id,r.room_id,r.place,r.status,r.need,r.students,r.adults,r.note,r.reporter_role,coalesce(r.observed_at,r.reported_at) AS at,u.display_name AS by_name`;
const shape = r => ({ id: r.id, roomId: r.room_id, place: r.place, status: r.status, need: r.need, students: r.students, adults: r.adults, note: r.note,
  by: r.by_name, role: r.reporter_role, at: r.at });

export function registerSafetyRoomRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: config.safetyRateLimit, standardHeaders: true, legacyHeaders: false });
  const loadIncident = (client, id) => one(client, `SELECT i.id,i.school_id,i.kind,i.is_drill,i.status,sc.name AS school_name FROM safety_incidents i JOIN schools sc ON sc.id=i.school_id WHERE i.id=$1`, [id]);

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
        return { incidentId: i.id, live: LIVE.includes(i.status), rooms: rooms.map(r => ({ id: r.id, name: r.name, building: r.building, kind: r.kind })),
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
