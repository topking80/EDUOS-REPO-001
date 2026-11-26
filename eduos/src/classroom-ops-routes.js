// Classrooms operations (db/154): school bell schedules and teacher-managed
// course seating charts. Extends courses, course_enrollments and classroom_rooms.
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, HttpError, sendError } from "./role-app-util.js";
import { hhmm, parseBellSchedule, parseSeatingChart } from "./classroom-ops.js";

const DISTRICT = role => ["superintendent", "it_admin"].includes(role);
const LEAD = role => ["superintendent", "principal", "vice_principal"].includes(role);
const READERS = ["superintendent", "it_admin", "principal", "vice_principal", "teacher", "parent", "pupil"];

const wrap = fn => async (req, res, next) => {
  try {
    const data = await withTenantTransaction(req.actor, c => fn(c, req));
    res.setHeader("Cache-Control", "no-store");
    res.json({ data });
  } catch (e) { sendError(res, next, e); }
};

async function loadSchedules(c, districtId, schoolId) {
  const list = await rows(c, `SELECT id,school_id,name,day_type,is_default,status,updated_at
      FROM school_bell_schedules WHERE district_id=$1 AND school_id=$2 AND status='active'
      ORDER BY is_default DESC,name`, [districtId, schoolId]);
  if (!list.length) return [];
  const periods = await rows(c, `SELECT id,schedule_id,seq,label,kind,starts,ends
      FROM school_bell_periods WHERE district_id=$1 AND schedule_id = ANY($2::uuid[])
      ORDER BY schedule_id,starts,seq`, [districtId, list.map(s => s.id)]);
  return list.map(s => ({
    id: s.id,
    schoolId: s.school_id,
    name: s.name,
    dayType: s.day_type,
    isDefault: s.is_default,
    periods: periods.filter(p => p.schedule_id === s.id).map(p => ({
      id: p.id, seq: p.seq, label: p.label, kind: p.kind, starts: hhmm(p.starts), ends: hhmm(p.ends)
    }))
  }));
}

