// 32.4.0 transport: routes, stops, rider assignments, driver runs and
// board/alight check-ins. There is NO location tracking: no GPS, coordinates
// or device position are accepted or stored. A check-in is the driver tapping
// "On board" or "Off" for a rider at a named stop.
//
// Read scope (API, then RLS again in migration 012):
//   driver       only routes assigned to them and those riders (name, grade, stop)
//   principal    their school; superintendent: the district
//   teacher      their roster learners who ride
//   parent/pupil only their own linked children
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { enqueueNotifications } from "./notify.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError, roleIn } from "./role-app-util.js";
import { queuedAt, idempotencyKey, claimReplay } from "./offline-replay.js";
import { groupTransportEvents } from "./transport-rider-events.js";

const EVENTS = ["boarded", "alighted", "not_riding"];
const EVENT_TEXT = { boarded: "boarded", alighted: "got off", not_riding: "is not riding today" };

// Latest event per rider for one run.
const LATEST = `SELECT DISTINCT ON (c.student_id) c.student_id, c.event, c.recorded_at, c.stop_id
                  FROM transport_checkins c WHERE c.run_id=$1 ORDER BY c.student_id, coalesce(c.observed_at, c.recorded_at) DESC, c.id DESC`;

// Hydrate a whole authorized route set with a fixed number of queries.
// The route list is selected inside the caller's tenant transaction; all child
// queries are constrained to those route/run IDs and remain under the same RLS.
export async function routeDetails(client, routes, { withRiders }) {
  if (!routes.length) return [];
  const routeIds = routes.map(r => r.id);
  const stops = await rows(client, `SELECT id,route_id,seq,name,to_char(scheduled_time,'HH24:MI') AS time,is_school
    FROM transport_stops WHERE route_id=ANY($1::uuid[]) ORDER BY route_id,seq`, [routeIds]);
  const runs = await rows(client, `SELECT x.id,x.route_id,x.status,x.started_at,x.completed_at
    FROM transport_runs x JOIN transport_routes r ON r.id=x.route_id
    WHERE x.route_id=ANY($1::uuid[]) AND x.service_date=eduos_school_today(r.school_id)`, [routeIds]);
  const stopsByRoute = new Map();
  for (const { route_id: routeId, ...stop } of stops) {
    // Same stop shape as before batching (no route_id on each stop).
    if (!stopsByRoute.has(routeId)) stopsByRoute.set(routeId, []);
    stopsByRoute.get(routeId).push(stop);
  }
  const runByRoute = new Map(runs.map(run => [run.route_id, run]));
  if (!withRiders) return routes.map(route => ({
    ...route, stops: stopsByRoute.get(route.id) || [], run: runByRoute.get(route.id) || null
  }));

  const riders = await rows(client, `SELECT a.route_id,a.student_id,a.stop_id,s.display_name,s.grade_level
    FROM transport_rider_assignments a JOIN students s ON s.id=a.student_id
    WHERE a.route_id=ANY($1::uuid[]) AND a.revoked_at IS NULL
    ORDER BY a.route_id,s.display_name`, [routeIds]);
  const ridersByRoute = new Map();
  for (const rider of riders) {
    if (!ridersByRoute.has(rider.route_id)) ridersByRoute.set(rider.route_id, []);
    ridersByRoute.get(rider.route_id).push(rider);
  }
  const runIds = runs.map(run => run.id);
  const latest = runIds.length ? await rows(client, `SELECT DISTINCT ON (c.run_id,c.student_id)
      c.run_id,c.student_id,c.event,c.recorded_at,c.stop_id
    FROM transport_checkins c WHERE c.run_id=ANY($1::uuid[])
    ORDER BY c.run_id,c.student_id,coalesce(c.observed_at,c.recorded_at) DESC,c.id DESC`, [runIds]) : [];
  const latestByRun = new Map();
  for (const event of latest) {
    if (!latestByRun.has(event.run_id)) latestByRun.set(event.run_id, new Map());
    latestByRun.get(event.run_id).set(event.student_id, event);
  }
  return routes.map(route => {
    const routeStops = stopsByRoute.get(route.id) || [];
    const routeRiders = ridersByRoute.get(route.id) || [];
    const run = runByRoute.get(route.id) || null;
    const latestForRun = run ? latestByRun.get(run.id) || new Map() : new Map();
    for (const stop of routeStops) stop.riders = routeRiders.filter(r => r.stop_id === stop.id).map(r => {
      const event = latestForRun.get(r.student_id);
      return { studentId: r.student_id, name: r.display_name, grade: r.grade_level,
        status: event?.event || "expected", at: event?.recorded_at || null };
    });
    const latestEvents = [...latestForRun.values()];
    const counts = {
      riders: routeRiders.length,
      boarded: latestEvents.filter(e => e.event === "boarded").length,
      alighted: latestEvents.filter(e => e.event === "alighted").length,
      notRiding: latestEvents.filter(e => e.event === "not_riding").length
    };
    counts.onBoard = counts.boarded;
    counts.expected = routeRiders.length - latestEvents.length;
    return { ...route, stops: routeStops, run, counts };
  });
}

