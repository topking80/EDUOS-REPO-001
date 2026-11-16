import { createHash } from "node:crypto";
// 35.8.0: auditable school library circulation, returns and holds.
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
const STAFF = ["superintendent", "it_admin", "principal", "teacher", "librarian"];
const MANAGERS = ["superintendent", "it_admin", "principal", "librarian"];
const wrap = fn => async (req,res,next) => { try { const data=await withTenantTransaction(req.actor,c=>fn(c,req)); res.setHeader("Cache-Control","no-store"); res.json({data}); } catch(e) { sendError(res,next,e); } };
const districtWide = role => ["superintendent","it_admin"].includes(role);
export function registerLibraryCirculationRoutes(app) {
 app.post("/api/library/borrower-cards",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor;if(!MANAGERS.includes(a.role))return res.status(403).json({error:"library_manager_required"});
  const {borrowerUserId,barcode}=req.body||{};if(!validId(borrowerUserId)||typeof barcode!=="string"||barcode.trim().length<3||barcode.trim().length>120)return res.status(400).json({error:"invalid_borrower_card"});
  try{const data=await withTenantTransaction(a,async c=>{const member=await one(c,"SELECT m.school_id,m.role,u.display_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.district_id=$2 AND m.status='active' AND u.status='active'",[borrowerUserId,a.districtId]);if(!member||member.role!=="pupil")throw new HttpError(400,"active_student_membership_required");if(member.school_id!==a.schoolId && !districtWide(a.role))throw new HttpError(403,"school_scope_denied");const schoolId=member.school_id;const hash=createHash("sha256").update(barcode.trim()).digest("hex");await c.query(`INSERT INTO library_borrower_cards(district_id,school_id,user_id,card_hash,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(district_id,school_id,user_id) DO UPDATE SET card_hash=EXCLUDED.card_hash,created_by=EXCLUDED.created_by,created_at=now()`,[a.districtId,schoolId,borrowerUserId,hash,a.userId]);await audit(c,req,"create","library_borrower_card",borrowerUserId,"student card linked");return {borrowerUserId,schoolId,displayName:member.display_name};});res.status(201).json({data});}catch(e){sendError(res,next,e)}
 });
 app.post("/api/library/borrower-cards/lookup",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor;if(!MANAGERS.includes(a.role))return res.status(403).json({error:"library_manager_required"});const barcode=req.body?.barcode;if(typeof barcode!=="string"||barcode.trim().length<3||barcode.trim().length>120)return res.status(400).json({error:"invalid_borrower_card"});
  try{const data=await withTenantTransaction(a,async c=>{const hash=createHash("sha256").update(barcode.trim()).digest("hex");const member=await one(c,`SELECT m.user_id AS "borrowerUserId",m.school_id,u.display_name AS "displayName" FROM library_borrower_cards b JOIN memberships m ON m.user_id=b.user_id AND m.district_id=b.district_id AND m.school_id=b.school_id JOIN users u ON u.id=m.user_id WHERE b.district_id=$1 AND b.school_id=$2 AND b.card_hash=$3 AND m.status='active' AND u.status='active' AND m.role='pupil'`,[a.districtId,a.schoolId,hash]);if(!member)throw new HttpError(404,"student_card_not_found");await audit(c,req,"read","library_borrower_card",member.borrowerUserId,"student card lookup");return member;});res.json({data});}catch(e){sendError(res,next,e)}
 });
 app.get("/api/library/loans",requireSession,wrap(async(c,req)=>{
  const a=req.actor;if(!STAFF.includes(a.role))throw new HttpError(403,"library_access_forbidden");
  const schoolFilter=districtWide(a.role)?"$2::uuid IS NULL":"l.school_id=$2";
  return rows(c,`SELECT l.id,l.school_id,l.item_id,i.title,i.isbn,i.barcode,l.borrower_user_id,l.checked_out_at,l.due_at,l.returned_at,l.status,(l.returned_at IS NULL AND l.due_at<now()) AS overdue FROM library_loans l JOIN library_items i ON i.id=l.item_id AND i.district_id=l.district_id WHERE l.district_id=$1 AND ${schoolFilter} ORDER BY l.returned_at NULLS FIRST,l.due_at LIMIT 1000`,[a.districtId,a.schoolId||null]);
 }));
 app.post("/api/library/loans/checkout",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor;if(!MANAGERS.includes(a.role))return res.status(403).json({error:"library_manager_required"});
  const {itemId,borrowerUserId,dueAt}=req.body||{};if(!validId(itemId)||!validId(borrowerUserId)||!dueAt||!Number.isFinite(Date.parse(dueAt))||Date.parse(dueAt)<=Date.now()||Date.parse(dueAt)>Date.now()+366*86400000)return res.status(400).json({error:"invalid_checkout"});
  try{const data=await withTenantTransaction(a,async c=>{
   const item=await one(c,"SELECT * FROM library_items WHERE id=$1 AND district_id=$2 FOR UPDATE",[itemId,a.districtId]);if(!item)throw new HttpError(404,"library_item_not_found");
   if(!districtWide(a.role)&&item.school_id!==a.schoolId)throw new HttpError(403,"school_scope_denied");
   const borrower=await one(c,"SELECT m.user_id AS id,m.school_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.district_id=$2 AND m.status='active' AND u.status='active'",[borrowerUserId,a.districtId]);if(!borrower)throw new HttpError(400,"borrower_not_active_in_district");
   if(borrower.school_id && borrower.school_id!==item.school_id)throw new HttpError(400,"borrower_school_mismatch");
   if(item.available_count<1)throw new HttpError(409,"no_available_copies");
   const active=await one(c,"SELECT id FROM library_loans WHERE district_id=$1 AND school_id=$2 AND item_id=$3 AND borrower_user_id=$4 AND returned_at IS NULL",[a.districtId,item.school_id,item.id,borrowerUserId]);if(active)throw new HttpError(409,"borrower_already_has_this_title");
   const loan=await one(c,"INSERT INTO library_loans(district_id,school_id,item_id,borrower_user_id,checked_out_by,due_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[a.districtId,item.school_id,item.id,borrowerUserId,a.userId,new Date(dueAt).toISOString()]);
   await c.query("UPDATE library_items SET available_count=available_count-1,updated_at=now() WHERE id=$1",[item.id]);await audit(c,req,"create","library_loan",loan.id,`item=${item.id}; borrower=${borrowerUserId}`);return loan;
  });res.status(201).json({data});}catch(e){sendError(res,next,e)}
 });
 app.post("/api/library/loans/:id/return",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor;if(!MANAGERS.includes(a.role))return res.status(403).json({error:"library_manager_required"});if(!validId(req.params.id))return res.status(400).json({error:"invalid_loan_id"});
  try{const data=await withTenantTransaction(a,async c=>{
   const loan=await one(c,"SELECT * FROM library_loans WHERE id=$1 AND district_id=$2 FOR UPDATE",[req.params.id,a.districtId]);if(!loan)throw new HttpError(404,"loan_not_found");if(!districtWide(a.role)&&loan.school_id!==a.schoolId)throw new HttpError(403,"school_scope_denied");if(loan.returned_at)throw new HttpError(409,"loan_already_returned");
   const disposition=req.body?.disposition||"returned";if(!["returned","damaged","lost"].includes(disposition))throw new HttpError(400,"invalid_return_disposition");
   const updated=await one(c,"UPDATE library_loans SET returned_at=now(),returned_to=$2,status=$3 WHERE id=$1 RETURNING *",[loan.id,a.userId,disposition]);
   if(disposition==="returned")await c.query("UPDATE library_items SET available_count=LEAST(copy_count,available_count+1),updated_at=now() WHERE id=$1",[loan.item_id]);
   await audit(c,req,"update","library_loan",loan.id,`disposition=${disposition}`);return updated;
  });res.json({data});}catch(e){sendError(res,next,e)}
 });
 app.post("/api/library/reservations",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor;if(!STAFF.includes(a.role))return res.status(403).json({error:"library_access_forbidden"});const {itemId,borrowerUserId}=req.body||{};if(!validId(itemId)||!validId(borrowerUserId))return res.status(400).json({error:"invalid_reservation"});
  try{const data=await withTenantTransaction(a,async c=>{
   const item=await one(c,"SELECT * FROM library_items WHERE id=$1 AND district_id=$2",[itemId,a.districtId]);if(!item)throw new HttpError(404,"library_item_not_found");if(!districtWide(a.role)&&item.school_id!==a.schoolId)throw new HttpError(403,"school_scope_denied");
   const borrower=await one(c,"SELECT m.user_id AS id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.district_id=$2 AND m.status='active' AND u.status='active'",[borrowerUserId,a.districtId]);if(!borrower)throw new HttpError(400,"borrower_not_active_in_district");
   const existing=await one(c,"SELECT id FROM library_reservations WHERE district_id=$1 AND item_id=$2 AND borrower_user_id=$3 AND status IN ('queued','ready')",[a.districtId,itemId,borrowerUserId]);if(existing)throw new HttpError(409,"reservation_already_exists");
   const reservation=await one(c,"INSERT INTO library_reservations(district_id,school_id,item_id,borrower_user_id) VALUES($1,$2,$3,$4) RETURNING *",[a.districtId,item.school_id,itemId,borrowerUserId]);await audit(c,req,"create","library_reservation",reservation.id,`item=${itemId}; borrower=${borrowerUserId}`);return reservation;
  });res.status(201).json({data});}catch(e){sendError(res,next,e)}
 });
 app.get("/api/library/my-loans",requireSession,wrap(async(c,req)=>{
  const a=req.actor;if(a.role!=="pupil")throw new HttpError(403,"student_library_access_only");
  return rows(c,`SELECT l.id,i.title,i.creator,i.isbn,l.checked_out_at,l.due_at,l.returned_at,l.status,l.renewal_count,(l.returned_at IS NULL AND l.due_at<now()) AS overdue FROM library_loans l JOIN library_items i ON i.id=l.item_id AND i.district_id=l.district_id WHERE l.district_id=$1 AND l.borrower_user_id=$2 ORDER BY l.checked_out_at DESC LIMIT 200`,[a.districtId,a.userId]);
 }));
 app.get("/api/library/family-loans",requireSession,wrap(async(c,req)=>{
  const a=req.actor;if(a.role!=="parent")throw new HttpError(403,"family_library_access_only");
  return rows(c,`SELECT DISTINCT s.id AS student_id,u.display_name AS student_name,l.id AS loan_id,i.title,i.creator,l.checked_out_at,l.due_at,l.returned_at,l.status,(l.returned_at IS NULL AND l.due_at<now()) AS overdue FROM student_user_links link JOIN students s ON s.id=link.student_id AND s.district_id=link.district_id JOIN memberships pm ON pm.user_id=link.user_id AND pm.district_id=link.district_id JOIN student_user_links pupil_link ON pupil_link.student_id=s.id AND pupil_link.district_id=s.district_id AND pupil_link.relationship='pupil' AND pupil_link.status='active' JOIN memberships sm ON sm.user_id=pupil_link.user_id AND sm.district_id=s.district_id AND sm.school_id=s.school_id AND sm.role='pupil' AND sm.status='active' JOIN users u ON u.id=sm.user_id JOIN library_loans l ON l.borrower_user_id=sm.user_id AND l.district_id=s.district_id JOIN library_items i ON i.id=l.item_id AND i.district_id=l.district_id WHERE link.district_id=$1 AND link.user_id=$2 AND link.status='active' AND link.relationship IN ('parent','guardian') AND pm.role='parent' AND pm.status='active' ORDER BY l.checked_out_at DESC LIMIT 300`,[a.districtId,a.userId]);
 }));
 app.post("/api/library/loans/:id/renew",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor;if(![...MANAGERS,"pupil"].includes(a.role))return res.status(403).json({error:"library_renewal_forbidden"});if(!validId(req.params.id))return res.status(400).json({error:"invalid_loan_id"});
  try{const data=await withTenantTransaction(a,async c=>{
   const loan=await one(c,"SELECT * FROM library_loans WHERE id=$1 AND district_id=$2 FOR UPDATE",[req.params.id,a.districtId]);if(!loan)throw new HttpError(404,"loan_not_found");
   if(a.role==="pupil"&&loan.borrower_user_id!==a.userId)throw new HttpError(403,"loan_owner_only");
   if(a.role!=="pupil"&&!districtWide(a.role)&&loan.school_id!==a.schoolId)throw new HttpError(403,"school_scope_denied");
   if(loan.returned_at||loan.status!=="checked_out")throw new HttpError(409,"loan_not_renewable");
   if(new Date(loan.due_at)<new Date())throw new HttpError(409,"overdue_loan_requires_librarian");
   const policy=await one(c,"SELECT max_renewals,renewal_days FROM library_borrowing_policies WHERE district_id=$1 AND school_id=$2",[a.districtId,loan.school_id]);if(loan.renewal_count>=(policy?.max_renewals??2))throw new HttpError(409,"renewal_limit_reached");
   const hold=await one(c,"SELECT id FROM library_reservations WHERE district_id=$1 AND item_id=$2 AND status IN ('queued','ready') LIMIT 1",[a.districtId,loan.item_id]);if(hold)throw new HttpError(409,"item_has_waiting_reservation");
   const dueAt=new Date(new Date(loan.due_at).getTime()+(policy?.renewal_days??14)*86400000);
   const updated=await one(c,"UPDATE library_loans SET due_at=$2,renewal_count=renewal_count+1,last_renewed_at=now() WHERE id=$1 RETURNING id,due_at,renewal_count",[loan.id,dueAt.toISOString()]);
   await audit(c,req,"update","library_loan",loan.id,`renewal_count=${updated.renewal_count}`);return updated;
  });res.json({data});}catch(e){sendError(res,next,e)}
 });
 app.get("/api/library/overdue",requireSession,wrap(async(c,req)=>{
  const a=req.actor;if(!STAFF.includes(a.role))throw new HttpError(403,"library_access_forbidden");const scope=districtWide(a.role)?"$2::uuid IS NULL":"l.school_id=$2";
  return rows(c,`SELECT l.id,l.school_id,i.title,i.isbn,i.barcode,l.borrower_user_id,l.due_at,now()-l.due_at AS overdue_by FROM library_loans l JOIN library_items i ON i.id=l.item_id AND i.district_id=l.district_id WHERE l.district_id=$1 AND ${scope} AND l.returned_at IS NULL AND l.due_at<now() ORDER BY l.due_at LIMIT 1000`,[a.districtId,a.schoolId||null]);
 }));
 app.get("/api/library/policy",requireSession,wrap(async(c,req)=>{
  const a=req.actor;if(!STAFF.includes(a.role))throw new HttpError(403,"library_access_forbidden");
  const schoolId=a.schoolId||req.query.schoolId;if(!schoolId)throw new HttpError(400,"school_id_required");
  if(!districtWide(a.role)&&schoolId!==a.schoolId)throw new HttpError(403,"school_scope_denied");
  const policy=await one(c,"SELECT school_id,loan_days,max_renewals,renewal_days,overdue_grace_days,updated_at FROM library_borrowing_policies WHERE district_id=$1 AND school_id=$2",[a.districtId,schoolId]);
  return policy||{school_id:schoolId,loan_days:14,max_renewals:2,renewal_days:14,overdue_grace_days:0,defaults:true};
 }));
 app.put("/api/library/policy",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor;if(!MANAGERS.includes(a.role))return res.status(403).json({error:"library_manager_required"});
  const b=req.body||{},schoolId=b.schoolId||a.schoolId;
  const vals=[b.loanDays??14,b.maxRenewals??2,b.renewalDays??14,b.overdueGraceDays??0];
  if(!schoolId||vals.some((v,i)=>!Number.isInteger(v)||v<(i===1?0:1)||v>([120,10,120,60][i])))return res.status(400).json({error:"invalid_library_policy"});
  try{const data=await withTenantTransaction(a,async c=>{
   if(!districtWide(a.role)&&schoolId!==a.schoolId)throw new HttpError(403,"school_scope_denied");
   const school=await one(c,"SELECT id FROM schools WHERE id=$1 AND district_id=$2",[schoolId,a.districtId]);if(!school)throw new HttpError(400,"school_outside_district");
   const saved=await one(c,`INSERT INTO library_borrowing_policies(district_id,school_id,loan_days,max_renewals,renewal_days,overdue_grace_days,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(district_id,school_id) DO UPDATE SET loan_days=EXCLUDED.loan_days,max_renewals=EXCLUDED.max_renewals,renewal_days=EXCLUDED.renewal_days,overdue_grace_days=EXCLUDED.overdue_grace_days,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING school_id,loan_days,max_renewals,renewal_days,overdue_grace_days,updated_at`,[a.districtId,schoolId,...vals,a.userId]);await audit(c,req,"update","library_borrowing_policy",schoolId,JSON.stringify(saved));return saved;
  });res.json({data});}catch(e){sendError(res,next,e)}
 });
 app.post("/api/library/notices/prepare-overdue",requireSession,requireCsrf,async(req,res,next)=>{
  const a=req.actor;if(!MANAGERS.includes(a.role))return res.status(403).json({error:"library_manager_required"});
  try{const data=await withTenantTransaction(a,async c=>{
   const schoolId=req.body?.schoolId||a.schoolId;if(!schoolId)throw new HttpError(400,"school_id_required");if(!districtWide(a.role)&&schoolId!==a.schoolId)throw new HttpError(403,"school_scope_denied");
   const school=await one(c,"SELECT id FROM schools WHERE id=$1 AND district_id=$2",[schoolId,a.districtId]);if(!school)throw new HttpError(400,"school_outside_district");
   const result=await rows(c,`INSERT INTO library_notice_ledger(district_id,school_id,loan_id,borrower_user_id,notice_type,channel)
    SELECT l.district_id,l.school_id,l.id,l.borrower_user_id,'overdue_digest','in_app' FROM library_loans l
    LEFT JOIN library_borrowing_policies p ON p.district_id=l.district_id AND p.school_id=l.school_id
    WHERE l.district_id=$1 AND l.school_id=$2 AND l.returned_at IS NULL AND l.due_at < now()-make_interval(days=>coalesce(p.overdue_grace_days,0))
    ON CONFLICT(loan_id,notice_type,notice_date,channel) DO NOTHING RETURNING id`,[a.districtId,schoolId]);
   await audit(c,req,"create","library_overdue_notice_batch",schoolId,`queued=${result.length}; channel=in_app`);return {queued:result.length,channel:"in_app",externalDeliveryEnabled:false};
  });res.status(201).json({data});}catch(e){sendError(res,next,e)}
 });
 app.get("/api/library/notices",requireSession,wrap(async(c,req)=>{
  const a=req.actor;if(!STAFF.includes(a.role))throw new HttpError(403,"library_access_forbidden");const schoolId=a.schoolId||req.query.schoolId;if(!schoolId)throw new HttpError(400,"school_id_required");if(!districtWide(a.role)&&schoolId!==a.schoolId)throw new HttpError(403,"school_scope_denied");
  return rows(c,`SELECT n.id,n.loan_id,n.borrower_user_id,n.notice_type,n.notice_date,n.channel,n.status,n.created_at,i.title,l.due_at FROM library_notice_ledger n JOIN library_loans l ON l.id=n.loan_id JOIN library_items i ON i.id=l.item_id WHERE n.district_id=$1 AND n.school_id=$2 ORDER BY n.created_at DESC LIMIT 500`,[a.districtId,schoolId]);
 }));

}
