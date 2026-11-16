// 36.3.0 district library intelligence: read-only analytics and explainable recommendations.
import { requireSession } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, HttpError, sendError } from "./role-app-util.js";
const ALLOWED=["superintendent","it_admin","principal","librarian"];
const wrap=fn=>async(req,res,next)=>{try{const data=await withTenantTransaction(req.actor,c=>fn(c,req));res.setHeader("Cache-Control","no-store");res.json({data});}catch(e){sendError(res,next,e)}};
function districtWide(a){return ["superintendent","it_admin"].includes(a.role)}
export function registerLibraryIntelligenceRoutes(app){
 app.get("/api/library/intelligence/overview",requireSession,wrap(async(c,req)=>{
  const a=req.actor;if(!ALLOWED.includes(a.role))throw new HttpError(403,"library_access_forbidden");
  const scope=districtWide(a)?"$2::uuid IS NULL":"school_id=$2",args=[a.districtId,a.schoolId||null];
  const totals=await one(c,`SELECT count(*)::int AS title_records,coalesce(sum(copy_count),0)::int AS physical_copies,coalesce(sum(available_count),0)::int AS available_copies,coalesce(sum(copy_count-available_count),0)::int AS unavailable_copies,count(*) FILTER(WHERE available_count=0)::int AS out_of_stock_titles,count(*) FILTER(WHERE copy_count-available_count>=copy_count*.5)::int AS high_demand_titles FROM library_items WHERE district_id=$1 AND ${scope}`,args);
  const overdue=await one(c,`SELECT count(*)::int AS overdue_loans FROM library_loans WHERE district_id=$1 AND ${scope} AND returned_at IS NULL AND due_at<now()`,args);
  const losses=await one(c,`SELECT count(*)::int AS lost_loans FROM library_loans WHERE district_id=$1 AND ${scope} AND status='lost'`,args);
  const schools=await rows(c,`SELECT s.id,s.name,count(i.id)::int AS title_records,coalesce(sum(i.copy_count),0)::int AS copies,coalesce(sum(i.available_count),0)::int AS available_copies FROM schools s LEFT JOIN library_items i ON i.school_id=s.id AND i.district_id=s.district_id WHERE s.district_id=$1 AND ($2::uuid IS NULL OR s.id=$2) GROUP BY s.id,s.name ORDER BY s.name`,args);
  await audit(c,req,"read","library_intelligence",null,"overview");
  return {totals,overdue,losses,schools};
 }));
 app.get("/api/library/intelligence/recommendations",requireSession,wrap(async(c,req)=>{
  const a=req.actor;if(!ALLOWED.includes(a.role))throw new HttpError(403,"library_access_forbidden");
  const scope=districtWide(a)?"$2::uuid IS NULL":"i.school_id=$2",args=[a.districtId,a.schoolId||null];
  // ISBN matching is deliberately exact and only recommends review; it never transfers stock.
  // A school sees titles it has run out of that another school has spare
  // (b is the school short of copies). District roles see every pair.
  const matches=await rows(c,`SELECT a.isbn,a.title,a.creator,sa.id AS from_school_id,sa.name AS from_school, a.available_count AS available_copies,sb.id AS to_school_id,sb.name AS to_school,b.copy_count AS destination_copies FROM library_items a JOIN library_items b ON b.district_id=a.district_id AND b.isbn=a.isbn AND b.school_id<>a.school_id JOIN schools sa ON sa.id=a.school_id AND sa.district_id=a.district_id JOIN schools sb ON sb.id=b.school_id AND sb.district_id=b.district_id WHERE a.district_id=$1 AND ${districtWide(a)?"$2::uuid IS NULL":"b.school_id=$2"} AND a.isbn IS NOT NULL AND length(a.isbn)>=10 AND a.available_count>0 AND b.available_count=0 ORDER BY a.title,sa.name LIMIT 200`,args);
  const gaps=await rows(c,`SELECT school_id,subject,count(*)::int AS out_of_stock_titles FROM library_items i WHERE district_id=$1 AND ${scope} AND available_count=0 AND subject IS NOT NULL GROUP BY school_id,subject ORDER BY out_of_stock_titles DESC LIMIT 100`,args);
  const purchase=await rows(c,`SELECT i.school_id,title,isbn,subject,count(*)::int AS active_overdue_or_lost FROM library_items i JOIN library_loans l ON l.item_id=i.id AND l.district_id=i.district_id WHERE i.district_id=$1 AND ${scope} AND l.returned_at IS NULL AND (l.status='lost' OR l.due_at<now()) GROUP BY i.school_id,title,isbn,subject ORDER BY active_overdue_or_lost DESC LIMIT 100`,args);
  await audit(c,req,"read","library_intelligence",null,"recommendations");
  return {transferCandidates:matches.map(x=>({...x,recommendation:"Review cross-school transfer; librarian approval required"})),collectionGaps:gaps,purchaseReview:purchase.map(x=>({...x,recommendation:"Review replacement or additional purchase; verify physical inventory first"}))};
 }));
}
