// 36.6.0 recurring reminders and school operations automation.
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { HttpError } from "./role-app-util.js";
const LEADS=["principal","vice_principal","superintendent","it_admin"];
const DOMAINS=["facilities","health_office","counseling","meal_service"];
const clean=(v,n)=>typeof v==="string"?v.trim().slice(0,n):"";
const advance=(date,cadence)=>{const d=new Date(date);if(cadence==="daily")d.setUTCDate(d.getUTCDate()+1);else if(cadence==="weekly")d.setUTCDate(d.getUTCDate()+7);else d.setUTCMonth(d.getUTCMonth()+1);return d;};
const send=(res,next,e)=>{if(e instanceof HttpError)return res.status(e.status||400).json({error:e.code||"request_failed"});next(e)};
export function registerSchoolOperationsAutomationRoutes(app){
 app.get("/api/school-operations/schedules",requireSession,async(req,res,next)=>{
  const a=req.actor;if(!LEADS.includes(a.role))return res.status(403).json({error:"schedule_access_denied"});
  try{const data=await withTenantTransaction(a,async c=>{
   const district=["superintendent","it_admin"].includes(a.role);
   const q=await c.query(`SELECT id,school_id,domain,kind,summary,priority,cadence,next_run_at,active,created_at FROM school_operation_schedules WHERE district_id=$1 AND ($2::uuid IS NULL OR school_id=$2) ORDER BY next_run_at`,[a.districtId,district?null:a.schoolId]);
   return q.rows;
  });res.setHeader("Cache-Control","no-store");res.json({data});}catch(e){send(res,next,e)}
 });
 app.post("/api/school-operations/schedules",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{};if(!LEADS.includes(a.role))return res.status(403).json({error:"schedule_manage_denied"});
  const schoolId=b.schoolId||a.schoolId,domain=b.domain,kind=clean(b.kind,60),summary=clean(b.summary,300),cadence=b.cadence,priority=["low","normal","high","urgent"].includes(b.priority)?b.priority:"normal",nextRun=new Date(b.nextRunAt);
  if(!DOMAINS.includes(domain)||!kind||!summary||!["daily","weekly","monthly"].includes(cadence)||!Number.isFinite(nextRun.getTime()))return res.status(400).json({error:"invalid_schedule"});
  if(!schoolId||(!["superintendent","it_admin"].includes(a.role)&&schoolId!==a.schoolId))return res.status(403).json({error:"school_scope_denied"});
  try{const data=await withTenantTransaction(a,async c=>{
   const school=await c.query("SELECT id FROM schools WHERE id=$1 AND district_id=$2",[schoolId,a.districtId]);if(!school.rowCount)throw new HttpError(400,"school_outside_district");
   if(["health_office","counseling"].includes(domain)&&/(student|patient|diagnos|treatment|counsel)/i.test(summary))throw new HttpError(400,"sensitive_summary_not_supported");
   const q=await c.query(`INSERT INTO school_operation_schedules(district_id,school_id,domain,kind,summary,priority,cadence,next_run_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,school_id,domain,kind,summary,priority,cadence,next_run_at,active`,[a.districtId,schoolId,domain,kind,summary,priority,cadence,nextRun,a.userId]);
   await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id) VALUES($1,$2,$3,'create','school_operation_schedule',$4,'success',$5,$6)`,[a.districtId,a.userId,a.role,q.rows[0].id,`domain=${domain}; cadence=${cadence}`,req.requestId]);return q.rows[0];
  });res.status(201).json({data});}catch(e){send(res,next,e)}
 });
 app.post("/api/school-operations/schedules/run-due",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor;if(!LEADS.includes(a.role))return res.status(403).json({error:"schedule_run_denied"});
  try{const data=await withTenantTransaction(a,async c=>{
   const district=["superintendent","it_admin"].includes(a.role);
   const q=await c.query(`SELECT * FROM school_operation_schedules WHERE district_id=$1 AND active=true AND next_run_at<=now() AND ($2::uuid IS NULL OR school_id=$2) ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 100`,[a.districtId,district?null:a.schoolId]);
   const generated=[];
   for(const schedule of q.rows){
    const work=await c.query(`INSERT INTO school_service_work(district_id,school_id,domain,kind,status,priority,summary,created_by,schedule_id,due_at) VALUES($1,$2,$3,$4,'open',$5,$6,$7,$8,now()+interval '1 day') RETURNING id,domain,kind,status,priority,summary,due_at`,[schedule.district_id,schedule.school_id,schedule.domain,schedule.kind,schedule.priority,schedule.summary,a.userId,schedule.id]);
    let next=new Date(schedule.next_run_at);do{next=advance(next,schedule.cadence)}while(next<=new Date());
    await c.query("UPDATE school_operation_schedules SET next_run_at=$2,updated_at=now() WHERE id=$1",[schedule.id,next]);
    generated.push(work.rows[0]);
   }
   await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,outcome,detail,request_id) VALUES($1,$2,$3,'run','school_operation_schedules','success',$4,$5)`,[a.districtId,a.userId,a.role,`generated=${generated.length}`,req.requestId]);
   return {generatedCount:generated.length,work:generated};
  });res.json({data});}catch(e){send(res,next,e)}
 });
 app.post("/api/school-operations/schedules/:id/active",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor;if(!LEADS.includes(a.role))return res.status(403).json({error:"schedule_manage_denied"});
  const active=req.body?.active;if(typeof active!=="boolean")return res.status(400).json({error:"active_boolean_required"});
  try{const data=await withTenantTransaction(a,async c=>{
   const q=await c.query(`UPDATE school_operation_schedules SET active=$3,updated_at=now() WHERE id=$1 AND district_id=$2 AND ($4::uuid IS NULL OR school_id=$4) RETURNING id,active,next_run_at`,[req.params.id,a.districtId,active,["superintendent","it_admin"].includes(a.role)?null:a.schoolId]);
   if(!q.rowCount)throw new HttpError(404,"schedule_not_found");
   await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id) VALUES($1,$2,$3,'update','school_operation_schedule',$4,'success',$5,$6)`,[a.districtId,a.userId,a.role,req.params.id,`active=${active}`,req.requestId]);return q.rows[0];
  });res.json({data});}catch(e){send(res,next,e)}
 });
}
