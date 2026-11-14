// 36.7.0: in-app reminders for assigned school operations work.
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
const LEADS=["principal","vice_principal","superintendent","it_admin"];
const send=(res,next,e)=>{if(e.status)return res.status(e.status).json({error:e.code||"request_failed"});next(e)};
export function registerSchoolOperationsNotificationRoutes(app){
 app.get("/api/school-operations/notification-preferences",requireSession,async(req,res,next)=>{
  try{const data=await withTenantTransaction(req.actor,async c=>{
   const q=await c.query(`SELECT in_app_enabled,due_soon_enabled,overdue_enabled,escalation_enabled FROM school_ops_notification_preferences WHERE district_id=$1 AND user_id=$2`,[req.actor.districtId,req.actor.userId]);
   return q.rows[0]||{in_app_enabled:true,due_soon_enabled:true,overdue_enabled:true,escalation_enabled:true};
  });res.setHeader("Cache-Control","no-store");res.json({data});}catch(e){send(res,next,e)}
 });
 app.put("/api/school-operations/notification-preferences",requireSession,requireCsrf,async(req,res,next)=>{
  const b=req.body||{};for(const k of ["in_app_enabled","due_soon_enabled","overdue_enabled","escalation_enabled"])if(typeof b[k]!=="boolean")return res.status(400).json({error:"invalid_preferences"});
  try{const data=await withTenantTransaction(req.actor,async c=>{
   const q=await c.query(`INSERT INTO school_ops_notification_preferences(district_id,user_id,in_app_enabled,due_soon_enabled,overdue_enabled,escalation_enabled) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(district_id,user_id) DO UPDATE SET in_app_enabled=EXCLUDED.in_app_enabled,due_soon_enabled=EXCLUDED.due_soon_enabled,overdue_enabled=EXCLUDED.overdue_enabled,escalation_enabled=EXCLUDED.escalation_enabled,updated_at=now() RETURNING in_app_enabled,due_soon_enabled,overdue_enabled,escalation_enabled`,[req.actor.districtId,req.actor.userId,b.in_app_enabled,b.due_soon_enabled,b.overdue_enabled,b.escalation_enabled]);return q.rows[0];
  });res.json({data});}catch(e){send(res,next,e)}
 });
 app.post("/api/school-operations/notifications/dispatch-due",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor;if(!LEADS.includes(a.role))return res.status(403).json({error:"notification_dispatch_denied"});
  try{const data=await withTenantTransaction(a,async c=>{
   const district=["superintendent","it_admin"].includes(a.role);
   const work=await c.query(`SELECT w.id,w.school_id,w.assigned_to,w.priority,w.due_at,w.escalation_level FROM school_service_work w WHERE w.district_id=$1 AND w.status IN ('open','in_progress') AND w.due_at IS NOT NULL AND ($2::uuid IS NULL OR w.school_id=$2) AND w.due_at<=now()+interval '24 hours' ORDER BY w.due_at LIMIT 300`,[a.districtId,district?null:a.schoolId]);
   let created=0,skipped=0;
   for(const w of work.rows){
    const type=w.escalation_level>0?"escalation":(new Date(w.due_at)<new Date()?"overdue":"due_soon");
    let recipients=[];
    if(w.assigned_to)recipients=[w.assigned_to];
    else {const q=await c.query(`SELECT user_id FROM memberships WHERE district_id=$1 AND school_id=$2 AND role IN ('principal','vice_principal') AND status='active'`,[a.districtId,w.school_id]);recipients=q.rows.map(x=>x.user_id);}
    for(const uid of recipients){
     const pref=await c.query(`SELECT * FROM school_ops_notification_preferences WHERE district_id=$1 AND user_id=$2`,[a.districtId,uid]);const p=pref.rows[0];
     if(p&&(!p.in_app_enabled||(type==="overdue"&&!p.overdue_enabled)||(type==="due_soon"&&!p.due_soon_enabled)||(type==="escalation"&&!p.escalation_enabled))){skipped++;continue;}
     const claim=await c.query(`INSERT INTO school_ops_notification_ledger(district_id,school_id,work_id,recipient_user_id,notice_type) VALUES($1,$2,$3,$4,$5) ON CONFLICT(work_id,recipient_user_id,notice_type) DO NOTHING RETURNING id`,[a.districtId,w.school_id,w.id,uid,type]);
     if(!claim.rowCount){skipped++;continue;}
     const notification=await c.query(`INSERT INTO notification_outbox(district_id,school_id,recipient_user_id,channel,kind,title,body,ref_type,ref_id,status,delivered_at) VALUES($1,$2,$3,'in_app','school_operations',$4,$5,'school_service_work',$6,'delivered',now()) RETURNING id`,[a.districtId,w.school_id,uid,type==="escalation"?"School operations escalation":type==="overdue"?"School task overdue":"School task due soon",`An assigned school operations task requires attention. Priority: ${w.priority}.`,w.id]);
     await c.query(`UPDATE school_ops_notification_ledger SET notification_id=$2 WHERE id=$1`,[claim.rows[0].id,notification.rows[0].id]);created++;
    }
   }
   await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,outcome,detail,request_id) VALUES($1,$2,$3,'dispatch','school_operations_notifications','success',$4,$5)`,[a.districtId,a.userId,a.role,`created=${created}; skipped=${skipped}`,req.requestId]);
   return {created,skipped,checked:work.rows.length,delivery:"in_app_only"};
  });res.json({data});}catch(e){send(res,next,e)}
 });
}
