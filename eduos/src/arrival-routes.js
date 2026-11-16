// 33.8.0 authoritative arrival lifecycle. The UI demo remains explicitly non-authoritative;
// these endpoints persist handoffs and first attendance in tenant-scoped PostgreSQL.
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { arrivalInitiationDenial, arrivalReceiptDenial, firstAttendanceDenial, isFirstAttendanceOverride } from "./arrival-workflow.js";
import { reconcileTransportArrival } from "./arrival-reconciliation.js";
import { lockStudentDay } from "./attendance-day.js";

const staff = (req,res,next) => ["principal","teacher"].includes(req.actor?.role) ? next() : res.status(403).json({error:"school_staff_only"});

export function registerArrivalRoutes(app) {
  // Route-by-route AM reconciliation: assigned riders -> latest route check-in -> school handoff -> first attendance.
  app.get("/api/arrival/reconciliation",requireSession,async(req,res,next)=>{
    if(!["principal","superintendent","driver"].includes(req.actor?.role)) return res.status(403).json({error:"transport_reconciliation_forbidden"});
    try{
      const data=await withTenantTransaction(req.actor,async client=>{
        const a=req.actor;
        const schoolScope=a.role==="principal"?"AND r.school_id=$2":"";
        const driverScope=a.role==="driver"?"AND r.driver_user_id=$2":"";
        const records=await rows(client,`SELECT r.id AS route_id,r.name AS route_name,r.bus_label,sc.name AS school_name,sc.id AS school_id,
            run.id AS run_id,ra.student_id,s.display_name,s.grade_level,
            ci.event AS checkin_event,ci.recorded_at AS checkin_at,
            h.id AS handoff_id,h.status AS handoff_status,h.initiated_at AS handoff_at,
            (SELECT count(*)::int FROM arrival_handoffs hx WHERE hx.district_id=r.district_id
              AND hx.student_id=ra.student_id AND hx.transport_run_id=run.id) AS handoff_count,
            EXISTS(SELECT 1 FROM attendance_events ae WHERE ae.district_id=r.district_id
              AND ae.student_id=ra.student_id AND ae.event_date=eduos_school_today(r.school_id)) AS attendance_recorded
          FROM transport_routes r
          JOIN transport_runs run ON run.route_id=r.id AND run.district_id=r.district_id
            AND run.service_date=eduos_school_today(r.school_id)
          JOIN transport_rider_assignments ra ON ra.route_id=r.id AND ra.district_id=r.district_id AND ra.revoked_at IS NULL
          JOIN students s ON s.id=ra.student_id AND s.district_id=ra.district_id
          JOIN schools sc ON sc.id=r.school_id AND sc.district_id=r.district_id
          LEFT JOIN LATERAL (SELECT tc.event,tc.recorded_at FROM transport_checkins tc
            WHERE tc.run_id=run.id AND tc.student_id=ra.student_id AND tc.district_id=r.district_id
            ORDER BY tc.recorded_at DESC,tc.id DESC LIMIT 1) ci ON true
          LEFT JOIN LATERAL (SELECT ah.id,ah.status,ah.initiated_at FROM arrival_handoffs ah
            WHERE ah.district_id=r.district_id AND ah.transport_run_id=run.id AND ah.student_id=ra.student_id
            ORDER BY ah.initiated_at DESC,ah.id DESC LIMIT 1) h ON true
          WHERE r.district_id=$1 AND r.direction='am' AND r.status='active' ${schoolScope} ${driverScope}
          ORDER BY r.name,s.display_name LIMIT 3000`,a.role==="principal"?[a.districtId,a.schoolId]:a.role==="driver"?[a.districtId,a.userId]:[a.districtId]);
        const result=records.map(x=>({...x,reconciliation_status:reconcileTransportArrival({
          checkinEvent:x.checkin_event,handoffCount:Number(x.handoff_count),handoffStatus:x.handoff_status,
          attendanceRecorded:x.attendance_recorded
        })}));
        await audit(client,req,"read","arrival_reconciliation",null,`riders=${result.length}`);
        return result;
      });
      res.setHeader("Cache-Control","no-store");res.json({data});
    }catch(e){sendError(res,next,e)}
  });
  // School staff see their assigned arrivals; drivers see only arrivals they initiated.
  app.get("/api/arrival/today", requireSession, requirePermission("transport","read"), async(req,res,next)=>{
    try {
      const data=await withTenantTransaction(req.actor,async client=>{
        const a=req.actor;
        const scope=a.role==="superintendent" ? "true"
          : a.role==="principal" ? "h.school_id=$2"
          : a.role==="teacher" ? "h.school_id=$2 AND (h.assigned_teacher_user_id=$3 OR EXISTS(SELECT 1 FROM teacher_student_rosters tr WHERE tr.student_id=h.student_id AND tr.teacher_user_id=$3))"
          : a.role==="driver" ? "h.initiated_by=$3"
          : "false";
        const args=[a.districtId,a.schoolId,a.userId];
        const result=await rows(client,`SELECT h.id,h.school_id,h.student_id,s.display_name,s.grade_level,h.method,h.status,
            h.assigned_teacher_user_id,h.initiated_by,h.received_by,h.initiated_at,h.received_at,h.note
          FROM arrival_handoffs h
          JOIN students s ON s.id=h.student_id AND s.district_id=h.district_id
          JOIN schools sc ON sc.id=h.school_id AND sc.district_id=h.district_id
          WHERE h.district_id=$1 AND ${scope}
            AND h.initiated_at >= (eduos_school_today(h.school_id)::timestamp AT TIME ZONE sc.timezone)
            AND h.initiated_at < ((eduos_school_today(h.school_id)+1)::timestamp AT TIME ZONE sc.timezone)
          ORDER BY h.initiated_at DESC LIMIT 500`,args);
        await audit(client,req,"read","arrival_handoffs",null,`count=${result.length}`);
        return result;
      });
      res.setHeader("Cache-Control","no-store"); res.json({data});
    }catch(e){sendError(res,next,e)}
  });

  // Principal creates car-rider/walk-in arrivals; assigned bus driver creates bus arrivals.
  app.post("/api/arrival/handoffs",requireSession,requireCsrf,async(req,res,next)=>{
    const {studentId,method,routeRunId=null,assignedTeacherUserId=null,note=null}=req.body||{};
    if(!validId(studentId)||!["bus","car_rider","walk_in"].includes(method)||
       (routeRunId!==null&&!validId(routeRunId))||(assignedTeacherUserId!==null&&!validId(assignedTeacherUserId))||
       (note!==null&&!cleanText(note,500))) return res.status(400).json({error:"invalid_arrival"});
    const initiationDenial=arrivalInitiationDenial({role:req.actor.role,method,routeRunId});
    if(initiationDenial) return res.status(initiationDenial.startsWith("transport_run")||initiationDenial.startsWith("unexpected")?400:403).json({error:initiationDenial});
    try{
      const handoff=await withTenantTransaction(req.actor,async client=>{
        const a=req.actor;
        const student=await one(client,`SELECT id,school_id FROM students WHERE id=$1 AND district_id=$2`,[studentId,a.districtId]);
        if(!student) throw new HttpError(404,"student_not_found");
        if(a.schoolId&&student.school_id!==a.schoolId) throw new HttpError(403,"school_scope_denied");
        if(assignedTeacherUserId){
          const teacher=await one(client,`SELECT 1 FROM memberships WHERE district_id=$1 AND user_id=$2 AND role='teacher' AND school_id=$3 AND status='active'`,[a.districtId,assignedTeacherUserId,student.school_id]);
          if(!teacher) throw new HttpError(400,"invalid_assigned_teacher");
        }
        if(method==="bus"){
          const run=await one(client,`SELECT x.id FROM transport_runs x JOIN transport_routes r ON r.id=x.route_id
            WHERE x.id=$1 AND x.district_id=$2 AND x.school_id=$3 AND x.driver_user_id=$4`,[routeRunId,a.districtId,student.school_id,a.userId]);
          if(!run) throw new HttpError(403,"transport_run_not_assigned");
          const rider=await one(client,`SELECT 1 FROM transport_rider_assignments WHERE route_id=(SELECT route_id FROM transport_runs WHERE id=$1) AND student_id=$2 AND revoked_at IS NULL`,[routeRunId,studentId]);
          if(!rider) throw new HttpError(403,"student_not_assigned_to_route");
        }
        const inserted=await one(client,`INSERT INTO arrival_handoffs(district_id,school_id,student_id,method,transport_run_id,assigned_teacher_user_id,initiated_by,note)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [a.districtId,student.school_id,studentId,method,routeRunId,assignedTeacherUserId,a.userId,note]);
        await client.query(`INSERT INTO arrival_handoff_events(district_id,handoff_id,actor_user_id,event,detail) VALUES($1,$2,$3,'initiated',$4::jsonb)`,
          [a.districtId,inserted.id,a.userId,JSON.stringify({method})]);
        await audit(client,req,"create","arrival_handoff",inserted.id,`method=${method}`);
        return inserted;
      });
      res.status(201).json({data:handoff});
    }catch(e){sendError(res,next,e)}
  });

  // Independent receiving staff member must confirm the physical handoff.
  app.post("/api/arrival/handoffs/:handoffId/receive",requireSession,requireCsrf,requirePermission("attendance","create"),staff,async(req,res,next)=>{
    if(!validId(req.params.handoffId)) return res.status(400).json({error:"invalid_handoff_id"});
    try{
      const result=await withTenantTransaction(req.actor,async client=>{
        const a=req.actor;
        const h=await one(client,`SELECT * FROM arrival_handoffs WHERE id=$1 AND district_id=$2 FOR UPDATE`,[req.params.handoffId,a.districtId]);
        if(!h) throw new HttpError(404,"handoff_not_found");
        let isRostered=false;
        if(a.role==="teacher"&&h.assigned_teacher_user_id!==a.userId){
          isRostered=!!(await one(client,`SELECT 1 FROM teacher_student_rosters WHERE student_id=$1 AND teacher_user_id=$2`,[h.student_id,a.userId]));
        }
        const denial=arrivalReceiptDenial({role:a.role,actorUserId:a.userId,initiatorUserId:h.initiated_by,actorSchoolId:a.schoolId,handoffSchoolId:h.school_id,status:h.status,assignedTeacherUserId:h.assigned_teacher_user_id,isRostered});
        if(denial) throw new HttpError(denial==="independent_receipt_required"||denial==="handoff_not_pending"?409:403,denial);
        if(h.status==="received") return h;
        const updated=await one(client,`UPDATE arrival_handoffs SET status='received',received_by=$2,received_at=now()
          WHERE id=$1 AND status='pending' RETURNING *`,[h.id,a.userId]);
        await client.query(`INSERT INTO arrival_handoff_events(district_id,handoff_id,actor_user_id,event) VALUES($1,$2,$3,'received')`,[a.districtId,h.id,a.userId]);
        await audit(client,req,"update","arrival_handoff",h.id,"independent staff receipt");
        return updated;
      });
      res.json({data:result});
    }catch(e){sendError(res,next,e)}
  });

  // First attendance is recorded only after the independent arrival receipt,
  // by the staff member who received the student. A principal can record it
  // for someone else only as an override with a reason (overrideReason).
  app.post("/api/arrival/handoffs/:handoffId/first-attendance",requireSession,requireCsrf,requirePermission("attendance","create"),async(req,res,next)=>{
    const status=req.body?.status||"present";
    const overrideReason=typeof req.body?.overrideReason==="string"?req.body.overrideReason.trim():null;
    if(!validId(req.params.handoffId)||!["present","tardy"].includes(status)) return res.status(400).json({error:"invalid_first_attendance"});
    try{
      const result=await withTenantTransaction(req.actor,async client=>{
        const a=req.actor;
        const h=await one(client,`SELECT * FROM arrival_handoffs WHERE id=$1 AND district_id=$2`,[req.params.handoffId,a.districtId]);
        if(!h) throw new HttpError(404,"handoff_not_found");
        let isRostered=false;
        if(a.role==="teacher"&&h.assigned_teacher_user_id!==a.userId){
          isRostered=!!(await one(client,`SELECT 1 FROM teacher_student_rosters WHERE student_id=$1 AND teacher_user_id=$2`,[h.student_id,a.userId]));
        }
        const denial=firstAttendanceDenial({role:a.role,actorUserId:a.userId,actorSchoolId:a.schoolId,handoffSchoolId:h.school_id,status:h.status,assignedTeacherUserId:h.assigned_teacher_user_id,isRostered,receivedByUserId:h.received_by,overrideReason});
        if(denial) throw new HttpError(denial==="attendance_requires_received_handoff"?409:denial==="override_reason_required"?400:403,denial);
        const override=isFirstAttendanceOverride({actorUserId:a.userId,receivedByUserId:h.received_by});
        const day=await one(client,`SELECT eduos_school_today($1)::text AS day`,[h.school_id]);
        await lockStudentDay(client,h.student_id,day.day);
        const existing=await one(client,`SELECT id,status FROM attendance_events WHERE district_id=$1 AND student_id=$2 AND event_date=$3::date ORDER BY id LIMIT 1`,[a.districtId,h.student_id,day.day]);
        if(existing) return {attendance:existing,created:false};
        const attendance=await one(client,`INSERT INTO attendance_events(district_id,student_id,event_date,status) VALUES($1,$2,$3,$4) RETURNING id,status,event_date`,
          [a.districtId,h.student_id,day.day,status]);
        await client.query(`INSERT INTO arrival_handoff_events(district_id,handoff_id,actor_user_id,event,detail) VALUES($1,$2,$3,'attendance_recorded',$4::jsonb)`,
          [a.districtId,h.id,a.userId,JSON.stringify(override?{attendanceId:attendance.id,status,override:true,receivedBy:h.received_by,reason:overrideReason}:{attendanceId:attendance.id,status})]);
        await audit(client,req,override?"override":"create","attendance_event",attendance.id,
          override?`arrival_handoff=${h.id}; principal override for receiver ${h.received_by}; reason: ${overrideReason}`:`arrival_handoff=${h.id}`);
        return {attendance,created:true};
      });
      res.status(result.created?201:200).json({data:result});
    }catch(e){sendError(res,next,e)}
  });
}
