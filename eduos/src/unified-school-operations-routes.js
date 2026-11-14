// 36.5.0 unified school operations dashboard, assignment and escalation.
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { HttpError } from "./role-app-util.js";
const DISTRICT=["superintendent","it_admin"];
const LEADS=["principal","vice_principal",...DISTRICT];
const DOMAINS=["facilities","health_office","counseling","meal_service"];
const ROLE_FOR={facilities:["maintenance"],health_office:["nurse"],counseling:["counselor"],meal_service:["lunch_staff"]};
const send=(res,next,e)=>{if(e instanceof HttpError)return res.status(e.status||400).json({error:e.code||"request_failed"});next(e)};
export function registerUnifiedSchoolOperationsRoutes(app){
 app.get("/api/school-operations/command-center",requireSession,async(req,res,next)=>{
  const a=req.actor;if(!["superintendent","it_admin","principal","vice_principal","maintenance","nurse","counselor","lunch_staff"].includes(a.role))return res.status(403).json({error:"operations_access_denied"});
  try{const data=await withTenantTransaction(a,async c=>{
   const district=DISTRICT.includes(a.role),domain=ROLE_FOR.facilities.includes(a.role)?"facilities":ROLE_FOR.health_office.includes(a.role)?"health_office":ROLE_FOR.counseling.includes(a.role)?"counseling":ROLE_FOR.meal_service.includes(a.role)?"meal_service":null;
   const result=await c.query(`SELECT domain,status,priority,count(*)::int AS count,count(*) FILTER(WHERE due_at IS NOT NULL AND due_at<now() AND status IN ('open','in_progress'))::int AS overdue,count(*) FILTER(WHERE priority='urgent' AND status IN ('open','in_progress'))::int AS urgent FROM school_service_work WHERE district_id=$1 AND ($2::uuid IS NULL OR school_id=$2) AND ($3::text IS NULL OR domain=$3) GROUP BY domain,status,priority ORDER BY domain,status,priority`,[a.districtId,district?null:a.schoolId,domain]);
   const due=await c.query(`SELECT id,school_id,domain,kind,status,priority,summary,due_at,escalation_level,assigned_to,created_at FROM school_service_work WHERE district_id=$1 AND ($2::uuid IS NULL OR school_id=$2) AND ($3::text IS NULL OR domain=$3) AND status IN ('open','in_progress') ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,due_at NULLS LAST,created_at LIMIT 250`,[a.districtId,district?null:a.schoolId,domain]);
   return {summary:result.rows,work:due.rows};
  });res.setHeader("Cache-Control","no-store");res.json({data});}catch(e){send(res,next,e)}
 });
 app.post("/api/school-operations/:domain/:id/assign",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,d=req.params.domain,id=req.params.id,assignee=req.body?.assignedTo,due=req.body?.dueAt||null;
  if(!LEADS.includes(a.role)||!DOMAINS.includes(d)||!assignee)return res.status(403).json({error:"operations_assignment_denied"});
  if(due&&(Number.isNaN(Date.parse(due))||Date.parse(due)<Date.now()-60000))return res.status(400).json({error:"invalid_due_date"});
  try{const data=await withTenantTransaction(a,async c=>{
   const target=await c.query(`SELECT m.user_id FROM memberships m WHERE m.user_id=$1 AND m.district_id=$2 AND m.school_id=$3 AND m.role=ANY($4::text[]) AND m.status='active' LIMIT 1`,[assignee,a.districtId,a.schoolId,ROLE_FOR[d]]);
   if(!target.rowCount)throw new HttpError(400,"assignee_not_active_in_school");
   const updated=await c.query(`UPDATE school_service_work SET assigned_to=$4,due_at=$5,updated_at=now() WHERE id=$1 AND district_id=$2 AND school_id=$3 AND domain=$6 AND status IN ('open','in_progress') RETURNING id,domain,status,priority,assigned_to,due_at`,[id,a.districtId,a.schoolId,assignee,due,d]);
   if(!updated.rowCount)throw new HttpError(404,"work_item_not_found");
   await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id) VALUES($1,$2,$3,'assign','school_service_work',$4,'success',$5,$6)`,[a.districtId,a.userId,a.role,id,`domain=${d}; assigned_to=${assignee}`,req.requestId]);
   return updated.rows[0];
  });res.json({data});}catch(e){send(res,next,e)}
 });
 app.post("/api/school-operations/:domain/:id/escalate",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,d=req.params.domain,id=req.params.id;
  if(!LEADS.includes(a.role)||!DOMAINS.includes(d))return res.status(403).json({error:"operations_escalation_denied"});
  try{const data=await withTenantTransaction(a,async c=>{
   const q=await c.query(`UPDATE school_service_work SET escalation_level=LEAST(3,escalation_level+1),escalated_at=now(),priority=CASE WHEN priority='low' THEN 'normal' WHEN priority='normal' THEN 'high' ELSE 'urgent' END,updated_at=now() WHERE id=$1 AND district_id=$2 AND ($3::uuid IS NULL OR school_id=$3) AND domain=$4 AND status IN ('open','in_progress') RETURNING id,domain,status,priority,escalation_level,escalated_at`,[id,a.districtId,DISTRICT.includes(a.role)?null:a.schoolId,d]);
   if(!q.rowCount)throw new HttpError(404,"active_work_item_not_found");
   await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id) VALUES($1,$2,$3,'escalate','school_service_work',$4,'success',$5,$6)`,[a.districtId,a.userId,a.role,id,`domain=${d}; level=${q.rows[0].escalation_level}`,req.requestId]);return q.rows[0];
  });res.json({data});}catch(e){send(res,next,e)}
 });
}
