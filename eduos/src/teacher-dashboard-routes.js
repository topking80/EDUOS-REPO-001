// Unified Teacher Dashboard command-center API: aggregates existing
// school-day, classroom, teaching/grading, transport, duty, connection, and
// alert data in a single RLS-scoped transaction without duplicating writes.
import { requireSession } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { canPerform } from "./policy.js";
import { queueFrom } from "./pickup-routes.js";
import { groupTransportEvents } from "./transport-rider-events.js";
import { HttpError, one, roleIn, rows, sendError } from "./role-app-util.js";

const hhmm = t => String(t).slice(0, 5);
const DUTY_DOMAINS = [
  { domain: "library", label: "Library / media center" },
  { domain: "meal_service", label: "Lunchroom" },
  { domain: "transport", label: "Transport" },
  { domain: "general", label: "General staff" }
];

export function registerTeacherDashboardRoutes(app) {
  app.get("/api/teacher/dashboard", requireSession, roleIn("teacher"), async (req, res, next) => {
    const a = req.actor;
    if (!a.schoolId) return res.status(403).json({ error: "school_scope_required" });
    try {
      const data = await withTenantTransaction(a, async client => {
        const school = await one(client,
          `SELECT id,name,timezone,eduos_school_today(id)::text AS today,
                  extract(isodow FROM now() AT TIME ZONE timezone)::int AS isodow
             FROM schools WHERE id=$1 AND district_id=$2`,
          [a.schoolId, a.districtId]);
        if (!school) throw new HttpError(404, "school_not_found");
        const today = school.today;
        const isodow = Number(school.isodow);

        const summary = await one(client, `SELECT
              (SELECT count(*)::int FROM students s WHERE s.school_id=$1
                 AND EXISTS(SELECT 1 FROM teacher_student_rosters tr WHERE tr.student_id=s.id AND tr.teacher_user_id=$2)) AS students,
              (SELECT count(DISTINCT e.student_id)::int FROM attendance_events e JOIN students s ON s.id=e.student_id
                 WHERE s.school_id=$1 AND e.event_date=$3::date
                   AND EXISTS(SELECT 1 FROM teacher_student_rosters tr WHERE tr.student_id=s.id AND tr.teacher_user_id=$2)) AS attendance_marked_today,
              (SELECT count(*)::int FROM attendance_events e JOIN students s ON s.id=e.student_id
                 WHERE s.school_id=$1 AND e.status='absent' AND e.event_date>=$3::date - 6
                   AND EXISTS(SELECT 1 FROM teacher_student_rosters tr WHERE tr.student_id=s.id AND tr.teacher_user_id=$2)) AS absences_7d,
              (SELECT count(*)::int FROM student_intervention_cases c
                 WHERE c.school_id=$1 AND c.status<>'closed' AND (c.owner_user_id=$2 OR c.created_by=$2)) AS my_open_cases,
              (SELECT count(*)::int FROM assignments WHERE school_id=$1 AND created_by=$2 AND status='published') AS open_assignments,
              (SELECT count(*)::int FROM assignments WHERE school_id=$1 AND created_by=$2 AND status='draft') AS draft_assignments,
              (SELECT count(*)::int FROM assignment_submissions sub JOIN assignments x ON x.id=sub.assignment_id
                 WHERE x.school_id=$1 AND x.created_by=$2 AND sub.graded_at IS NULL) AS to_grade,
              (SELECT count(*)::int FROM quiz_attempts q JOIN assignments x ON x.id=q.assignment_id
                 WHERE x.school_id=$1 AND x.created_by=$2 AND q.status='needs_review') AS quizzes_to_review,
              (SELECT count(*)::int FROM christie_sessions cs
                 WHERE cs.school_id=$1 AND cs.needs_adult AND cs.reviewed_at IS NULL
                   AND EXISTS(SELECT 1 FROM teacher_student_rosters tr WHERE tr.student_id=cs.student_id AND tr.teacher_user_id=$2)) AS tutoring_flagged,
              (SELECT count(*)::int FROM student_history_entries e
                 WHERE e.author_user_id=$2 AND e.classification='teacher_artifact' AND e.status='draft') AS history_drafts`,
            [a.schoolId, a.userId, today]);
        const courses = await rows(client, `SELECT c.id,c.title,c.subject,c.grade_level,c.term,
              (SELECT count(*)::int FROM course_enrollments e WHERE e.course_id=c.id AND e.status='active') AS students,
              (SELECT count(*)::int FROM quiz_attempts q JOIN assignments x ON x.id=q.assignment_id WHERE x.course_id=c.id AND q.status='needs_review') AS to_review,
              (SELECT count(*)::int FROM assignment_submissions s JOIN assignments x ON x.id=s.assignment_id WHERE x.course_id=c.id AND s.graded_at IS NULL) AS to_grade,
              p.id AS plan_id,p.status AS plan_status,p.title AS plan_title,coalesce(jsonb_array_length(p.blocks),0)::int AS plan_blocks
            FROM courses c
            LEFT JOIN class_day_plans p ON p.course_id=c.id AND p.plan_date=$2::date
            WHERE eduos_can_manage_course(c.id) AND c.status='active' AND c.teacher_user_id=$1
            ORDER BY c.title`, [a.userId, today]);
        const slots = await rows(client, `SELECT t.id,t.room_id,r.name AS room,r.kind AS room_kind,t.weekdays,t.starts,t.ends,t.label,t.course_id,co.title AS course,
              (extract(isodow FROM now() AT TIME ZONE s.timezone)::smallint = ANY(t.weekdays)
                AND now() AT TIME ZONE s.timezone >= (now() AT TIME ZONE s.timezone)::date + t.starts - interval '10 minutes'
                AND now() AT TIME ZONE s.timezone < (now() AT TIME ZONE s.timezone)::date + t.ends) AS now
            FROM classroom_room_teachers t
            JOIN classroom_rooms r ON r.id=t.room_id
            JOIN schools s ON s.id=t.school_id
            LEFT JOIN courses co ON co.id=t.course_id
            WHERE t.teacher_user_id=$1 AND t.ended_at IS NULL AND r.archived_at IS NULL
            ORDER BY t.starts,r.name`, [a.userId]);
        const pairings = await rows(client, `SELECT p.id,p.room_id,p.controller_name,p.paired_at,p.expires_at,d.name AS via
            FROM classroom_pairings p
            JOIN classroom_devices d ON d.id=p.via_device_id
            WHERE p.teacher_user_id=$1 AND p.ended_at IS NULL AND p.expires_at>now()`, [a.userId]);
        const checkinsTodayRow = await one(client, `SELECT count(*)::int AS n FROM room_checkins WHERE district_id=$1 AND user_id=$2 AND local_date=$3::date`,
            [a.districtId, a.userId, today]);
        const busRiderRows = canPerform(a, "transport", "read")
            ? await rows(client, `SELECT s.id,s.display_name,s.grade_level,ra.route_id,r.name AS route_name,r.bus_label,r.direction,
                  st.name AS stop_name,x.id AS run_id,x.status AS run_status
                FROM students s
                JOIN transport_rider_assignments ra ON ra.student_id=s.id AND ra.revoked_at IS NULL
                JOIN transport_routes r ON r.id=ra.route_id AND r.status='active'
                JOIN transport_stops st ON st.id=ra.stop_id
                LEFT JOIN transport_runs x ON x.route_id=r.id AND x.service_date=$3::date
                WHERE s.school_id=$2::uuid AND EXISTS(SELECT 1 FROM teacher_student_rosters tr WHERE tr.student_id=s.id AND tr.teacher_user_id=$1)
                ORDER BY s.display_name,r.direction`, [a.userId, a.schoolId, today])
            : [];
        const arrivals = canPerform(a, "transport", "read")
            ? await rows(client, `SELECT h.id,h.student_id,s.display_name,s.grade_level,h.method,h.status,h.initiated_at
                FROM arrival_handoffs h
                JOIN students s ON s.id=h.student_id AND s.district_id=h.district_id
                JOIN schools sc ON sc.id=h.school_id AND sc.district_id=h.district_id
                WHERE h.district_id=$1 AND h.school_id=$2
                  AND (h.assigned_teacher_user_id=$3 OR EXISTS(SELECT 1 FROM teacher_student_rosters tr WHERE tr.student_id=h.student_id AND tr.teacher_user_id=$3))
                  AND h.initiated_at >= ($4::date::timestamp AT TIME ZONE sc.timezone)
                  AND h.initiated_at < (($4::date + 1)::timestamp AT TIME ZONE sc.timezone)
                ORDER BY h.initiated_at DESC LIMIT 200`, [a.districtId, a.schoolId, a.userId, today])
            : [];
        const pickupEvents = canPerform(a, "pickup", "verify")
            ? await rows(client, `SELECT * FROM eduos_pickup_today()`)
            : [];
        const tasks = await rows(client, `SELECT id,domain,kind,status,priority,summary,due_at,assigned_to
            FROM school_service_work
            WHERE district_id=$1 AND school_id=$2 AND status IN ('open','in_progress') AND (assigned_to=$3 OR assigned_to IS NULL)
            ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, due_at NULLS LAST LIMIT 150`,
            [a.districtId, a.schoolId, a.userId]);
        const checklists = await rows(client, `SELECT c.id,c.title,c.domain,c.cadence,i.id AS item_id,i.label,r.completed_at
            FROM school_staff_checklists c
            JOIN school_staff_checklist_items i ON i.checklist_id=c.id
            LEFT JOIN school_staff_checklist_runs r ON r.item_id=i.id AND r.run_date=$3::date
            WHERE c.district_id=$1 AND c.school_id=$2 AND c.active=true
            ORDER BY c.title,i.position`, [a.districtId, a.schoolId, today]);
        const handoffs = await rows(client, `SELECT id,domain,summary,next_action,from_user_id,to_user_id,acknowledged_at,created_at
            FROM school_staff_handoffs
            WHERE district_id=$1 AND school_id=$2 AND (to_user_id IS NULL OR to_user_id=$3)
            ORDER BY created_at DESC LIMIT 30`, [a.districtId, a.schoolId, a.userId]);
        const staffAnnouncements = await rows(client, `SELECT id,title,body,audience,created_at,expires_at
            FROM school_staff_announcements
            WHERE district_id=$1 AND school_id=$2 AND (expires_at IS NULL OR expires_at>now()) AND audience='all_staff'
            ORDER BY created_at DESC LIMIT 5`, [a.districtId, a.schoolId]);
        const shifts = await rows(client, `SELECT id,shift_date::text AS shift_date,starts_at,ends_at,department,assignment,status
            FROM staff_shift_assignments
            WHERE district_id=$1 AND school_id=$2 AND staff_user_id=$3 AND shift_date>=$4::date AND shift_date<=$4::date + 7
            ORDER BY shift_date,starts_at LIMIT 30`, [a.districtId, a.schoolId, a.userId, today]);
        const upcomingEvents = await rows(client, `SELECT id,title,starts_at,ends_at,venue,status
            FROM school_events
            WHERE district_id=$1 AND school_id=$2 AND status='published' AND ends_at>=now() AND starts_at<=now() + interval '14 days'
            ORDER BY starts_at LIMIT 5`, [a.districtId, a.schoolId]);
        const unreadMessagesRow = await one(client, `SELECT count(*)::int AS n
            FROM comms_messages m
            JOIN comms_participants me ON me.thread_id=m.thread_id AND me.user_id=$1 AND me.left_at IS NULL
            WHERE m.author_user_id<>$1
              AND NOT EXISTS(SELECT 1 FROM comms_message_reads r WHERE r.message_id=m.id AND r.user_id=$1)`, [a.userId]);
        const recentAnnouncements = await rows(client, `SELECT a.id,a.title,a.body,a.scope,a.created_at,u.display_name AS author_name
            FROM comms_announcements a JOIN users u ON u.id=a.author_user_id
            WHERE a.district_id=$1 AND a.school_id=$2 AND a.status='published'
              AND (a.scope='school' OR a.author_user_id=$3)
            ORDER BY a.created_at DESC LIMIT 3`, [a.districtId, a.schoolId, a.userId]);
        const safetyIncidents = canPerform(a, "safety", "read")
          ? await rows(client, `SELECT i.id,i.kind,i.hazard,i.status,i.is_drill,i.instructions,i.initiated_at
                FROM safety_incidents i
                WHERE i.school_id=$1 AND (i.status IN ('active','reunification') OR (i.status='pending' AND i.initiated_by=$2 AND i.confirm_by>now()))
                ORDER BY i.initiated_at DESC`, [a.schoolId, a.userId])
          : [];
        const notificationRows = await rows(client, `SELECT id,kind,title,body,created_at,read_at
            FROM notification_outbox
            WHERE recipient_user_id=$1 AND channel='in_app'
            ORDER BY created_at DESC LIMIT 5`, [a.userId]);
        const unreadNotificationsRow = await one(client, `SELECT count(*)::int AS n
            FROM notification_outbox
            WHERE recipient_user_id=$1 AND channel='in_app' AND read_at IS NULL`, [a.userId]);

        // Hydrate classroom rooms and today's schedule.
        const roomIds = [...new Set(slots.map(s => s.room_id))];
        const devices = roomIds.length
          ? await rows(client, `SELECT id,room_id,kind,name,capabilities FROM classroom_devices WHERE room_id = ANY($1) AND status='approved' ORDER BY name`, [roomIds])
          : [];
        const rooms = roomIds.map(id => {
          const mine = slots.filter(s => s.room_id === id);
          const pairing = pairings.find(p => p.room_id === id) || null;
          return {
            id,
            name: mine[0].room,
            kind: mine[0].room_kind,
            now: mine.some(s => s.now),
            deviceCount: devices.filter(d => d.room_id === id).length,
            paired: Boolean(pairing),
            controller: pairing?.controller_name || null
          };
        });
        const scheduleToday = slots
          .filter(s => Array.isArray(s.weekdays) && s.weekdays.map(Number).includes(isodow))
          .map(s => ({
            slotId: s.id,
            roomId: s.room_id,
            room: s.room,
            starts: hhmm(s.starts),
            ends: hhmm(s.ends),
            label: s.label || s.course || "Class",
            courseId: s.course_id,
            course: s.course,
            now: Boolean(s.now)
          }));

        // Hydrate bus rider latest check-in event.
        const activeRiders = busRiderRows.filter(k => k.run_id);
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
        const riders = busRiderRows.map(k => {
          const events = k.run_id ? (eventsByRider.get(`${k.run_id}:${k.id}`) || []) : [];
          return {
            studentId: k.id,
            displayName: k.display_name,
            busLabel: k.bus_label,
            routeName: k.route_name,
            direction: k.direction,
            stopName: k.stop_name,
            status: events.length ? events[events.length - 1].event : (k.run_id ? "expected" : "not_started")
          };
        });

        const pickupQueue = queueFrom(pickupEvents);
        const pendingArrivals = arrivals.filter(x => x.status === "pending");
        const unacknowledgedHandoffs = handoffs.filter(h => !h.acknowledged_at && h.from_user_id !== a.userId);
        const incompleteChecklists = checklists.filter(c => c.completed_at == null);
        const unplannedCourses = courses.filter(c => c.plan_status !== "ready");

        const duties = DUTY_DOMAINS.map(({ domain, label }) => {
          const domainShifts = shifts.filter(s => s.department === domain && s.shift_date === today);
          const domainChecklists = checklists.filter(c => c.domain === domain);
          const domainCompleted = domainChecklists.filter(c => c.completed_at != null).length;
          const domainTasks = tasks.filter(t => t.domain === domain);
          return {
            domain,
            label,
            shiftsToday: domainShifts.length,
            checklistsTotal: domainChecklists.length,
            checklistsCompleted: domainCompleted,
            openTasks: domainTasks.length
          };
        });

        const workItems = [];
        if (summary.to_grade > 0) {
          workItems.push({ kind: "grading", title: "Grade submitted work", detail: `${summary.to_grade} submission(s) waiting`, count: summary.to_grade, target: "grading", priority: "high" });
        }
        if (summary.quizzes_to_review > 0) {
          workItems.push({ kind: "quiz_review", title: "Review quiz open answers", detail: `${summary.quizzes_to_review} attempt(s) waiting`, count: summary.quizzes_to_review, target: "grading", priority: "high" });
        }
        if (summary.tutoring_flagged > 0) {
          workItems.push({ kind: "tutoring", title: "Christie sessions asking for an adult", detail: `${summary.tutoring_flagged} learner session(s) flagged`, count: summary.tutoring_flagged, target: "copilot", priority: "high" });
        }
        if (pendingArrivals.length > 0) {
          workItems.push({ kind: "arrival", title: "Confirm student arrival handoffs", detail: `${pendingArrivals.length} handoff(s) pending`, count: pendingArrivals.length, target: "schoolday", priority: "urgent" });
        }
        if (incompleteChecklists.length > 0) {
          workItems.push({ kind: "checklist", title: "Complete daily duty checklists", detail: `${incompleteChecklists.length} item(s) remaining today`, count: incompleteChecklists.length, target: "schoolday", priority: "normal" });
        }
        if (tasks.length > 0) {
          workItems.push({ kind: "tasks", title: "Open school operations tasks", detail: `${tasks.length} open task(s)`, count: tasks.length, target: "schoolday", priority: tasks.some(t => t.priority === "urgent") ? "urgent" : "normal" });
        }
        if (unacknowledgedHandoffs.length > 0) {
          workItems.push({ kind: "handoffs", title: "Acknowledge staff handoffs", detail: `${unacknowledgedHandoffs.length} handoff(s) waiting`, count: unacknowledgedHandoffs.length, target: "schoolday", priority: "normal" });
        }
        if (unplannedCourses.length > 0) {
          workItems.push({ kind: "class_plans", title: "Prepare today's lesson plans", detail: `${unplannedCourses.length} course(s) not marked ready`, count: unplannedCourses.length, target: "classes", priority: "normal" });
        }
        if (summary.history_drafts > 0) {
          workItems.push({ kind: "history", title: "Finish draft Time Capsule items", detail: `${summary.history_drafts} draft(s) saved`, count: summary.history_drafts, target: "contributions", priority: "low" });
        }

        const nowMs = Date.now();
        const urgentTasks = tasks.filter(t => t.priority === "urgent" || (t.due_at && Date.parse(t.due_at) < nowMs));

        return {
          school: { id: school.id, name: school.name, timezone: school.timezone },
          date: today,
          overview: {
            students: summary.students,
            attendanceMarkedToday: summary.attendance_marked_today,
            absences7d: summary.absences_7d,
            myOpenCases: summary.my_open_cases,
            coursesCount: courses.length,
            courses: courses.map(c => ({
              id: c.id,
              title: c.title,
              subject: c.subject,
              gradeLevel: c.grade_level,
              students: c.students,
              toReview: c.to_review,
              toGrade: c.to_grade,
              planId: c.plan_id,
              planStatus: c.plan_status,
              planTitle: c.plan_title,
              planBlocks: c.plan_blocks
            })),
            scheduleToday,
            upcomingShifts: shifts.slice(0, 5),
            upcomingEvents
          },
          classroom: {
            assignedRooms: rooms.length,
            connectedRooms: rooms.filter(r => r.paired).length,
            checkinsToday: checkinsTodayRow.n,
            rooms
          },
          transportation: {
            busRidersCount: riders.length,
            busRiders: riders.slice(0, 12),
            arrivalsTotal: arrivals.length,
            arrivalsPending: pendingArrivals.length,
            busArrivalsPending: pendingArrivals.filter(x => x.method === "bus").length,
            carArrivalsPending: pendingArrivals.filter(x => x.method === "car_rider").length,
            pickupWaitingCount: pickupQueue.waiting.length,
            pendingArrivals: pendingArrivals.slice(0, 8).map(x => ({
              id: x.id,
              studentId: x.student_id,
              displayName: x.display_name,
              gradeLevel: x.grade_level,
              method: x.method,
              status: x.status,
              initiatedAt: x.initiated_at
            }))
          },
          duties,
          workQueue: {
            toGrade: summary.to_grade,
            quizzesToReview: summary.quizzes_to_review,
            openAssignments: summary.open_assignments,
            draftAssignments: summary.draft_assignments,
            tutoringFlagged: summary.tutoring_flagged,
            historyDrafts: summary.history_drafts,
            openTasks: tasks.length,
            incompleteChecklists: incompleteChecklists.length,
            pendingHandoffs: unacknowledgedHandoffs.length,
            unplannedCourses: unplannedCourses.length,
            checklistItems: incompleteChecklists.slice(0, 8).map(c => ({
              itemId: c.item_id,
              checklistId: c.id,
              title: c.title,
              label: c.label,
              domain: c.domain
            })),
            items: workItems
          },
          connections: {
            unreadMessages: unreadMessagesRow.n,
            pendingHandoffsCount: unacknowledgedHandoffs.length,
            recentHandoffs: handoffs.slice(0, 5),
            staffAnnouncements,
            recentAnnouncements
          },
          alerts: {
            unreadNotifications: unreadNotificationsRow.n,
            notifications: notificationRows,
            safetyIncidents,
            urgentTasksCount: urgentTasks.length,
            urgentTasks: urgentTasks.slice(0, 5),
            pendingArrivalsCount: pendingArrivals.length
          }
        };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });
}