export function registerTransportRoutes(app) {
  const checkinLimiter = rateLimit({ windowMs: 60_000, limit: config.transportCheckinRateLimit, standardHeaders: true, legacyHeaders: false });

  // ---- today's view for the signed-in role ----
  app.get("/api/transport/today", requireSession, requirePermission("transport", "read"), async (req, res, next) => {
    const a = req.actor;
    try {
      const data = await withTenantTransaction(a, async client => {
        if (a.role === "driver") {
          const routes = await rows(client, `SELECT r.id,r.name,r.bus_label,r.direction,r.school_id,sc.name AS school_name FROM transport_routes r
              JOIN schools sc ON sc.id=r.school_id WHERE r.driver_user_id=$1 AND r.status='active' AND r.school_id=$2 ORDER BY r.direction,r.name`, [a.userId, a.schoolId]);
          const out = await routeDetails(client, routes, { withRiders: true });
          await audit(client, req, "read", "transport_manifest", null, `routes=${out.length}`);
          return { role: a.role, routes: out };
        }
        // School leaders: their school's runs (the superintendent: any school).
        if (["principal", "vice_principal", "superintendent"].includes(a.role)) {
          const schoolId = a.role === "superintendent" ? (validId(req.query.schoolId) ? req.query.schoolId : null) : a.schoolId;
          const routes = await rows(client, `SELECT r.id,r.name,r.bus_label,r.direction,r.school_id,sc.name AS school_name,u.display_name AS driver_name
              FROM transport_routes r JOIN schools sc ON sc.id=r.school_id LEFT JOIN users u ON u.id=r.driver_user_id
             WHERE r.status='active' AND ($1::uuid IS NULL OR r.school_id=$1) ORDER BY sc.name,r.direction,r.name`, [schoolId]);
          const out = await routeDetails(client, routes, { withRiders: true });
          for (const d of out) for (const s of d.stops) delete s.riders;
          await audit(client, req, "read", "transport_status", schoolId, `routes=${out.length}`);
          return { role: a.role, routes: out };
        }
        // teacher (roster learners), parent/pupil (linked children); no other role sees riders.
        if (!["teacher", "parent", "pupil"].includes(a.role)) return { role: a.role, riders: [] };
        const scope = a.role === "teacher"
          ? `s.school_id=$2::uuid AND EXISTS(SELECT 1 FROM teacher_student_rosters tr WHERE tr.student_id=s.id AND tr.teacher_user_id=$1)`
          : `EXISTS(SELECT 1 FROM student_user_links l WHERE l.student_id=s.id AND l.user_id=$1 AND l.status='active'
               AND l.relationship = ANY($2::text[]))`;
        const scopeArg = a.role === "teacher" ? a.schoolId : (a.role === "pupil" ? ["pupil"] : ["parent", "guardian"]);
        const kids = await rows(client, `SELECT s.id,s.display_name,s.grade_level,ra.route_id,r.name AS route_name,r.bus_label,r.direction,
              st.id AS stop_id,st.name AS stop_name,to_char(st.scheduled_time,'HH24:MI') AS stop_time,
              x.id AS run_id,x.status AS run_status
            FROM students s
            JOIN transport_rider_assignments ra ON ra.student_id=s.id AND ra.revoked_at IS NULL
            JOIN transport_routes r ON r.id=ra.route_id AND r.status='active'
            JOIN transport_stops st ON st.id=ra.stop_id
            LEFT JOIN transport_runs x ON x.route_id=r.id AND x.service_date=eduos_school_today(r.school_id)
           WHERE ${scope} ORDER BY s.display_name,r.direction`, [a.userId, scopeArg]);
        // Fetch every visible rider's events in one round trip instead of
        // issuing one sequential query per child. The target pairs come only
        // from the already-authorized, tenant-scoped rider query above.
        const activeRiders = kids.filter(k => k.run_id);
        const eventsByRider = new Map();
        if (activeRiders.length) {
          const eventRows = await rows(client, `SELECT c.run_id,c.student_id,c.event,c.recorded_at,st.name AS stop_name,st.is_school
              FROM unnest($1::uuid[],$2::uuid[]) AS target(run_id,student_id)
              JOIN transport_checkins c ON c.run_id=target.run_id AND c.student_id=target.student_id
              JOIN transport_stops st ON st.id=c.stop_id
             ORDER BY c.run_id,c.student_id,c.recorded_at,c.id`,
            [activeRiders.map(k => k.run_id), activeRiders.map(k => k.id)]);
          for (const [key, events] of groupTransportEvents(eventRows)) eventsByRider.set(key, events);
        }
        for (const k of kids) {
          k.events = k.run_id ? (eventsByRider.get(`${k.run_id}:${k.id}`) || []) : [];
          k.status = k.events.length ? k.events[k.events.length - 1].event : (k.run_id ? "expected" : "not_started");
        }
        await audit(client, req, "read", "transport_rider_status", null, `learners=${new Set(kids.map(k => k.id)).size}`);
        return { role: a.role, riders: kids };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // ---- driver: start today's run (idempotent) ----
  app.post("/api/transport/runs", requireSession, requireCsrf, requirePermission("transport", "checkin"), async (req, res, next) => {
    const { routeId } = req.body || {};
    if (!validId(routeId)) return res.status(400).json({ error: "invalid_route_id" });
    try {
      const run = await withTenantTransaction(req.actor, async client => {
        const route = await one(client, `SELECT id,school_id FROM transport_routes WHERE id=$1 AND driver_user_id=$2 AND status='active' AND school_id=$3`, [routeId, req.actor.userId, req.actor.schoolId]);
        if (!route) throw new HttpError(404, "route_not_assigned");
        const existing = await one(client, `SELECT id,status,started_at FROM transport_runs WHERE route_id=$1 AND service_date=eduos_school_today($2)`, [routeId, route.school_id]);
        if (existing) return { ...existing, created: false };
        const r = await one(client, `INSERT INTO transport_runs(district_id,school_id,route_id,driver_user_id,service_date) VALUES($1,$2,$3,$4,eduos_school_today($2)) RETURNING id,status,started_at`,
          [req.actor.districtId, route.school_id, routeId, req.actor.userId]);
        await audit(client, req, "create", "transport_run", r.id, `route=${routeId}`);
        return { ...r, created: true };
      });
      res.status(run.created ? 201 : 200).json({ data: run });
    } catch (e) { sendError(res, next, e); }
  });

  // ---- driver (or principal, for corrections): ON BOARD / OFF check-in ----
  app.post("/api/transport/runs/:runId/checkins", checkinLimiter, requireSession, requireCsrf, roleIn("driver", "principal"), async (req, res, next) => {
    const { studentId, stopId, event, note = null } = req.body || {};
    if (!validId(req.params.runId) || !validId(studentId) || !validId(stopId) || !EVENTS.includes(event) || (note !== null && !cleanText(note, 200)))
      return res.status(400).json({ error: "invalid_checkin", events: EVENTS });
    for (const k of ["lat", "lng", "latitude", "longitude", "location", "coords", "gps"])
      if (k in (req.body || {})) return res.status(400).json({ error: "location_not_accepted" });
    let observed;
    try { observed = queuedAt(req); idempotencyKey(req); } catch (e) { return res.status(e.status).json({ error: e.code }); }
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const run = await one(client, `SELECT x.id,x.status,x.route_id,x.school_id,x.driver_user_id,x.started_at,x.completed_at,r.bus_label FROM transport_runs x JOIN transport_routes r ON r.id=x.route_id WHERE x.id=$1`, [req.params.runId]);
        if (!run) throw new HttpError(404, "run_not_found");
        if (req.actor.role === "driver" && run.driver_user_id !== req.actor.userId) throw new HttpError(403, "not_your_run");
        if (req.actor.role === "principal" && run.school_id !== req.actor.schoolId) throw new HttpError(404, "run_not_found");
        // 32.7.0: a check-in queued offline during the run is accepted after it completed.
        const lateButValid = observed && run.completed_at && observed <= new Date(run.completed_at) && observed >= new Date(run.started_at);
        if (run.status !== "in_progress" && !lateButValid) throw new HttpError(409, "run_not_in_progress");
        if (await claimReplay(client, req, "checkin", observed)) return { duplicate: true };
        const assignment = await one(client, `SELECT a.id,s.display_name FROM transport_rider_assignments a JOIN students s ON s.id=a.student_id
            WHERE a.route_id=$1 AND a.student_id=$2 AND a.revoked_at IS NULL`, [run.route_id, studentId]);
        if (!assignment) throw new HttpError(404, "rider_not_on_route");
        const stop = await one(client, `SELECT id,name,is_school FROM transport_stops WHERE id=$1 AND route_id=$2`, [stopId, run.route_id]);
        if (!stop) throw new HttpError(400, "stop_not_on_route");
        const c = await one(client, `INSERT INTO transport_checkins(district_id,school_id,run_id,student_id,stop_id,event,recorded_by,note,observed_at,queued)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,event,recorded_at,observed_at,queued`,
          [req.actor.districtId, run.school_id, run.id, studentId, stopId, event, req.actor.userId, note, observed, Boolean(observed)]);
        await audit(client, req, "checkin", "transport_checkin", c.id, `run=${run.id};event=${event}`);
        // Tell the learner's guardians in the app (external channels get generic text only).
        const guardians = await rows(client, `SELECT user_id FROM student_user_links WHERE student_id=$1 AND status='active' AND relationship IN ('parent','guardian')`, [studentId]);
        const first = assignment.display_name.split(/\s+/)[0];
        const where = stop.is_school ? "at school" : `at ${stop.name}`;
        await enqueueNotifications(client, { districtId: req.actor.districtId, schoolId: run.school_id, recipients: guardians.map(g => g.user_id), kind: "transport",
          title: event === "not_riding" ? `${first} is not riding ${run.bus_label} today` : `${first} ${EVENT_TEXT[event]} ${run.bus_label} ${where}`,
          body: null, refType: "transport_checkin", refId: c.id });
        return c;
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  // ---- driver: finish the run; refuses while riders are still on board ----
  app.post("/api/transport/runs/:runId/complete", requireSession, requireCsrf, roleIn("driver", "principal"), async (req, res, next) => {
    if (!validId(req.params.runId)) return res.status(400).json({ error: "invalid_run_id" });
    const confirm = req.body?.confirmRidersOnBoard === true;
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const run = await one(client, `SELECT id,status,driver_user_id,school_id FROM transport_runs WHERE id=$1`, [req.params.runId]);
        if (!run || (req.actor.role === "principal" && run.school_id !== req.actor.schoolId)) throw new HttpError(404, "run_not_found");
        if (req.actor.role === "driver" && run.driver_user_id !== req.actor.userId) throw new HttpError(403, "not_your_run");
        if (run.status === "completed") return { id: run.id, status: "completed" };
        const onBoard = (await rows(client, LATEST, [run.id])).filter(l => l.event === "boarded").length;
        if (onBoard > 0 && !confirm) throw new HttpError(409, "riders_still_on_board", { onBoard });
        await client.query(`UPDATE transport_runs SET status='completed',completed_at=now() WHERE id=$1`, [run.id]);
        await audit(client, req, "complete", "transport_run", run.id, `on_board_at_completion=${onBoard}`);
        return { id: run.id, status: "completed", onBoardAtCompletion: onBoard };
      });
      res.json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  // ---- principal / superintendent: manage routes, stops and riders ----
  app.get("/api/transport/routes", requireSession, requirePermission("transport", "manage"), async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const list = await rows(client, `SELECT r.id,r.name,r.bus_label,r.direction,r.school_id,r.driver_user_id,u.display_name AS driver_name,r.status
            FROM transport_routes r LEFT JOIN users u ON u.id=r.driver_user_id
           WHERE ($1='superintendent' OR r.school_id=$2) ORDER BY r.name`, [req.actor.role, req.actor.schoolId]);
        const out = await routeDetails(client, list, { withRiders: true });
        await audit(client, req, "read", "transport_routes", null, `routes=${out.length}`);
        return out;
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/transport/routes", requireSession, requireCsrf, requirePermission("transport", "manage"), async (req, res, next) => {
    const { name, busLabel, direction, driverUserId = null, stops, schoolId: bodySchool } = req.body || {};
    const schoolId = req.actor.role === "principal" ? req.actor.schoolId : bodySchool;
    if (!cleanText(name, 80) || !cleanText(busLabel, 40) || !["am", "pm"].includes(direction) || !validId(schoolId) ||
        (driverUserId !== null && !validId(driverUserId)) || !Array.isArray(stops) || stops.length < 1 || stops.length > 60 ||
        !stops.every(s => cleanText(s?.name, 120) && (s.time === undefined || s.time === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time))))
      return res.status(400).json({ error: "invalid_route" });
    try {
      const route = await withTenantTransaction(req.actor, async client => {
        if (driverUserId) {
          const d = await one(client, `SELECT 1 FROM memberships WHERE user_id=$1 AND school_id=$2 AND role='driver' AND status='active'`, [driverUserId, schoolId]);
          if (!d) throw new HttpError(400, "driver_not_in_school");
        }
        const r = await one(client, `INSERT INTO transport_routes(district_id,school_id,name,bus_label,direction,driver_user_id,created_by)
            VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,bus_label,direction,driver_user_id`,
          [req.actor.districtId, schoolId, name.trim(), busLabel.trim(), direction, driverUserId, req.actor.userId]);
        let seq = 1;
        for (const s of stops)
          await client.query(`INSERT INTO transport_stops(district_id,school_id,route_id,seq,name,scheduled_time,is_school) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [req.actor.districtId, schoolId, r.id, seq++, s.name.trim(), s.time || null, s.isSchool === true]);
        await audit(client, req, "create", "transport_route", r.id, `stops=${stops.length}`);
        return r;
      });
      res.status(201).json({ data: route });
    } catch (e) {
      if (e?.code === "23505") return res.status(409).json({ error: "route_name_taken" });
      sendError(res, next, e);
    }
  });

  app.post("/api/transport/routes/:routeId/riders", requireSession, requireCsrf, requirePermission("transport", "manage"), async (req, res, next) => {
    const { studentId, stopId } = req.body || {};
    if (!validId(req.params.routeId) || !validId(studentId) || !validId(stopId)) return res.status(400).json({ error: "invalid_rider" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const route = await one(client, `SELECT id,school_id FROM transport_routes WHERE id=$1 AND status='active' AND ($2='superintendent' OR school_id=$3)`, [req.params.routeId, req.actor.role, req.actor.schoolId]);
        if (!route) throw new HttpError(404, "route_not_found");
        const student = await one(client, `SELECT id FROM students WHERE id=$1 AND school_id=$2`, [studentId, route.school_id]);
        if (!student) throw new HttpError(404, "student_not_in_school");
        const stop = await one(client, `SELECT id FROM transport_stops WHERE id=$1 AND route_id=$2`, [stopId, route.id]);
        if (!stop) throw new HttpError(400, "stop_not_on_route");
        const a = await one(client, `INSERT INTO transport_rider_assignments(district_id,school_id,route_id,stop_id,student_id,created_by)
            VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [req.actor.districtId, route.school_id, route.id, stopId, studentId, req.actor.userId]);
        await audit(client, req, "create", "transport_rider_assignment", a.id, `route=${route.id}`);
        return a;
      });
      res.status(201).json({ data: out });
    } catch (e) {
      if (e?.code === "23505") return res.status(409).json({ error: "already_assigned" });
      sendError(res, next, e);
    }
  });

  app.delete("/api/transport/routes/:routeId/riders/:studentId", requireSession, requireCsrf, requirePermission("transport", "manage"), async (req, res, next) => {
    if (!validId(req.params.routeId) || !validId(req.params.studentId)) return res.status(400).json({ error: "invalid_rider" });
    try {
      const n = await withTenantTransaction(req.actor, async client => {
        const r = await client.query(`UPDATE transport_rider_assignments SET revoked_at=now(),revoked_by=$3
            WHERE route_id=$1 AND student_id=$2 AND revoked_at IS NULL RETURNING id`, [req.params.routeId, req.params.studentId, req.actor.userId]);
        if (r.rowCount) await audit(client, req, "revoke", "transport_rider_assignment", r.rows[0].id);
        return r.rowCount;
      });
      if (!n) return res.status(404).json({ error: "assignment_not_found" });
      res.json({ data: { revoked: true } });
    } catch (e) { sendError(res, next, e); }
  });
}
