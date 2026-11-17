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
async function requirePupilLink(c,a,schoolId) {
 const student=await one(c,`SELECT s.id,s.grade_level FROM student_user_links l
  JOIN students s ON s.id=l.student_id AND s.district_id=l.district_id
  WHERE l.district_id=$1 AND l.user_id=$2 AND l.relationship='pupil' AND l.status='active' AND s.school_id=$3
  LIMIT 1`,[a.districtId,a.userId,schoolId]);
 if(!student)throw new HttpError(403,"active_student_link_required");
 return student;
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
   const grade=await requirePupilLink(c,a,activity.school_id);
   if(activity.grade_min!==null||activity.grade_max!==null){const g=Number(grade.grade_level);if(!Number.isFinite(g)||(activity.grade_min!==null&&g<activity.grade_min)||(activity.grade_max!==null&&g>activity.grade_max))throw new HttpError(403,"grade_eligibility_not_met");}
   const r=await one(c,`INSERT INTO activity_memberships(district_id,school_id,activity_id,user_id,status) VALUES($1,$2,$3,$4,'active')
    ON CONFLICT(district_id,activity_id,user_id) DO UPDATE SET status='active',joined_at=now() RETURNING id,status,joined_at`,[a.districtId,activity.school_id,activity.id,a.userId]);
   await audit(c,req,"join","activity_membership",r.id,`activity=${activity.id}`);return r;
  });res.status(201).json({data});}catch(e){sendError(res,next,e)}
 });
 app.get("/api/activities/:id/roster",requireSession,wrap(async(c,req)=>{
  const a=req.actor;if(!validId(req.params.id))throw new HttpError(400,"invalid_activity_id");
  const activity=await scopedActivity(c,a,req.params.id);if(!activity)throw new HttpError(404,"activity_not_found");
  if(!await canManage(c,a,activity.id))throw new HttpError(403,"roster_staff_access_required");
  if(activity.kind!=="sport")throw new HttpError(400,"roster_requires_sport_team");
  return rows(c,`SELECT r.id,r.student_id,r.jersey_number,r.position,r.status,s.display_name,s.grade_level
   FROM activity_roster_entries r JOIN students s ON s.id=r.student_id AND s.district_id=r.district_id
   WHERE r.district_id=$1 AND r.school_id=$2 AND r.activity_id=$3 ORDER BY r.status,s.display_name LIMIT 500`,
   [a.districtId,activity.school_id,activity.id]);
 }));
 app.post("/api/activities/:id/roster",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{};
  if(!validId(req.params.id)||!validId(b.studentId)||!(b.jerseyNumber===null||b.jerseyNumber===undefined||(Number.isInteger(b.jerseyNumber)&&b.jerseyNumber>=0&&b.jerseyNumber<=99))||!cleanText(b.position||"",80,0))
   return res.status(400).json({error:"invalid_roster_entry"});
  try{const data=await withTenantTransaction(a,async c=>{
   const activity=await requireActivityManager(c,a,req.params.id);
   if(activity.kind!=="sport")throw new HttpError(400,"roster_requires_sport_team");
   const student=await one(c,"SELECT id,grade_level FROM students WHERE id=$1 AND district_id=$2 AND school_id=$3",[b.studentId,a.districtId,activity.school_id]);
   if(!student)throw new HttpError(404,"student_not_found_in_school");
   if(activity.grade_min!==null||activity.grade_max!==null){
    const grade=Number(student.grade_level);if(!Number.isFinite(grade)||(activity.grade_min!==null&&grade<activity.grade_min)||(activity.grade_max!==null&&grade>activity.grade_max))throw new HttpError(403,"grade_eligibility_not_met");
   }
   const membership=await one(c,"SELECT id FROM activity_memberships WHERE district_id=$1 AND school_id=$2 AND activity_id=$3 AND user_id IN (SELECT user_id FROM student_user_links WHERE district_id=$1 AND student_id=$4 AND relationship='pupil' AND status='active') AND status='active' LIMIT 1",[a.districtId,activity.school_id,activity.id,b.studentId]);
   if(!membership)throw new HttpError(409,"student_activity_membership_required");
   const numberTaken=b.jerseyNumber==null?null:await one(c,"SELECT id FROM activity_roster_entries WHERE district_id=$1 AND activity_id=$2 AND jersey_number=$3 AND status='active' AND student_id<>$4",[a.districtId,activity.id,b.jerseyNumber,b.studentId]);
   if(numberTaken)throw new HttpError(409,"jersey_number_already_in_use");
   const r=await one(c,`INSERT INTO activity_roster_entries(district_id,school_id,activity_id,student_id,jersey_number,position,status,added_by)
    VALUES($1,$2,$3,$4,$5,$6,'active',$7)
    ON CONFLICT(district_id,activity_id,student_id) DO UPDATE SET jersey_number=EXCLUDED.jersey_number,position=EXCLUDED.position,status='active',added_by=EXCLUDED.added_by,updated_at=now()
    RETURNING id,student_id,jersey_number,position,status`,[a.districtId,activity.school_id,activity.id,b.studentId,b.jerseyNumber??null,(b.position||"").trim(),a.userId]);
   await audit(c,req,"roster_add","activity_roster_entry",r.id,`activity=${activity.id};student=${b.studentId}`);return r;
  });res.status(201).json({data});}catch(e){if(e?.code==="23505")return res.status(409).json({error:"jersey_number_already_in_use"});sendError(res,next,e)}
 });
 app.get("/api/activities/:id/results",requireSession,wrap(async(c,req)=>{
  const a=req.actor;if(!validId(req.params.id))throw new HttpError(400,"invalid_activity_id");
  const activity=await scopedActivity(c,a,req.params.id);if(!activity||activity.status!=="published")throw new HttpError(404,"activity_not_found");
  return rows(c,`SELECT r.id,r.event_id,r.opponent,r.home_score,r.away_score,r.summary,r.created_at,e.title AS event_title,e.starts_at
   FROM activity_event_results r JOIN school_events e ON e.id=r.event_id AND e.district_id=r.district_id
   WHERE r.district_id=$1 AND r.school_id=$2 AND r.activity_id=$3 AND r.status='published' ORDER BY e.starts_at DESC LIMIT 100`,
   [a.districtId,activity.school_id,activity.id]);
 }));
 app.post("/api/events/:id/result",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{};
  if(!validId(req.params.id)||!cleanText(b.opponent,120,1)||!Number.isInteger(b.homeScore)||b.homeScore<0||b.homeScore>999||!Number.isInteger(b.awayScore)||b.awayScore<0||b.awayScore>999||!cleanText(b.summary||"",1500,0))
   return res.status(400).json({error:"invalid_event_result"});
  try{const data=await withTenantTransaction(a,async c=>{
   const event=await one(c,"SELECT * FROM school_events WHERE id=$1 AND district_id=$2 AND ($3::uuid IS NULL OR school_id=$3) FOR UPDATE",[req.params.id,a.districtId,DISTRICT(a.role)?null:a.schoolId]);
   if(!event||!event.activity_id)throw new HttpError(404,"sport_event_not_found");
   const activity=await requireActivityManager(c,a,event.activity_id);
   if(activity.kind!=="sport")throw new HttpError(400,"result_requires_sport_event");
   if(event.ends_at>new Date())throw new HttpError(409,"event_not_completed");
   const existing=await one(c,"SELECT id,status FROM activity_event_results WHERE district_id=$1 AND event_id=$2 FOR UPDATE",[a.districtId,event.id]);
   if(existing?.status==="published"&&!LEAD(a.role))throw new HttpError(403,"published_result_requires_school_lead");
   const publish=LEAD(a.role)&&b.publish===true;
   const r=await one(c,`INSERT INTO activity_event_results(district_id,school_id,activity_id,event_id,opponent,home_score,away_score,summary,status,recorded_by,approved_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT(district_id,event_id) DO UPDATE SET opponent=EXCLUDED.opponent,home_score=EXCLUDED.home_score,away_score=EXCLUDED.away_score,summary=EXCLUDED.summary,status=EXCLUDED.status,recorded_by=EXCLUDED.recorded_by,approved_by=EXCLUDED.approved_by,updated_at=now()
    RETURNING id,event_id,opponent,home_score,away_score,summary,status`,
    [a.districtId,event.school_id,activity.id,event.id,b.opponent.trim(),b.homeScore,b.awayScore,(b.summary||"").trim(),publish?"published":"draft",a.userId,publish?a.userId:null]);
   await audit(c,req,publish?"publish_result":"record_result","activity_event_result",r.id,`event=${event.id};status=${r.status}`);return r;
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
  if(!validId(req.params.id)||!cleanText(b.name,80,2)||!Number.isInteger(b.capacity)||b.capacity<1||b.capacity>1000000||!Number.isInteger(b.priceCents??0)||(b.priceCents??0)<0||(b.priceCents??0)>1000000||typeof (b.currency||"USD")!=="string"||!(b.currency||"USD").match(/^[A-Z]{3}$/))return res.status(400).json({error:"invalid_ticket_type"});
  try{const data=await withTenantTransaction(a,async c=>{
   const event=await one(c,"SELECT * FROM school_events WHERE id=$1 AND district_id=$2 AND ($3::uuid IS NULL OR school_id=$3) FOR UPDATE",[req.params.id,a.districtId,DISTRICT(a.role)?null:a.schoolId]);if(!event)throw new HttpError(404,"event_not_found");
   const r=await one(c,`INSERT INTO event_ticket_types(district_id,school_id,event_id,name,price_cents,currency,capacity,sales_open)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,event_id,name,price_cents,currency,capacity,sold_count,sales_open`,[a.districtId,event.school_id,event.id,b.name.trim(),b.priceCents??0,b.currency||"USD",b.capacity,b.salesOpen===true]);
   await audit(c,req,"create","event_ticket_type",r.id,`event=${event.id};capacity=${r.capacity}`);return r;
  });res.status(201).json({data});}catch(e){sendError(res,next,e)}
 });
 app.post("/api/events/:id/tickets",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{},quantity=b.quantity===undefined?1:b.quantity,key=b.idempotencyKey;
  if(!["pupil","parent"].includes(a.role))return res.status(403).json({error:"ticket_buyer_role_required"});
  if(!validId(req.params.id)||!validId(b.ticketTypeId)||!Number.isInteger(quantity)||quantity<1||quantity>10||typeof key!=="string"||key.length<16||key.length>120)return res.status(400).json({error:"invalid_ticket_order"});
  try{const data=await withTenantTransaction(a,async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[a.districtId,a.userId+":"+key]);
   const prior=await one(c,`SELECT o.id,o.status,o.total_cents,o.currency,o.event_id,o.ticket_type_id,o.quantity,e.school_id
     FROM event_ticket_orders o JOIN school_events e ON e.id=o.event_id AND e.district_id=o.district_id
     WHERE o.district_id=$1 AND o.buyer_user_id=$2 AND o.idempotency_key=$3`,
     [a.districtId,a.userId,key]);
   if(prior){
    if(prior.event_id!==req.params.id)throw new HttpError(409,"idempotency_key_reused");
    if(prior.ticket_type_id!==b.ticketTypeId||Number(prior.quantity)!==quantity)
     throw new HttpError(409,"idempotency_key_payload_mismatch");
    if(a.role==="parent"){
     const linked=await one(c,`SELECT 1 FROM student_user_links l JOIN students s ON s.id=l.student_id AND s.district_id=l.district_id
       WHERE l.district_id=$1 AND l.user_id=$2 AND l.status='active' AND l.relationship IN ('parent','guardian') AND s.school_id=$3 LIMIT 1`,
       [a.districtId,a.userId,prior.school_id]);
     if(!linked)throw new HttpError(403,"guardian_school_link_required");
    }else{
     if(a.schoolId!==prior.school_id)throw new HttpError(403,"event_school_scope_denied");
     await requirePupilLink(c,a,prior.school_id);
    }
    const tickets=await rows(c,"SELECT id,status FROM event_tickets WHERE order_id=$1 FOR UPDATE",[prior.id]);
    const replayTickets=[];
    for(const ticket of tickets){
     if(ticket.status==="issued"&&["complimentary","paid"].includes(prior.status)){
      const code=randomBytes(24).toString("base64url"),hash=createHash("sha256").update(code).digest("hex");
      await c.query("UPDATE event_tickets SET ticket_code_hash=$2 WHERE id=$1",[ticket.id,hash]);
      replayTickets.push({id:ticket.id,status:ticket.status,code});
     }else replayTickets.push({id:ticket.id,status:ticket.status});
    }
    await audit(c,req,"rotate_codes","event_ticket_order",prior.id,"idempotent buyer recovery; previous unredeemed codes invalidated");
    return {order:{id:prior.id,status:prior.status,total_cents:prior.total_cents,currency:prior.currency},replayed:true,tickets:replayTickets};
   }
   const event=await one(c,"SELECT * FROM school_events WHERE id=$1 AND district_id=$2 AND status='published' AND starts_at>now()",[req.params.id,a.districtId]);
   if(!event)throw new HttpError(404,"event_not_available");
   if(a.role==="parent"){
    const linked=await one(c,`SELECT 1 FROM student_user_links l JOIN students s ON s.id=l.student_id AND s.district_id=l.district_id
      WHERE l.district_id=$1 AND l.user_id=$2 AND l.status='active' AND l.relationship IN ('parent','guardian') AND s.school_id=$3 LIMIT 1`,[a.districtId,a.userId,event.school_id]);
    if(!linked)throw new HttpError(403,"guardian_school_link_required");
   } else {
    if(a.schoolId!==event.school_id)throw new HttpError(403,"event_school_scope_denied");
    await requirePupilLink(c,a,event.school_id);
   }
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
 app.get("/api/my/tickets",requireSession,wrap(async(c,req)=>{
  const a=req.actor;if(!["pupil","parent"].includes(a.role))throw new HttpError(403,"ticket_buyer_role_required");
  return rows(c,`SELECT t.id,t.event_id,t.status,t.created_at,e.title AS event_title,e.starts_at,e.ends_at,e.venue,o.quantity,o.total_cents,o.currency,o.status AS order_status
   FROM event_tickets t JOIN event_ticket_orders o ON o.id=t.order_id AND o.district_id=t.district_id
   JOIN school_events e ON e.id=t.event_id AND e.district_id=t.district_id
   WHERE t.district_id=$1 AND o.buyer_user_id=$2 ORDER BY e.starts_at DESC LIMIT 200`,[a.districtId,a.userId]);
 }));
 app.post("/api/events/:id/check-in",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,code=req.body?.ticketCode;
  if(!LEAD(a.role)&&a.role!=="teacher")return res.status(403).json({error:"event_checkin_staff_required"});
  if(!validId(req.params.id)||typeof code!=="string"||code.length<20||code.length>128)return res.status(400).json({error:"invalid_ticket_checkin"});
  try{const data=await withTenantTransaction(a,async c=>{
   const event=await one(c,"SELECT id,school_id,activity_id FROM school_events WHERE id=$1 AND district_id=$2 AND ($3::uuid IS NULL OR school_id=$3)",[req.params.id,a.districtId,DISTRICT(a.role)?null:a.schoolId]);
   if(!event)throw new HttpError(404,"event_not_found");
   if(a.role==="teacher"&&(!event.activity_id||!await one(c,"SELECT id FROM activity_staff WHERE district_id=$1 AND school_id=$2 AND activity_id=$3 AND user_id=$4",[a.districtId,event.school_id,event.activity_id,a.userId])))throw new HttpError(403,"event_assignment_required");
   const hash=createHash("sha256").update(code).digest("hex");
   const ticket=await one(c,"SELECT id,status,order_id FROM event_tickets WHERE district_id=$1 AND event_id=$2 AND ticket_code_hash=$3 FOR UPDATE",[a.districtId,event.id,hash]);
   if(!ticket)throw new HttpError(404,"ticket_not_found");
   if(ticket.status!=="issued")throw new HttpError(409,"ticket_not_checkin_eligible",{status:ticket.status});
   const order=await one(c,"SELECT status FROM event_ticket_orders WHERE id=$1 AND district_id=$2",[ticket.order_id,a.districtId]);
   if(!order||!["complimentary","paid"].includes(order.status))throw new HttpError(409,"ticket_order_not_paid_or_complimentary");
   const updated=await one(c,"UPDATE event_tickets SET status='checked_in',checked_in_at=now(),checked_in_by=$2 WHERE id=$1 RETURNING id,status,checked_in_at",[ticket.id,a.userId]);
   await audit(c,req,"check_in","event_ticket",ticket.id,`event=${event.id}`);return updated;
  });res.json({data});}catch(e){sendError(res,next,e)}
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
  if(!["superintendent","it_admin","principal","teacher","parent","pupil"].includes(a.role))
   throw new HttpError(403,"stream_schedule_access_forbidden");
  const r=await one(c,`SELECT s.id,s.event_id,s.school_id,s.status,s.audience,s.starts_at,s.ends_at,s.recording_allowed,s.provider
   FROM event_streams s JOIN school_events e ON e.id=s.event_id AND e.district_id=s.district_id
   WHERE s.event_id=$1 AND s.district_id=$2 AND (s.school_id=$3 OR $4) AND e.status='published'
   ORDER BY s.created_at DESC LIMIT 1`,
   [req.params.id,a.districtId,a.schoolId,DISTRICT(a.role)]);
  if(!r)return null;
  if(r.audience==="district"&&!DISTRICT(a.role))throw new HttpError(403,"district_stream_audience_required");
  if(r.audience==="ticket_holders"){
   const ticket=await one(c,`SELECT 1 FROM event_ticket_orders o JOIN event_tickets t
     ON t.order_id=o.id AND t.district_id=o.district_id
     WHERE o.district_id=$1 AND o.event_id=$2 AND o.buyer_user_id=$3
       AND o.status IN ('complimentary','paid') AND t.status IN ('issued','checked_in') LIMIT 1`,
     [a.districtId,r.event_id,a.userId]);
   if(!ticket)throw new HttpError(403,"stream_ticket_holder_required");
  }
  return {...r,playbackEnabled:false,reason:"stream_provider_not_connected"};
 }));
 // 37.8.0 media governance. Storage is deliberately not exposed by these APIs.
 app.get("/api/activities/:id/media",requireSession,wrap(async(c,req)=>{
  const a=req.actor;if(!validId(req.params.id))throw new HttpError(400,"invalid_activity_id");
  const activity=await scopedActivity(c,a,req.params.id);if(!activity)throw new HttpError(404,"activity_not_found");
  if(!LEAD(a.role)&&!await canManage(c,a,activity.id))throw new HttpError(403,"media_staff_access_required");
  return rows(c,`SELECT m.id,m.activity_id,m.event_id,m.media_kind,m.mime_type,m.byte_size,m.consent_status,m.moderation_status,m.created_at,
    (SELECT count(*)::int FROM activity_media_participants p WHERE p.media_asset_id=m.id) AS participant_count,
    (SELECT count(*)::int FROM activity_media_participants p WHERE p.media_asset_id=m.id AND p.consent_status='approved') AS consented_count
   FROM activity_media_assets m WHERE m.district_id=$1 AND m.school_id=$2 AND m.activity_id=$3 ORDER BY m.created_at DESC LIMIT 200`,
   [a.districtId,activity.school_id,activity.id]);
 }));
 app.post("/api/media/:id/participants",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{};
  if(!validId(req.params.id)||!Array.isArray(b.studentIds)||b.studentIds.length<1||b.studentIds.length>100||!b.studentIds.every(validId)||new Set(b.studentIds).size!==b.studentIds.length)return res.status(400).json({error:"invalid_media_participants"});
  try{const data=await withTenantTransaction(a,async c=>{
   const asset=await one(c,"SELECT * FROM activity_media_assets WHERE id=$1 AND district_id=$2 FOR UPDATE",[req.params.id,a.districtId]);
   if(!asset)throw new HttpError(404,"media_asset_not_found");
   if(!asset.activity_id)throw new HttpError(409,"media_activity_required");
   const activity=await requireActivityManager(c,a,asset.activity_id);
   if(asset.school_id!==activity.school_id)throw new HttpError(403,"media_school_scope_denied");
   if(asset.moderation_status!=="pending")throw new HttpError(409,"media_moderation_already_decided");
   const students=await rows(c,"SELECT id FROM students WHERE district_id=$1 AND school_id=$2 AND id=ANY($3::uuid[])",[a.districtId,asset.school_id,b.studentIds]);
   if(students.length!==b.studentIds.length)throw new HttpError(400,"participant_outside_media_school");
   for(const studentId of b.studentIds)await c.query(`INSERT INTO activity_media_participants(district_id,school_id,media_asset_id,student_id,added_by)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(district_id,media_asset_id,student_id) DO NOTHING`,[a.districtId,asset.school_id,asset.id,studentId,a.userId]);
   await audit(c,req,"register_participants","activity_media_asset",asset.id,`participants=${b.studentIds.length}`);
   return {mediaAssetId:asset.id,participantCount:(await one(c,"SELECT count(*)::int AS n FROM activity_media_participants WHERE media_asset_id=$1",[asset.id])).n,consentStatus:"pending"};
  });res.status(201).json({data});}catch(e){sendError(res,next,e)}
 });
 app.post("/api/media/:id/consent",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{};
  const action=b.action||(typeof b.granted==="boolean"?(b.granted?"grant":"deny"):null);
  if(a.role!=="parent"||!validId(req.params.id)||!validId(b.studentId)||!["grant","deny","withdraw"].includes(action))return res.status(400).json({error:"invalid_guardian_media_consent"});
  try{const data=await withTenantTransaction(a,async c=>{
   const asset=await one(c,"SELECT id,district_id,school_id,activity_id,moderation_status FROM activity_media_assets WHERE id=$1 AND district_id=$2 FOR UPDATE",[req.params.id,a.districtId]);
   if(!asset)throw new HttpError(404,"media_asset_not_found");
   const linked=await one(c,`SELECT 1 FROM student_user_links l JOIN students s ON s.id=l.student_id AND s.district_id=l.district_id
    WHERE l.district_id=$1 AND l.student_id=$2 AND l.user_id=$3 AND l.relationship IN ('parent','guardian') AND l.status='active' AND s.school_id=$4`,
    [a.districtId,b.studentId,a.userId,asset.school_id]);
   if(!linked)throw new HttpError(403,"active_guardian_link_required");
   const participant=await one(c,"SELECT id FROM activity_media_participants WHERE district_id=$1 AND media_asset_id=$2 AND student_id=$3 FOR UPDATE",[a.districtId,asset.id,b.studentId]);
   if(!participant)throw new HttpError(404,"media_participant_not_registered");
   if(action==="withdraw"){
    const prior=await one(c,`SELECT id,status FROM activity_media_consents
      WHERE district_id=$1 AND media_asset_id=$2 AND student_id=$3 AND guardian_user_id=$4 FOR UPDATE`,
      [a.districtId,asset.id,b.studentId,a.userId]);
    if(!prior||prior.status!=="approved")throw new HttpError(409,"approved_consent_required_for_withdrawal");
    await c.query(`UPDATE activity_media_consents SET status='withdrawn',decided_at=now()
      WHERE district_id=$1 AND media_asset_id=$2 AND student_id=$3 AND guardian_user_id=$4`,
      [a.districtId,asset.id,b.studentId,a.userId]);
   }else{
    await c.query(`INSERT INTO activity_media_consents(district_id,school_id,media_asset_id,student_id,guardian_user_id,status,decided_at)
     VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(district_id,media_asset_id,student_id,guardian_user_id)
     DO UPDATE SET status=EXCLUDED.status,decided_at=now()`,
     [a.districtId,asset.school_id,asset.id,b.studentId,a.userId,action==="grant"?"approved":"denied"]);
   }
   await c.query(`INSERT INTO activity_media_consent_history
    (district_id,school_id,media_asset_id,student_id,guardian_user_id,decision)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [a.districtId,asset.school_id,asset.id,b.studentId,a.userId,action==="grant"?"approved":action==="deny"?"denied":"withdrawn"]);
   const guardianDecision=await one(c,`SELECT count(*) FILTER(WHERE status='approved')::int AS approvals,
     count(*) FILTER(WHERE status IN ('denied','withdrawn'))::int AS denials FROM activity_media_consents
     WHERE district_id=$1 AND media_asset_id=$2 AND student_id=$3`,[a.districtId,asset.id,b.studentId]);
   const participantStatus=Number(guardianDecision.denials)>0?"denied":Number(guardianDecision.approvals)>0?"approved":"pending";
   await c.query("UPDATE activity_media_participants SET consent_status=$3 WHERE district_id=$1 AND media_asset_id=$2 AND student_id=$4",[a.districtId,asset.id,participantStatus,b.studentId]);
   const aggregate=await one(c,`SELECT count(*)::int AS total,count(*) FILTER(WHERE consent_status='approved')::int AS approved,
      count(*) FILTER(WHERE consent_status='denied')::int AS denied FROM activity_media_participants WHERE district_id=$1 AND media_asset_id=$2`,[a.districtId,asset.id]);
   const withdrawn=await one(c,`SELECT count(*)::int AS n FROM activity_media_consents
     WHERE district_id=$1 AND media_asset_id=$2 AND status='withdrawn'`,[a.districtId,asset.id]);
   const overall=Number(withdrawn.n)>0?"withdrawn":Number(aggregate.denied)>0?"denied":Number(aggregate.total)>0&&Number(aggregate.total)===Number(aggregate.approved)?"approved":"pending";
   await c.query("UPDATE activity_media_assets SET consent_status=$3 WHERE district_id=$1 AND id=$2",[a.districtId,asset.id,overall]);
   await audit(c,req,action==="grant"?"grant_media_consent":action==="deny"?"deny_media_consent":"withdraw_media_consent","activity_media_asset",asset.id,`student=${b.studentId};decision=${action}`);
   return {mediaAssetId:asset.id,studentId:b.studentId,consentStatus:overall};
  });res.json({data});}catch(e){sendError(res,next,e)}
 });
 app.patch("/api/media/:id/moderation",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor,b=req.body||{};
  if(!LEAD(a.role))return res.status(403).json({error:"school_lead_required"});
  if(!validId(req.params.id)||!["approved","rejected"].includes(b.status))return res.status(400).json({error:"invalid_media_moderation"});
  try{const data=await withTenantTransaction(a,async c=>{
   const asset=await one(c,"SELECT * FROM activity_media_assets WHERE id=$1 AND district_id=$2 AND ($3::uuid IS NULL OR school_id=$3) FOR UPDATE",[req.params.id,a.districtId,DISTRICT(a.role)?null:a.schoolId]);
   if(!asset)throw new HttpError(404,"media_asset_not_found");
   const participants=await one(c,`SELECT count(*)::int AS total,count(*) FILTER(WHERE consent_status='approved')::int AS approved
     FROM activity_media_participants WHERE district_id=$1 AND media_asset_id=$2`,[a.districtId,asset.id]);
   if(b.status==="approved"&&(Number(participants.total)===0||Number(participants.total)!==Number(participants.approved)||asset.consent_status!=="approved"))
    throw new HttpError(409,"all_guardian_consents_required");
   const updated=await one(c,"UPDATE activity_media_assets SET moderation_status=$2,approved_by=$3 WHERE id=$1 RETURNING id,moderation_status,consent_status,approved_by",[asset.id,b.status,a.userId]);
   await audit(c,req,b.status==="approved"?"approve_media":"reject_media","activity_media_asset",asset.id,`consent=${asset.consent_status}`);
   return {...updated,publicationEnabled:false,reason:"private_storage_and_publication_adapter_not_configured"};
  });res.json({data});}catch(e){sendError(res,next,e)}
 });

}
