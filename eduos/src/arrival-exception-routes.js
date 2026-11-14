// 34.5 durable exception assignment, acknowledgement and resolution.
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { classifyArrivalExceptions } from "./arrival-exceptions.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";

const managers = (req,res,next) => ["principal","superintendent"].includes(req.actor?.role)
  ? next() : res.status(403).json({error:"exception_manager_only"});
const canSeeSchool = (actor, schoolId) => actor.role === "superintendent" || actor.schoolId === schoolId;

export function registerArrivalExceptionRoutes(app) {
  app.get("/api/arrival/exceptions", requireSession, managers, async (req,res,next) => {
    try {
      const result = await withTenantTransaction(req.actor, async client => {
        const a=req.actor;
        const scope=a.role==="superintendent" ? "true" : "h.school_id=$2";
        const args=a.role==="superintendent" ? [a.districtId] : [a.districtId,a.schoolId];
        const records=await rows(client,`SELECT h.id,h.school_id,h.student_id,h.status,h.initiated_at,
            EXISTS(SELECT 1 FROM attendance_events ae WHERE ae.district_id=h.district_id
              AND ae.student_id=h.student_id AND ae.event_date=eduos_school_today(h.school_id)) AS attendance_recorded
          FROM arrival_handoffs h WHERE h.district_id=$1 AND ${scope}
          AND h.initiated_at >= (eduos_school_today(h.school_id)::timestamp AT TIME ZONE
            (SELECT timezone FROM schools WHERE id=h.school_id AND district_id=h.district_id))
          AND h.initiated_at < ((eduos_school_today(h.school_id)+1)::timestamp AT TIME ZONE
            (SELECT timezone FROM schools WHERE id=h.school_id AND district_id=h.district_id))
          ORDER BY h.initiated_at DESC LIMIT 1000`,args);
        const detected=classifyArrivalExceptions(records.map(r=>({
          id:r.id,schoolId:r.school_id,studentId:r.student_id,status:r.status,
          initiatedAt:new Date(r.initiated_at).toISOString(),attendanceRecorded:r.attendance_recorded
        })));
        if(!detected.length) return [];
        const ids=detected.map(x=>x.handoffId);
        const resolutions=await rows(client,`SELECT id,handoff_id,exception_kind,status,assigned_to,
            opened_by,acknowledged_by,acknowledged_at,resolved_by,resolved_at,resolution_note,updated_at
          FROM arrival_exception_resolutions WHERE district_id=$1 AND handoff_id=ANY($2::uuid[])`,[a.districtId,ids]);
        const byKey=new Map(resolutions.map(r=>[`${r.handoff_id}:${r.exception_kind}`,r]));
        return detected.map(item=>({...item,resolution:byKey.get(`${item.handoffId}:${item.kind}`)||null}));
      });
      res.setHeader("Cache-Control","no-store");
      res.json({data:result});
    } catch(e) { sendError(res,next,e); }
  });

  app.post("/api/arrival/exceptions/:handoffId/:kind/acknowledge",requireSession,requireCsrf,managers,async(req,res,next)=>{
    if(!validId(req.params.handoffId)||!["handoff_awaiting_receipt","first_attendance_missing"].includes(req.params.kind))
      return res.status(400).json({error:"invalid_exception"});
    try {
      const result=await withTenantTransaction(req.actor,async client=>{
        const a=req.actor;
        const handoff=await one(client,`SELECT id,school_id FROM arrival_handoffs WHERE id=$1 AND district_id=$2`,[req.params.handoffId,a.districtId]);
        if(!handoff) throw new HttpError(404,"handoff_not_found");
        if(!canSeeSchool(a,handoff.school_id)) throw new HttpError(403,"school_scope_denied");
        const record=await one(client,`INSERT INTO arrival_exception_resolutions
          (district_id,school_id,handoff_id,exception_kind,status,opened_by,acknowledged_by,acknowledged_at)
          VALUES($1,$2,$3,$4,'acknowledged',$5,$5,now())
          ON CONFLICT(district_id,handoff_id,exception_kind) DO UPDATE SET
            status=CASE WHEN arrival_exception_resolutions.status='resolved' THEN 'resolved' ELSE 'acknowledged' END,
            acknowledged_by=CASE WHEN arrival_exception_resolutions.status='resolved' THEN arrival_exception_resolutions.acknowledged_by ELSE EXCLUDED.acknowledged_by END,
            acknowledged_at=CASE WHEN arrival_exception_resolutions.status='resolved' THEN arrival_exception_resolutions.acknowledged_at ELSE now() END,
            updated_at=now() RETURNING *`,
          [a.districtId,handoff.school_id,handoff.id,req.params.kind,a.userId]);
        await client.query(`INSERT INTO arrival_exception_resolution_events(district_id,resolution_id,actor_user_id,event)
          VALUES($1,$2,$3,'acknowledged')`,[a.districtId,record.id,a.userId]);
        await audit(client,req,"update","arrival_exception",record.id,"acknowledged");
        return record;
      });
      res.json({data:result});
    } catch(e) { sendError(res,next,e); }
  });

  app.post("/api/arrival/exceptions/:handoffId/:kind/assign",requireSession,requireCsrf,managers,async(req,res,next)=>{
    const assignee=req.body?.assignedTo;
    if(!validId(req.params.handoffId)||!["handoff_awaiting_receipt","first_attendance_missing"].includes(req.params.kind)||
       (assignee!==null&&!validId(assignee))) return res.status(400).json({error:"invalid_assignment"});
    try {
      const result=await withTenantTransaction(req.actor,async client=>{
        const a=req.actor;
        const handoff=await one(client,`SELECT id,school_id FROM arrival_handoffs WHERE id=$1 AND district_id=$2`,[req.params.handoffId,a.districtId]);
        if(!handoff) throw new HttpError(404,"handoff_not_found");
        if(!canSeeSchool(a,handoff.school_id)) throw new HttpError(403,"school_scope_denied");
        if(assignee){
          const eligible=await one(client,`SELECT 1 FROM memberships WHERE district_id=$1 AND user_id=$2
            AND school_id=$3 AND role IN ('principal','teacher') AND status='active'`,[a.districtId,assignee,handoff.school_id]);
          if(!eligible) throw new HttpError(400,"invalid_exception_assignee");
        }
        const record=await one(client,`INSERT INTO arrival_exception_resolutions
          (district_id,school_id,handoff_id,exception_kind,assigned_to,opened_by)
          VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(district_id,handoff_id,exception_kind) DO UPDATE SET assigned_to=EXCLUDED.assigned_to,updated_at=now()
          RETURNING *`,[a.districtId,handoff.school_id,handoff.id,req.params.kind,assignee,a.userId]);
        await client.query(`INSERT INTO arrival_exception_resolution_events(district_id,resolution_id,actor_user_id,event,detail)
          VALUES($1,$2,$3,'assigned',$4::jsonb)`,[a.districtId,record.id,a.userId,JSON.stringify({assignedTo:assignee})]);
        await audit(client,req,"update","arrival_exception",record.id,"assignment changed");
        return record;
      });
      res.json({data:result});
    } catch(e) { sendError(res,next,e); }
  });

  app.post("/api/arrival/exceptions/:handoffId/:kind/resolve",requireSession,requireCsrf,managers,async(req,res,next)=>{
    const note=cleanText(req.body?.note,1000);
    if(!validId(req.params.handoffId)||!["handoff_awaiting_receipt","first_attendance_missing"].includes(req.params.kind)||!note)
      return res.status(400).json({error:"resolution_note_required"});
    try {
      const result=await withTenantTransaction(req.actor,async client=>{
        const a=req.actor;
        const handoff=await one(client,`SELECT id,school_id,status FROM arrival_handoffs WHERE id=$1 AND district_id=$2`,[req.params.handoffId,a.districtId]);
        if(!handoff) throw new HttpError(404,"handoff_not_found");
        if(!canSeeSchool(a,handoff.school_id)) throw new HttpError(403,"school_scope_denied");
        if(req.params.kind==="handoff_awaiting_receipt"&&handoff.status!=="received")
          throw new HttpError(409,"handoff_still_pending");
        if(req.params.kind==="first_attendance_missing"){
          const attendance=await one(client,`SELECT 1 FROM attendance_events WHERE district_id=$1 AND student_id=(SELECT student_id FROM arrival_handoffs WHERE id=$2) AND event_date=eduos_school_today($3)`,[a.districtId,handoff.id,handoff.school_id]);
          if(!attendance) throw new HttpError(409,"first_attendance_still_missing");
        }
        const record=await one(client,`INSERT INTO arrival_exception_resolutions
          (district_id,school_id,handoff_id,exception_kind,status,opened_by,resolved_by,resolved_at,resolution_note)
          VALUES($1,$2,$3,$4,'resolved',$5,$5,now(),$6)
          ON CONFLICT(district_id,handoff_id,exception_kind) DO UPDATE SET status='resolved',
            resolved_by=EXCLUDED.resolved_by,resolved_at=now(),resolution_note=EXCLUDED.resolution_note,updated_at=now()
          RETURNING *`,[a.districtId,handoff.school_id,handoff.id,req.params.kind,a.userId,note]);
        await client.query(`INSERT INTO arrival_exception_resolution_events(district_id,resolution_id,actor_user_id,event,detail)
          VALUES($1,$2,$3,'resolved',$4::jsonb)`,[a.districtId,record.id,a.userId,JSON.stringify({note})]);
        await audit(client,req,"update","arrival_exception",record.id,"resolved");
        return record;
      });
      res.json({data:result});
    } catch(e) { sendError(res,next,e); }
  });

  app.get("/api/arrival/exceptions/:handoffId/history",requireSession,managers,async(req,res,next)=>{
    if(!validId(req.params.handoffId)) return res.status(400).json({error:"invalid_handoff_id"});
    try {
      const data=await withTenantTransaction(req.actor,async client=>{
        const a=req.actor;
        const handoff=await one(client,`SELECT school_id FROM arrival_handoffs WHERE id=$1 AND district_id=$2`,[req.params.handoffId,a.districtId]);
        if(!handoff) throw new HttpError(404,"handoff_not_found");
        if(!canSeeSchool(a,handoff.school_id)) throw new HttpError(403,"school_scope_denied");
        return rows(client,`SELECT e.id,e.event,e.detail,e.occurred_at,e.actor_user_id
          FROM arrival_exception_resolution_events e JOIN arrival_exception_resolutions r ON r.id=e.resolution_id
          WHERE e.district_id=$1 AND r.handoff_id=$2 ORDER BY e.occurred_at,e.id`,[a.districtId,req.params.handoffId]);
      });
      res.setHeader("Cache-Control","no-store"); res.json({data});
    } catch(e) { sendError(res,next,e); }
  });
}