export function registerClassroomOpsRoutes(app) {
  app.get("/api/schools/bell-schedules", requireSession, wrap(async (c, req) => {
    const a = req.actor;
    if (!READERS.includes(a.role)) throw new HttpError(403, "bell_schedule_forbidden");
    const schoolId = DISTRICT(a.role) && validId(req.query?.schoolId) ? req.query.schoolId : a.schoolId;
    if (!validId(schoolId)) throw new HttpError(400, "school_id_required");
    if (!DISTRICT(a.role) && schoolId !== a.schoolId) throw new HttpError(403, "school_scope_denied");
    const schedules = await loadSchedules(c, a.districtId, schoolId);
    const todaySchedule = schedules.find(s => s.isDefault) || schedules[0] || null;
    return { schoolId, schedules, todaySchedule };
  }));

  app.post("/api/schools/bell-schedules", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor;
    if (!LEAD(a.role)) return res.status(403).json({ error: "bell_schedule_manage_forbidden" });
    const v = parseBellSchedule(req.body);
    if (!v) return res.status(400).json({ error: "invalid_bell_schedule" });
    const schoolId = DISTRICT(a.role) && validId(req.body?.schoolId) ? req.body.schoolId : a.schoolId;
    if (!validId(schoolId)) return res.status(400).json({ error: "school_id_required" });
    if (!DISTRICT(a.role) && schoolId !== a.schoolId) return res.status(403).json({ error: "school_scope_denied" });
    try {
      const data = await withTenantTransaction(a, async c => {
        if (!await one(c, "SELECT id FROM schools WHERE id=$1 AND district_id=$2", [schoolId, a.districtId]))
          throw new HttpError(400, "school_outside_district");
        if (v.isDefault) {
          await c.query("UPDATE school_bell_schedules SET is_default=false,updated_at=now() WHERE district_id=$1 AND school_id=$2 AND is_default AND status='active'", [a.districtId, schoolId]);
        }
        let sched;
        if (v.id) {
          sched = await one(c, `UPDATE school_bell_schedules SET name=$3,day_type=$4,is_default=$5,updated_at=now()
              WHERE id=$1 AND district_id=$2 AND school_id=$6 AND status='active' RETURNING id,name,day_type,is_default`,
            [v.id, a.districtId, v.name, v.dayType, v.isDefault, schoolId]);
          if (!sched) throw new HttpError(404, "bell_schedule_not_found");
          await c.query("DELETE FROM school_bell_periods WHERE district_id=$1 AND schedule_id=$2", [a.districtId, sched.id]);
        } else {
          sched = await one(c, `INSERT INTO school_bell_schedules(district_id,school_id,name,day_type,is_default,created_by)
              VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,day_type,is_default`,
            [a.districtId, schoolId, v.name, v.dayType, v.isDefault, a.userId]);
        }
        for (const p of v.periods) {
          await c.query(`INSERT INTO school_bell_periods(district_id,school_id,schedule_id,seq,label,kind,starts,ends)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [a.districtId, schoolId, sched.id, p.seq, p.label, p.kind, p.starts, p.ends]);
        }
        await audit(c, req, v.id ? "update" : "create", "school_bell_schedule", sched.id, `dayType=${v.dayType};periods=${v.periods.length};default=${v.isDefault}`);
        const all = await loadSchedules(c, a.districtId, schoolId);
        return all.find(s => s.id === sched.id);
      });
      res.status(v.id ? 200 : 201).json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/schools/bell-schedules/:id/archive", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor;
    if (!LEAD(a.role)) return res.status(403).json({ error: "bell_schedule_manage_forbidden" });
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_bell_schedule_id" });
    try {
      const data = await withTenantTransaction(a, async c => {
        const s = await one(c, `UPDATE school_bell_schedules SET status='archived',is_default=false,updated_at=now()
            WHERE id=$1 AND district_id=$2 AND ($3::uuid IS NULL OR school_id=$3) AND status='active' RETURNING id,status`,
          [req.params.id, a.districtId, DISTRICT(a.role) ? null : a.schoolId]);
        if (!s) throw new HttpError(404, "bell_schedule_not_found");
        await audit(c, req, "archive", "school_bell_schedule", s.id);
        return s;
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // Course manager: full chart. Families: only their own learner's seat, and only when share_with_families is on.
  app.get("/api/learning/courses/:id/seating", requireSession, wrap(async (c, req) => {
    const a = req.actor;
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_course_id");
    const course = await one(c, `SELECT id,school_id,title,eduos_can_manage_course(id) AS manage,eduos_can_read_seating_chart(id) AS ok FROM courses WHERE id=$1 AND district_id=$2`, [req.params.id, a.districtId]);
    if (!course) throw new HttpError(404, "course_not_found");
    const chart = await one(c, `SELECT ch.id,ch.room_id,r.name AS room_name,ch.rows_count,ch.cols_count,ch.share_with_families,ch.updated_at
        FROM course_seating_charts ch LEFT JOIN classroom_rooms r ON r.id=ch.room_id AND r.district_id=ch.district_id
       WHERE ch.district_id=$1 AND ch.course_id=$2`, [a.districtId, course.id]);
    if (!course.manage && !course.ok) throw new HttpError(404, "course_not_found");
    const assignments = chart
      ? await rows(c, `SELECT a.student_id,s.display_name,a.seat_row,a.seat_col,a.seat_label
          FROM course_seat_assignments a JOIN students s ON s.id=a.student_id AND s.district_id=a.district_id
         WHERE a.district_id=$1 AND a.chart_id=$2 ORDER BY a.seat_row,a.seat_col`, [a.districtId, chart.id])
      : [];
    const share = Boolean(chart?.share_with_families);
    if (course.manage) {
      const students = await rows(c, `SELECT student_id,display_name,grade_level FROM eduos_course_students($1)`, [course.id]);
      const rooms = await rows(c, `SELECT id,name,capacity FROM classroom_rooms WHERE district_id=$1 AND school_id=$2 AND archived_at IS NULL ORDER BY name`, [a.districtId, course.school_id]);
      return {
        courseId: course.id, courseTitle: course.title, canManage: true, shareWithFamilies: share,
        chart: chart ? { id: chart.id, roomId: chart.room_id, roomName: chart.room_name, rowsCount: chart.rows_count, colsCount: chart.cols_count, shareWithFamilies: share, updatedAt: chart.updated_at } : { id: null, roomId: null, roomName: null, rowsCount: 5, colsCount: 6, shareWithFamilies: false, updatedAt: null },
        rooms: rooms.map(r => ({ id: r.id, name: r.name, capacity: r.capacity })),
        students: students.map(s => ({ studentId: s.student_id, name: s.display_name, grade: s.grade_level })),
        assignments: assignments.map(x => ({ studentId: x.student_id, name: x.display_name, row: x.seat_row, col: x.seat_col, label: x.seat_label }))
      };
    }
    await audit(c, req, "view", "course_seating_chart", chart.id, `course=${course.id};shared=1;own=${assignments.length}`);
    return {
      courseId: course.id, courseTitle: course.title, canManage: false, shareWithFamilies: true,
      chart: { id: chart.id, roomId: chart.room_id, roomName: chart.room_name, rowsCount: chart.rows_count, colsCount: chart.cols_count, shareWithFamilies: true, updatedAt: chart.updated_at },
      rooms: [], students: [],
      assignments: assignments.map(x => ({ studentId: x.student_id, name: x.display_name, row: x.seat_row, col: x.seat_col, label: x.seat_label }))
    };
  }));

  app.put("/api/learning/courses/:id/seating", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor;
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_course_id" });
    const v = parseSeatingChart(req.body);
    if (!v) return res.status(400).json({ error: "invalid_seating_chart" });
    try {
      const data = await withTenantTransaction(a, async c => {
        const course = await one(c, `SELECT id,school_id,eduos_can_manage_course(id) AS ok FROM courses WHERE id=$1 AND district_id=$2`, [req.params.id, a.districtId]);
        if (!course || !course.ok) throw new HttpError(404, "course_not_found");
        if (v.roomId && !await one(c, `SELECT 1 FROM classroom_rooms WHERE id=$1 AND district_id=$2 AND school_id=$3 AND archived_at IS NULL`, [v.roomId, a.districtId, course.school_id])) {
          throw new HttpError(400, "room_not_in_school");
        }
        const enrolled = new Set((await rows(c, `SELECT student_id FROM course_enrollments WHERE district_id=$1 AND course_id=$2 AND status='active'`, [a.districtId, course.id])).map(r => r.student_id));
        for (const x of v.assignments) if (!enrolled.has(x.studentId)) throw new HttpError(409, "student_not_enrolled");
        const ch = await one(c, `INSERT INTO course_seating_charts(district_id,school_id,course_id,room_id,rows_count,cols_count,share_with_families,updated_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT(district_id,course_id) DO UPDATE SET room_id=EXCLUDED.room_id,rows_count=EXCLUDED.rows_count,cols_count=EXCLUDED.cols_count,share_with_families=EXCLUDED.share_with_families,updated_by=EXCLUDED.updated_by,updated_at=now()
            RETURNING id,room_id,rows_count,cols_count,share_with_families,updated_at`,
          [a.districtId, course.school_id, course.id, v.roomId, v.rowsCount, v.colsCount, v.shareWithFamilies, a.userId]);
        await c.query(`DELETE FROM course_seat_assignments WHERE district_id=$1 AND chart_id=$2`, [a.districtId, ch.id]);
        for (const x of v.assignments) {
          await c.query(`INSERT INTO course_seat_assignments(district_id,school_id,course_id,chart_id,student_id,seat_row,seat_col,seat_label,assigned_by)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [a.districtId, course.school_id, course.id, ch.id, x.studentId, x.row, x.col, x.label, a.userId]);
        }
        await audit(c, req, "update", "course_seating_chart", ch.id, `course=${course.id};rows=${v.rowsCount};cols=${v.colsCount};seated=${v.assignments.length};share=${ch.share_with_families}`);
        return { chartId: ch.id, courseId: course.id, roomId: ch.room_id, rowsCount: ch.rows_count, colsCount: ch.cols_count, shareWithFamilies: ch.share_with_families, seated: v.assignments.length, updatedAt: ch.updated_at };
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });
}
