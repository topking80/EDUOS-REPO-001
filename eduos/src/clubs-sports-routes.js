// 37.6.0: Clubs, sports, school events and deliberately gated media commerce.
import { randomBytes, createHash } from "node:crypto";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
const DISTRICT = role => ["superintendent","it_admin"].includes(role);
const LEAD = role => ["superintendent","principal"].includes(role);
const wrap = fn => async (req,res,next) => { try { const data=await withTenantTransaction(req.actor,c=>fn(c,req)); res.setHeader("Cache-Control","no-store"); res.json({data}); } catch(e) { sendError(res,next,e); } };
async function scopedActivity(c,a,id,lock=false) {
 return one(c,`SELECT * FROM school_activities WHERE id=$1 AND district_id=$2 AND ($3::uuid IS NULL OR school_id=$3) ${lock?"FOR UPDATE":""}`,[id,a.districtId,DISTRICT(a.role)?null:a.schoolId]);
}
async function canManage(c,a,id) {
 if(LEAD(a.role))return true;
 if(a.role!=="teacher")return false;
 return Boolean(await one(c,"SELECT id FROM activity_staff WHERE district_id=$1 AND school_id=$2 AND activity_id=$3 AND user_id=$4",[a.districtId,a.schoolId,id,a.userId]));
}
async function requireActivityManager(c,a,id) {
 const activity=await scopedActivity(c,a,id,true);if(!activity)throw new HttpError(404,"activity_not_found");
 if(!await canManage(c,a,id))throw new HttpError(403,"activity_assignment_required");return activity;
}
const safeActivity=r=>({id:r.id,schoolId:r.school_id,kind:r.kind,title:r.title,description:r.description,gradeMin:r.grade_min,gradeMax:r.grade_max,meetingDetails:r.meeting_details,status:r.status,createdAt:r.created_at});
export function registerClubsSportsRoutes(app) {
 app.get("/api/activities",requireSession,wrap(async(c,req)=>{
  const a=req.actor;if(!["superintendent","it_admin","principal","teacher","parent","pupil"].includes(a.role))throw new HttpError(403,"activities_access_forbidden");
  const data=await rows(c,`SELECT a.*,sc.name AS school_name,(SELECT count(*)::int FROM activity_memberships m WHERE m.activity_id=a.id AND m.status='active') AS member_count
   FROM school_activities a JOIN schools sc ON sc.id=a.school_id AND sc.district_id=a.district_id
   WHERE a.district_id=$1 AND ($2::uuid IS NULL OR a.school_id=$2) AND (a.status='published' OR $3) ORDER BY a.kind,a.title LIMIT 500`,
   [a.districtId,DISTRICT(a.role)?null:a.schoolId,LEAD(a.role)||a.role==="teacher"]);
  return data.map(r=>({...safeActivity(r),schoolName:r.school_name,memberCount:r.member_count}));
 }));
 app.post("/api/activities",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{};if(!LEAD(a.role))return res.status(403).json({error:"activity_creation_requires_school_lead"});
  if(!["club","sport"].includes(b.kind)||!cleanText(b.title,160,2)||!cleanText(b.description||"",4000,0)||!cleanText(b.meetingDetails||"",1000,0)||!["draft","published"].includes(b.status||"draft"))return res.status(400).json({error:"invalid_activity"});
  const schoolId=b.schoolId||a.schoolId;if(!validId(schoolId))return res.status(400).json({error:"invalid_school_id"});
  const min=b.gradeMin==null?null:Number(b.gradeMin),max=b.gradeMax==null?null:Number(b.gradeMax);
  if((min!==null&&(!Number.isInteger(min)||min<0||min>12))||(max!==null&&(!Number.isInteger(max)||max<0||max>12))||(min!==null&&max!==null&&min>max))return res.status(400).json({error:"invalid_grade_range"});
  try{const data=await withTenantTransaction(a,async c=>{
   if(!DISTRICT(a.role)&&schoolId!==a.schoolId)throw new HttpError(403,"school_scope_denied");
   if(!await one(c,"SELECT id FROM schools WHERE id=$1 AND district_id=$2",[schoolId,a.districtId]))throw new HttpError(400,"school_outside_district");
   const r=await one(c,`INSERT INTO school_activities(district_id,school_id,kind,title,description,grade_min,grade_max,meeting_details,status,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[a.districtId,schoolId,b.kind,b.title.trim(),(b.description||"").trim(),min,max,(b.meetingDetails||"").trim(),b.status||"draft",a.userId]);
   await audit(c,req,"create","school_activity",r.id,`kind=${r.kind};status=${r.status}`);return safeActivity(r);
  });res.status(201).json({data});}catch(e){sendError(res,next,e)}
 });
 app.post("/api/activities/:id/staff",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{};if(!LEAD(a.role))return res.status(403).json({error:"school_lead_required"});
  if(!validId(req.params.id)||!validId(b.userId)||!["advisor","coach"].includes(b.staffRole))return res.status(400).json({error:"invalid_activity_staff"});
  try{const data=await withTenantTransaction(a,async c=>{
   const activity=await scopedActivity(c,a,req.params.id,true);if(!activity)throw new HttpError(404,"activity_not_found");
   if(b.staffRole!==(activity.kind==="club"?"advisor":"coach"))throw new HttpError(400,"staff_role_mismatch");
   if(!await one(c,`SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.district_id=$1 AND m.school_id=$2 AND m.user_id=$3 AND m.role='teacher' AND m.status='active' AND u.status='active'`,[a.districtId,activity.school_id,b.userId]))throw new HttpError(400,"active_school_teacher_required");
   const r=await one(c,`INSERT INTO activity_staff(district_id,school_id,activity_id,user_id,staff_role,assigned_by) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(district_id,activity_id,user_id) DO UPDATE SET staff_role=EXCLUDED.staff_role,assigned_by=EXCLUDED.assigned_by,assigned_at=now() RETURNING id,activity_id,user_id,staff_role`,[a.districtId,activity.school_id,activity.id,b.userId,b.staffRole,a.userId]);
   await audit(c,req,"assign","activity_staff",r.id,`activity=${activity.id};role=${b.staffRole}`);return r;
  });res.status(201).json({data});}catch(e){sendError(res,next,e)}
 });
 app.patch("/api/activities/:id",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{};if(!validId(req.params.id)||Object.keys(b).some(k=>!["title","description","meetingDetails","status"].includes(k)))return res.status(400).json({error:"invalid_activity_update"});
  try{const data=await withTenantTransaction(a,async c=>{
   const old=await requireActivityManager(c,a,req.params.id);
   const title=b.title??old.title,description=b.description??old.description,meeting=b.meetingDetails??old.meeting_details,status=b.status??old.status;
   if(!cleanText(title,160,2)||!cleanText(description,4000,0)||!cleanText(meeting,1000,0)||!["draft","published","archived"].includes(status))throw new HttpError(400,"invalid_activity_update");
   if(status==="published"&&!LEAD(a.role)&&old.status!=="published")throw new HttpError(403,"principal_approval_required");
   const r=await one(c,"UPDATE school_activities SET title=$2,description=$3,meeting_details=$4,status=$5,updated_at=now() WHERE id=$1 RETURNING *",[old.id,title.trim(),description.trim(),meeting.trim(),status]);
   await audit(c,req,"update","school_activity",r.id,`status=${status}`);return safeActivity(r);
  });res.json({data});}catch(e){sendError(res,next,e)}
 });
 app.post("/api/activities/:id/join",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor;if(a.role!=="pupil")return res.status(403).json({error:"student_membership_only"});if(!validId(req.params.id))return res.status(400).json({error:"invalid_activity_id"});
  try{const data=await withTenantTransaction(a,async c=>{
   const activity=await scopedActivity(c,a,req.params.id);if(!activity||activity.status!=="published")throw new HttpError(404,"activity_not_found");
   const grade=await one(c,`SELECT s.grade_level FROM student_user_links l JOIN students s ON s.id=l.student_id AND s.district_id=l.district_id
    WHERE l.district_id=$1 AND l.user_id=$2 AND l.relationship='pupil' AND l.status='active' AND s.school_id=$3 LIMIT 1`,[a.districtId,a.userId,a.schoolId]);
   if(activity.grade_min!==null||activity.grade_max!==null){const g=Number(grade?.grade_level);if(!Number.isFinite(g)||(activity.grade_min!==null&&g<activity.grade_min)||(activity.grade_max!==null&&g>activity.grade_max))throw new HttpError(403,"grade_eligibility_not_met");}
   const r=await one(c,`INSERT INTO activity_memberships(district_id,school_id,activity_id,user_id,status) VALUES($1,$2,$3,$4,'active')
    ON CONFLICT(district_id,activity_id,user_id) DO UPDATE SET status='active',joined_at=now() RETURNING id,status,joined_at`,[a.districtId,activity.school_id,activity.id,a.userId]);
   await audit(c,req,"join","activity_membership",r.id,`activity=${activity.id}`);return r;
  });res.status(201).json({data});}catch(e){sendError(res,next,e)}
 });
 app.get("/api/events",requireSession,wrap(async(c,req)=>{
  const a=req.actor;if(!["superintendent","it_admin","principal","teacher","parent","pupil"].includes(a.role))throw new HttpError(403,"events_access_forbidden");
  return rows(c,`SELECT e.id,e.school_id,e.activity_id,e.title,e.description,e.starts_at,e.ends_at,e.venue,e.status,sc.name AS school_name
   FROM school_events e JOIN schools sc ON sc.id=e.school_id AND sc.district_id=e.district_id
   WHERE e.district_id=$1 AND ($2::uuid IS NULL OR e.school_id=$2) AND (e.status='published' OR $3) ORDER BY e.starts_at LIMIT 500`,
   [a.districtId,DISTRICT(a.role)?null:a.schoolId,LEAD(a.role)||a.role==="teacher"]);
 }));
 app.post("/api/activities/:id/events",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{};if(!validId(req.params.id)||!cleanText(b.title,180,2)||!Number.isFinite(Date.parse(b.startsAt))||!Number.isFinite(Date.parse(b.endsAt))||Date.parse(b.endsAt)<=Date.parse(b.startsAt)||!cleanText(b.venue||"",300,0))return res.status(400).json({error:"invalid_event"});
  try{const data=await withTenantTransaction(a,async c=>{
   const activity=await requireActivityManager(c,a,req.params.id);if(!LEAD(a.role)&&activity.status!=="published")throw new HttpError(403,"principal_approval_required");
   const r=await one(c,`INSERT INTO school_events(district_id,school_id,activity_id,title,description,starts_at,ends_at,venue,status,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[a.districtId,activity.school_id,activity.id,b.title.trim(),String(b.description||"").slice(0,4000),new Date(b.startsAt).toISOString(),new Date(b.endsAt).toISOString(),(b.venue||"").trim(),LEAD(a.role)&&b.publish===true?"published":"draft",a.userId]);
   await audit(c,req,"create","school_event",r.id,`activity=${activity.id};status=${r.status}`);return r;
  });res.status(201).json({data});}catch(e){sendError(res,next,e)}
 });
 app.post("/api/events/:id/ticket-types",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{};if(!LEAD(a.role))return res.status(403).json({error:"school_lead_required"});
  if(!validId(req.params.id)||!cleanText(b.name,80,2)||!Number.isInteger(b.capacity)||b.capacity<1||b.capacity>1000000||!Number.isInteger(b.priceCents??0)||(b.priceCents??0)<0||(b.priceCents??0)>1000000||!(b.currency||"USD").match(/^[A-Z]{3}$/))return res.status(400).json({error:"invalid_ticket_type"});
  try{const data=await withTenantTransaction(a,async c=>{
   const event=await one(c,"SELECT * FROM school_events WHERE id=$1 AND district_id=$2 AND ($3::uuid IS NULL OR school_id=$3) FOR UPDATE",[req.params.id,a.districtId,DISTRICT(a.role)?null:a.schoolId]);if(!event)throw new HttpError(404,"event_not_found");
   const r=await one(c,`INSERT INTO event_ticket_types(district_id,school_id,event_id,name,price_cents,currency,capacity,sales_open)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,event_id,name,price_cents,currency,capacity,sold_count,sales_open`,[a.districtId,event.school_id,event.id,b.name.trim(),b.priceCents??0,b.currency||"USD",b.capacity,b.salesOpen===true]);
   await audit(c,req,"create","event_ticket_type",r.id,`event=${event.id};capacity=${r.capacity}`);return r;
  });res.status(201).json({data});}catch(e){sendError(res,next,e)}
 });
 app.post("/api/events/:id/tickets",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{},quantity=Number(b.quantity||1),key=b.idempotencyKey;
  if(!["pupil","parent"].includes(a.role))return res.status(403).json({error:"ticket_buyer_role_required"});
  if(!validId(req.params.id)||!validId(b.ticketTypeId)||!Number.isInteger(quantity)||quantity<1||quantity>10||typeof key!=="string"||key.length<16||key.length>120)return res.status(400).json({error:"invalid_ticket_order"});
  try{const data=await withTenantTransaction(a,async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[a.districtId,a.userId+":"+key]);
   const prior=await one(c,"SELECT id,status,total_cents,currency FROM event_ticket_orders WHERE district_id=$1 AND buyer_user_id=$2 AND idempotency_key=$3",[a.districtId,a.userId,key]);
   if(prior)return {order:prior,replayed:true,tickets:await rows(c,"SELECT id,status FROM event_tickets WHERE order_id=$1",[prior.id])};
   const event=await one(c,"SELECT * FROM school_events WHERE id=$1 AND district_id=$2 AND status='published' AND starts_at>now()",[req.params.id,a.districtId]);
   if(!event)throw new HttpError(404,"event_not_available");
   if(a.role==="parent"){
    const linked=await one(c,`SELECT 1 FROM student_user_links l JOIN students s ON s.id=l.student_id AND s.district_id=l.district_id
      WHERE l.district_id=$1 AND l.user_id=$2 AND l.status='active' AND l.relationship IN ('parent','guardian') AND s.school_id=$3 LIMIT 1`,[a.districtId,a.userId,event.school_id]);
    if(!linked)throw new HttpError(403,"guardian_school_link_required");
   } else if(a.schoolId!==event.school_id)throw new HttpError(403,"event_school_scope_denied");
   const type=await one(c,"SELECT * FROM event_ticket_types WHERE id=$1 AND event_id=$2 AND district_id=$3 AND sales_open FOR UPDATE",[b.ticketTypeId,event.id,a.districtId]);
   if(!type)throw new HttpError(404,"ticket_type_not_available");
   if(type.price_cents>0)throw new HttpError(503,"paid_ticketing_not_configured",{checkoutEnabled:false,reason:"district_payment_provider_not_connected"});
   if(type.sold_count+quantity>type.capacity)throw new HttpError(409,"ticket_capacity_exceeded");
   await c.query("UPDATE event_ticket_types SET sold_count=sold_count+$2 WHERE id=$1",[type.id,quantity]);
   const order=await one(c,`INSERT INTO event_ticket_orders(district_id,school_id,event_id,buyer_user_id,ticket_type_id,quantity,total_cents,currency,status,idempotency_key)
    VALUES($1,$2,$3,$4,$5,$6,0,$7,'complimentary',$8) RETURNING id,status,total_cents,currency`,[a.districtId,event.school_id,event.id,a.userId,type.id,quantity,type.currency,key]);
   const tickets=[];for(let i=0;i<quantity;i++){const code=randomBytes(24).toString("base64url"),hash=createHash("sha256").update(code).digest("hex");
    const ticket=await one(c,"INSERT INTO event_tickets(district_id,school_id,order_id,event_id,ticket_code_hash) VALUES($1,$2,$3,$4,$5) RETURNING id,status",[a.districtId,event.school_id,order.id,event.id,hash]);tickets.push({id:ticket.id,code});}
   await audit(c,req,"create","event_ticket_order",order.id,`event=${event.id};quantity=${quantity};complimentary=true`);return {order,tickets,replayed:false};
  });res.status(201).json({data});}catch(e){sendError(res,next,e)}
 });
 app.post("/api/events/:id/stream",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{};if(!LEAD(a.role))return res.status(403).json({error:"school_lead_required"});
  if(!validId(req.params.id)||!Number.isFinite(Date.parse(b.startsAt))||!Number.isFinite(Date.parse(b.endsAt))||Date.parse(b.endsAt)<=Date.parse(b.startsAt)||!["school","district","ticket_holders"].includes(b.audience||"school"))return res.status(400).json({error:"invalid_stream_schedule"});
  try{const data=await withTenantTransaction(a,async c=>{
   const event=await one(c,"SELECT * FROM school_events WHERE id=$1 AND district_id=$2 AND ($3::uuid IS NULL OR school_id=$3) FOR UPDATE",[req.params.id,a.districtId,DISTRICT(a.role)?null:a.schoolId]);if(!event)throw new HttpError(404,"event_not_found");
   const r=await one(c,`INSERT INTO event_streams(district_id,school_id,event_id,status,audience,starts_at,ends_at,recording_allowed,created_by)
    VALUES($1,$2,$3,'planned',$4,$5,$6,false,$7) RETURNING id,event_id,status,audience,starts_at,ends_at,recording_allowed,provider`,[a.districtId,event.school_id,event.id,b.audience||"school",new Date(b.startsAt).toISOString(),new Date(b.endsAt).toISOString(),a.userId]);
   await audit(c,req,"create","event_stream",r.id,"planned; provider not configured");return {...r,playbackEnabled:false,reason:"stream_provider_not_connected"};
  });res.status(201).json({data});}catch(e){sendError(res,next,e)}
 });
 app.get("/api/events/:id/stream",requireSession,wrap(async(c,req)=>{
  if(!validId(req.params.id))throw new HttpError(400,"invalid_event_id");const a=req.actor;
  const r=await one(c,`SELECT s.id,s.event_id,s.status,s.audience,s.starts_at,s.ends_at,s.recording_allowed,s.provider FROM event_streams s
   JOIN school_events e ON e.id=s.event_id AND e.district_id=s.district_id WHERE s.event_id=$1 AND s.district_id=$2
   AND (s.school_id=$3 OR $4) AND e.status='published' ORDER BY s.created_at DESC LIMIT 1`,
   [req.params.id,a.districtId,a.schoolId,DISTRICT(a.role)||["principal","teacher"].includes(a.role)]);
  return r?{...r,playbackEnabled:false,reason:"stream_provider_not_connected"}:null;
 }));
}
