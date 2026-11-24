// 36.8.0 shared daily workspace for school operations staff.
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { HttpError } from "./role-app-util.js";
const STAFF=["superintendent","it_admin","principal","vice_principal","counselor","nurse","maintenance","lunch_staff","librarian","teacher","driver","school_secretary"];
const LEADS=["superintendent","it_admin","principal","vice_principal"];
const DOMAINS=["general","facilities","health_office","counseling","meal_service","library","transport"];
const clean=(v,n)=>typeof v==="string"?v.trim().slice(0,n):"";
const fail=(res,next,e)=>{if(e instanceof HttpError)return res.status(e.status||400).json({error:e.code||"request_failed"});next(e)};
const scope=(a)=>["superintendent","it_admin"].includes(a.role)?null:a.schoolId;
export function registerStaffDailyWorkspaceRoutes(app){
 app.get("/api/staff-workspace",requireSession,async(req,res,next)=>{
  const a=req.actor;if(!STAFF.includes(a.role))return res.status(403).json({error:"workspace_access_denied"});
  try{const data=await withTenantTransaction(a,async c=>{
   const school=scope(a);if(!school&&!(["superintendent","it_admin"].includes(a.role)))throw new HttpError(403,"school_scope_required");
   const tasks=await c.query(`SELECT id,school_id,domain,kind,status,priority,summary,due_at,assigned_to FROM school_service_work WHERE district_id=$1 AND ($2::uuid IS NULL OR school_id=$2) AND status IN ('open','in_progress') AND (assigned_to=$3 OR $4::boolean OR assigned_to IS NULL) ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,due_at NULLS LAST LIMIT 150`,[a.districtId,school,a.userId,LEADS.includes(a.role)]);
   const checklists=await c.query(`SELECT c.id,c.title,c.domain,c.cadence,i.id AS item_id,i.label,i.position,r.completed_at,r.completed_by FROM school_staff_checklists c JOIN school_staff_checklist_items i ON i.checklist_id=c.id LEFT JOIN school_staff_checklist_runs r ON r.item_id=i.id AND r.run_date=current_date WHERE c.district_id=$1 AND ($2::uuid IS NULL OR c.school_id=$2) AND c.active=true ORDER BY c.title,i.position`,[a.districtId,school]);
   const handoffs=await c.query(`SELECT id,domain,summary,next_action,from_user_id,to_user_id,acknowledged_at,created_at FROM school_staff_handoffs WHERE district_id=$1 AND ($2::uuid IS NULL OR school_id=$2) AND (to_user_id IS NULL OR to_user_id=$3 OR $4::boolean) ORDER BY created_at DESC LIMIT 30`,[a.districtId,school,a.userId,LEADS.includes(a.role)]);
   const announcements=await c.query(`SELECT id,title,body,audience,created_at,expires_at FROM school_staff_announcements WHERE district_id=$1 AND ($2::uuid IS NULL OR school_id=$2) AND (expires_at IS NULL OR expires_at>now()) AND ($3::boolean OR audience='all_staff' OR $4::boolean) ORDER BY created_at DESC LIMIT 30`,[a.districtId,school,LEADS.includes(a.role),["maintenance","nurse","counselor","lunch_staff","librarian","driver"].includes(a.role)]);
   return {tasks:tasks.rows,checklists:checklists.rows,handoffs:handoffs.rows,announcements:announcements.rows};
  });res.setHeader("Cache-Control","no-store");res.json({data});}catch(e){fail(res,next,e)}
 });
 app.post("/api/staff-workspace/checklists",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{};if(!LEADS.includes(a.role)||!a.schoolId)return res.status(403).json({error:"checklist_management_denied"});
  const title=clean(b.title,180),domain=DOMAINS.includes(b.domain)?b.domain:"general",cadence=["daily","weekly","monthly","one_time"].includes(b.cadence)?b.cadence:"daily",items=Array.isArray(b.items)?b.items.map(x=>clean(x,240)).filter(Boolean).slice(0,50):[];
  if(!title||!items.length)return res.status(400).json({error:"title_and_items_required"});
  try{const data=await withTenantTransaction(a,async c=>{const q=await c.query(`INSERT INTO school_staff_checklists(district_id,school_id,title,domain,cadence,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,title,domain,cadence`,[a.districtId,a.schoolId,title,domain,cadence,a.userId]);for(let i=0;i<items.length;i++)await c.query(`INSERT INTO school_staff_checklist_items(checklist_id,label,position) VALUES($1,$2,$3)`,[q.rows[0].id,items[i],i]);await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id) VALUES($1,$2,$3,'create','school_staff_checklist',$4,'success',$5,$6)`,[a.districtId,a.userId,a.role,q.rows[0].id,`items=${items.length}`,req.requestId]);return q.rows[0]});res.status(201).json({data})}catch(e){fail(res,next,e)}
 });
 app.post("/api/staff-workspace/checklists/:itemId/complete",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor;if(!STAFF.includes(a.role))return res.status(403).json({error:"workspace_access_denied"});
  try{const data=await withTenantTransaction(a,async c=>{const item=await c.query(`SELECT i.id,c.id AS checklist_id,c.school_id FROM school_staff_checklist_items i JOIN school_staff_checklists c ON c.id=i.checklist_id WHERE i.id=$1 AND c.district_id=$2 AND ($3::uuid IS NULL OR c.school_id=$3) AND c.active=true`,[req.params.itemId,a.districtId,scope(a)]);if(!item.rowCount)throw new HttpError(404,"checklist_item_not_found");const q=await c.query(`INSERT INTO school_staff_checklist_runs(district_id,school_id,checklist_id,item_id,completed_by,completed_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(item_id,run_date) DO UPDATE SET completed_by=EXCLUDED.completed_by,completed_at=now() RETURNING id,item_id,completed_by,completed_at`,[a.districtId,item.rows[0].school_id,item.rows[0].checklist_id,item.rows[0].id,a.userId]);await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id) VALUES($1,$2,$3,'complete','school_staff_checklist_item',$4,'success','daily checklist item completed',$5)`,[a.districtId,a.userId,a.role,item.rows[0].id,req.requestId]);return q.rows[0]});res.json({data})}catch(e){fail(res,next,e)}
 });
 app.post("/api/staff-workspace/handoffs",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{};if(!STAFF.includes(a.role)||!a.schoolId)return res.status(403).json({error:"handoff_access_denied"});
  const domain=DOMAINS.includes(b.domain)?b.domain:"general",summary=clean(b.summary,500),nextAction=clean(b.nextAction,300),to=b.toUserId||null;
  if(!summary)return res.status(400).json({error:"handoff_summary_required"});
  if(["health_office","counseling"].includes(domain))return res.status(400).json({error:"sensitive_handoff_not_supported_use_approved_system"});
  try{const data=await withTenantTransaction(a,async c=>{if(to){const member=await c.query(`SELECT 1 FROM memberships WHERE user_id=$1 AND district_id=$2 AND school_id=$3 AND status='active'`,[to,a.districtId,a.schoolId]);if(!member.rowCount)throw new HttpError(400,"recipient_not_active_in_school")}const q=await c.query(`INSERT INTO school_staff_handoffs(district_id,school_id,domain,summary,next_action,from_user_id,to_user_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,domain,summary,next_action,from_user_id,to_user_id,created_at`,[a.districtId,a.schoolId,domain,summary,nextAction||null,a.userId,to]);await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id) VALUES($1,$2,$3,'create','school_staff_handoff',$4,'success',$5,$6)`,[a.districtId,a.userId,a.role,q.rows[0].id,`domain=${domain}`,req.requestId]);return q.rows[0]});res.status(201).json({data})}catch(e){fail(res,next,e)}
 });
 app.post("/api/staff-workspace/handoffs/:id/acknowledge",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor;if(!STAFF.includes(a.role))return res.status(403).json({error:"handoff_access_denied"});
  try{const data=await withTenantTransaction(a,async c=>{const q=await c.query(`UPDATE school_staff_handoffs SET acknowledged_at=now() WHERE id=$1 AND district_id=$2 AND ($3::uuid IS NULL OR school_id=$3) AND (to_user_id IS NULL OR to_user_id=$4) AND from_user_id<>$4 RETURNING id,acknowledged_at`,[req.params.id,a.districtId,scope(a),a.userId]);if(!q.rowCount)throw new HttpError(404,"handoff_not_found_or_not_assigned");return q.rows[0]});res.json({data})}catch(e){fail(res,next,e)}
 });
 app.post("/api/staff-workspace/announcements",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{};if(!LEADS.includes(a.role)||!a.schoolId)return res.status(403).json({error:"announcement_publish_denied"});
  const title=clean(b.title,180),body=clean(b.body,1200),audience=["all_staff","operations_staff"].includes(b.audience)?b.audience:"all_staff";if(!title||!body)return res.status(400).json({error:"title_and_body_required"});
  try{const data=await withTenantTransaction(a,async c=>{const q=await c.query(`INSERT INTO school_staff_announcements(district_id,school_id,title,body,audience,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,title,body,audience,created_at,expires_at`,[a.districtId,a.schoolId,title,body,audience,a.userId,b.expiresAt||null]);await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id) VALUES($1,$2,$3,'publish','school_staff_announcement',$4,'success',$5,$6)`,[a.districtId,a.userId,a.role,q.rows[0].id,`audience=${audience}`,req.requestId]);return q.rows[0]});res.status(201).json({data})}catch(e){fail(res,next,e)}
 });
}
