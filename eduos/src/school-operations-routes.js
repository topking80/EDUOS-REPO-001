import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { HttpError } from "./role-app-util.js";
const DOMAIN_ROLES={facilities:["maintenance","principal","vice_principal"],health_office:["nurse"],counseling:["counselor"],meal_service:["lunch_staff","principal","vice_principal"]};
const ALL=["superintendent","it_admin","principal","vice_principal","counselor","nurse","maintenance","lunch_staff"];
const clean=(v,n)=>typeof v==="string"?v.trim().slice(0,n):"";
const wrap=fn=>async(req,res,next)=>{try{const data=await withTenantTransaction(req.actor,c=>fn(c,req));res.setHeader("Cache-Control","no-store");res.json({data});}catch(e){next(e)}};
export function registerSchoolOperationsRoutes(app){
 app.get("/api/school-operations/:domain",requireSession,wrap(async(c,req)=>{
  const a=req.actor,d=req.params.domain;if(!ALL.includes(a.role)||!["facilities","health_office","counseling","meal_service"].includes(d))throw new HttpError(403,"operations_access_denied");
  if(!["superintendent","it_admin"].includes(a.role)&&!DOMAIN_ROLES[d].includes(a.role))throw new HttpError(403,"operations_access_denied");
  const school=a.schoolId;
  if(!school&&!["superintendent","it_admin"].includes(a.role))throw new HttpError(403,"school_scope_required");
  const q=await c.query(`SELECT id,domain,kind,status,priority,summary,created_at,updated_at FROM school_service_work WHERE district_id=$1 AND domain=$2 AND ($3::uuid IS NULL OR school_id=$3) ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,created_at DESC LIMIT 100`,[a.districtId,d,school||null]);
  return q.rows;
 }));
 app.post("/api/school-operations/:domain",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,d=req.params.domain,b=req.body||{};
  if(!DOMAIN_ROLES[d]?.includes(a.role)||!a.schoolId)return res.status(403).json({error:"operations_access_denied"});
  const kind=clean(b.kind,60),summary=clean(b.summary,300),details=clean(b.details,500),priority=["low","normal","high","urgent"].includes(b.priority)?b.priority:"normal";
  if(!kind||!summary)return res.status(400).json({error:"kind_and_summary_required"});
  // Health and counseling queues are operational routing only; never accept student identifiers,
  // diagnoses, treatment notes, or confidential counseling narratives.
  if(["health_office","counseling"].includes(d)&&details)return res.status(400).json({error:"sensitive_notes_not_supported_use_approved_student_health_or_counseling_system"});
  try{const data=await withTenantTransaction(a,async c=>{
   const q=await c.query(`INSERT INTO school_service_work(district_id,school_id,domain,kind,priority,summary,details,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,domain,kind,status,priority,summary,created_at`,[a.districtId,a.schoolId,d,kind,priority,summary,details||null,a.userId]);
   await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id) VALUES($1,$2,$3,'create','school_service_work',$4,'success',$5,$6)`,[a.districtId,a.userId,a.role,q.rows[0].id,`domain=${d}; kind=${kind}`,req.requestId]);
   return q.rows[0];
  });res.status(201).json({data});}catch(e){next(e)}
 });
 app.post("/api/school-operations/:domain/:id/status",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,d=req.params.domain,id=req.params.id,status=req.body?.status;
  // Only that domain's own team, or school/district leads, may change an item:
  // a maintenance worker can't close a health-office or counseling item, and a
  // nurse can't close a facilities work order.
  const lead=["principal","vice_principal","superintendent","it_admin"].includes(a.role);
  if(!DOMAIN_ROLES[d]||!(lead||DOMAIN_ROLES[d].includes(a.role))||!["open","in_progress","completed","cancelled"].includes(status))return res.status(403).json({error:"operations_update_denied"});
  try{const data=await withTenantTransaction(a,async c=>{
   const q=await c.query(`UPDATE school_service_work SET status=$4,updated_at=now() WHERE id=$1 AND district_id=$2 AND domain=$3 AND ($5::uuid IS NULL OR school_id=$5) RETURNING id,domain,status,updated_at`,[id,a.districtId,d,status,a.schoolId||null]);
   if(!q.rowCount)throw new HttpError(404,"work_item_not_found");
   await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id) VALUES($1,$2,$3,'update','school_service_work',$4,'success',$5,$6)`,[a.districtId,a.userId,a.role,id,`status=${status}`,req.requestId]);return q.rows[0];
  });res.json({data});}catch(e){next(e)}
 });
}
