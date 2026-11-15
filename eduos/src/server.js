import express from "express";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { config } from "./config.js";
import { pool, withTenantTransaction, assertSafeRuntimeRole, assertSchemaReady } from "./db.js";
import { beginLogin, completeLogin, exchangeNativeLogin, requireSession, requireCsrf, issueCsrfToken, logout, listMemberships, switchMembership } from "./auth.js";
import { requirePermission, requireSchoolScope, canPerform, isGrantable, isDistrictRole } from "./policy.js";
import { writeAudit } from "./audit.js";
import { normalizeAgentEvent } from "./agent-events.js";
import { classifyOperationalEvent } from "./operational-event-taxonomy.js";
import { FLOW_EVENT_TYPES, isFlowEventType, normalizeFlowEvent, serverFlowEvent, webhookPayload } from "./flow-events.js";
import { deliverWebhook, deriveWebhookSecret, resolveWebhookTarget, validateWebhookUrl } from "./webhooks.js";
import { processWebhookOutbox as processOutbox } from "./webhook-outbox.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerMeshRoutes } from "./mesh-routes.js";
import { registerHomeRoutes } from "./home-routes.js";
import { registerBrandingRoutes } from "./branding-routes.js";
import { registerTransportRoutes } from "./transport-routes.js";
import { registerChristieRoutes } from "./christie-routes.js";
import { registerCommsRoutes } from "./comms-routes.js";
import { registerSafetyRoutes } from "./safety-routes.js";
import { registerPickupRoutes } from "./pickup-routes.js";
import { registerArrivalRoutes } from "./arrival-routes.js";
import { registerArrivalExceptionRoutes } from "./arrival-exception-routes.js";
import { registerLearningRoutes } from "./learning-routes.js";
import { registerEdalRoutes } from "./edal-routes.js";
import { registerLibraryRoutes } from "./library-routes.js";
import { registerLibraryCirculationRoutes } from "./library-circulation-routes.js";
import { registerLibraryIntelligenceRoutes } from "./library-intelligence-routes.js";
import { registerSchoolOperationsRoutes } from "./school-operations-routes.js";
import { registerUnifiedSchoolOperationsRoutes } from "./unified-school-operations-routes.js";
import { registerSchoolOperationsAutomationRoutes } from "./school-operations-automation-routes.js";
import { registerSchoolOperationsNotificationRoutes } from "./school-operations-notification-routes.js";
import { registerStaffDailyWorkspaceRoutes } from "./staff-daily-workspace-routes.js";
import { registerStaffManagementRoutes } from "./staff-management-routes.js";
import { registerEdgeDeviceRoutes } from "./edge-device-routes.js";
import { registerEdgeUpdateRoutes } from "./edge-update-routes.js";
import { registerEdenHub } from "./eden/hub.js";
import { registerEdenNode, startAgent } from "./eden/node.js";
import { parseSisCsv, isCalendarDate } from "./csv.js";
import { metricsMiddleware, metricsHandler } from "./metrics.js";
import { pageOf, pageSql, paged } from "./paging.js";
import { queuedAt, idempotencyKey, claimReplay } from "./offline-replay.js";

const app = express();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const APP_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
app.disable("x-powered-by");
if (config.trustedProxyIps.length) app.set("trust proxy", config.trustedProxyIps);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"],
  // Transitional compatibility for the uploaded legacy UI's inline script and onclick attributes.
  // Remove unsafe-inline after migrating those handlers to external modules.
  scriptSrc: ["'self'", "'unsafe-inline'"],
  scriptSrcAttr: ["'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:", "blob:", "https:"],
  connectSrc: ["'self'"],
  fontSrc: ["'self'", "data:"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  // 'self' (not 'none') so the same-origin Vision Studio iframe can load;
  // other origins still cannot frame EduOS.
  frameAncestors: ["'self'"]
} } }));
app.use(metricsMiddleware);
app.use(compression());
// Request-body size limits are DoS protections, not product caps (docs/LIMITS.md).
// JSON_BODY_LIMIT (default 256kb) everywhere except the SIS import routes, which
// parse up to SIS_IMPORT_MAX_MB (default 50) only AFTER the session is verified.
const BULK_PATHS = new Set(["/api/integrations/sis/import-csv", "/api/integrations/sis/import"]);
const smallJson = express.json({ limit: config.jsonBodyLimit, strict: true });
const bulkJson = express.json({ limit: config.sisImportMaxBytes, strict: true });
// 32.7.0: node-to-hub EDEN requests are signed over the exact body bytes, so
// that parser keeps the raw text (and allows the larger sealed DECN packages).
const edenJson = express.json({ limit: "16mb", strict: true, verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } });
app.use((req, res, next) => req.path.startsWith("/api/eden/v1/") ? edenJson(req, res, next) : BULK_PATHS.has(req.path) ? next() : smallJson(req, res, next));
app.use((req,res,next)=>{ req.requestId=crypto.randomUUID(); res.setHeader("X-Request-Id",req.requestId); next(); });

// 32.1.0: configurable. 30 per 15 minutes per IP locked out a whole school
// behind one NAT address at the start of the day (login + callback = 2 hits).
const loginLimiter=rateLimit({windowMs:15*60_000,limit:config.loginRateLimit,standardHeaders:true,legacyHeaders:false});
// 32.2.0: invitation creation was 20/hour per IP, which stopped a school office
// inviting its families at the start of the year (now 1,000/hour, configurable).
// Acceptance stays tight (10/15 min): it guards one-time tokens against guessing.
const guardianInviteLimiter=rateLimit({windowMs:60*60_000,limit:config.guardianInviteRateLimit,standardHeaders:true,legacyHeaders:false});
const guardianAcceptLimiter=rateLimit({windowMs:15*60_000,limit:config.guardianAcceptRateLimit,standardHeaders:true,legacyHeaders:false});
// Teachers see only students on their roster (teacher_student_rosters).
const rosterSql=(studentCol,userParam)=>`EXISTS(SELECT 1 FROM teacher_student_rosters tr WHERE tr.student_id=${studentCol} AND tr.teacher_user_id=${userParam})`;
// FERPA: record reads of student education records inside the same transaction.
function auditRead(client,req,resourceType,resourceId,detail=null){
  return client.query(
    `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
     VALUES($1,$2,$3,'read',$4,$5,'success',$6,$7)`,
    [req.actor.districtId,req.actor.userId,req.actor.role,resourceType,resourceId||null,detail,req.requestId]);
}

app.get("/health", async (_req,res)=> {
  res.setHeader("Cache-Control","no-store");
  try { await pool.query("SELECT 1"); res.json({status:"ok",version:APP_VERSION}); }
  catch { res.status(503).json({status:"unavailable"}); }
});
app.get("/metrics",metricsHandler({token:config.metricsToken,version:APP_VERSION,poolStats:()=>pool.stats()}));
app.get("/auth/login",loginLimiter,beginLogin);
app.get("/auth/callback",loginLimiter,completeLogin);
app.post("/auth/native/token",loginLimiter,exchangeNativeLogin);
app.post("/auth/logout",requireSession,requireCsrf,logout);
app.get("/api/csrf",requireSession,issueCsrfToken);

// Public, non-sensitive UI configuration. The browser hides the synthetic
// persona demo unless demo mode is explicitly enabled (never in production).
app.get("/api/app-config",(_req,res)=>{res.setHeader("Cache-Control","no-store");res.json({demoMode:config.demoMode})});

// Accounts may hold several memberships (e.g. a teacher who is also a parent,
// or a parent with children at two schools). Switching rotates the session.
app.get("/api/memberships",requireSession,listMemberships);
app.post("/api/session/membership",requireSession,requireCsrf,switchMembership);

app.get("/api/me",requireSession,(req,res)=>res.json({userId:req.actor.userId,displayName:req.actor.displayName,role:req.actor.role,districtId:req.actor.districtId,schoolId:req.actor.schoolId}));

app.get("/api/schools",requireSession,requirePermission("schools","read"),async(req,res,next)=>{
  try {
    const rows=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT id,name,school_level,status FROM schools WHERE ($1 IN ('superintendent','it_admin') OR id=$2) ORDER BY name`,
      [req.actor.role,req.actor.schoolId]
    ));
    res.json({data:rows.rows});
  } catch(e){next(e)}
});

app.get("/api/students",requireSession,requirePermission("students","read"),requireSchoolScope,async(req,res,next)=>{
  const pgn=pageOf(req);
  if(req.query.schoolId && !validId(req.query.schoolId)) return res.status(400).json({error:"invalid_school_id"});
  // 32.2.0: paged (?limit, ?offset) with an optional name / student-number search (?q).
  const q=typeof req.query.q==="string"?req.query.q.trim().slice(0,100):"";
  try {
    const rows=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT s.id,s.local_student_number,s.display_name,s.grade_level,s.school_id,sc.name AS school_name,count(*) OVER() AS total
         FROM students s JOIN schools sc ON sc.id=s.school_id AND sc.district_id=s.district_id
        WHERE ($1::uuid IS NULL OR s.school_id=$1::uuid)
          AND (
            $2::text NOT IN ('parent','pupil')
            OR EXISTS (
              SELECT 1 FROM student_user_links l
               WHERE l.student_id=s.id AND l.user_id=$3 AND l.status='active'
                 AND (($2='parent' AND l.relationship IN ('parent','guardian')) OR ($2='pupil' AND l.relationship='pupil'))
            )
          )
          AND ($2 NOT IN ('teacher','principal') OR s.school_id=$4::uuid)
          AND ($2<>'teacher' OR ${rosterSql("s.id","$3")})
          AND ($5::text='' OR s.display_name ILIKE '%'||$6||'%' OR s.local_student_number LIKE $6||'%')
        ORDER BY s.display_name,s.id ${pageSql(pgn)}`,
      [req.query.schoolId || null, req.actor.role, req.actor.userId, req.actor.schoolId, q, q.replace(/[\\%_]/g,m=>"\\"+m)]
    ).then(async result=>{await auditRead(client,req,"student_directory",req.query.schoolId||null,`count=${Math.min(result.rowCount,pgn.limit)}${q?";search":""}`);return result;}));
    const total=rows.rows.length?Number(rows.rows[0].total):(pgn.offset?null:0);
    const out=paged(rows.rows.map(({total:_t,...r})=>r),pgn,{total});
    res.json(out);
  } catch(e){next(e)}
});


// Guardian-only family APIs. Each query independently verifies an active
// guardian relationship inside the tenant-scoped transaction; client-supplied
// student IDs are never treated as proof of access.
function requireGuardian(req,res,next){
  if(!req.actor) return res.status(401).json({error:"authentication_required"});
  if(req.actor.role!=="parent") return res.status(403).json({error:"guardian_role_required"});
  next();
}
app.get("/api/family/children",requireSession,requireGuardian,requirePermission("students","read"),async(req,res,next)=>{
  try{
    const result=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT s.id,s.display_name,s.grade_level,s.school_id,sc.name AS school_name,
              l.relationship
         FROM student_user_links l
         JOIN students s ON s.id=l.student_id AND s.district_id=l.district_id
         JOIN schools sc ON sc.id=s.school_id AND sc.district_id=s.district_id
        WHERE l.district_id=$1 AND l.user_id=$2 AND l.status='active'
          AND l.relationship IN ('parent','guardian')
        ORDER BY s.display_name`,
      [req.actor.districtId,req.actor.userId]
    ));
    res.json({data:result.rows});
  }catch(e){next(e)}
});
app.get("/api/family/children/:studentId/summary",requireSession,requireGuardian,requirePermission("students","read"),async(req,res,next)=>{
  if(!validId(req.params.studentId)) return res.status(400).json({error:"invalid_student_id"});
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const linked=await client.query(
        `SELECT s.id,s.display_name,s.grade_level,s.school_id,sc.name AS school_name
           FROM student_user_links l
           JOIN students s ON s.id=l.student_id AND s.district_id=l.district_id
           JOIN schools sc ON sc.id=s.school_id AND sc.district_id=s.district_id
          WHERE l.district_id=$1 AND l.user_id=$2 AND l.student_id=$3
            AND l.status='active' AND l.relationship IN ('parent','guardian')
          LIMIT 1`,
        [req.actor.districtId,req.actor.userId,req.params.studentId]
      );
      if(!linked.rowCount)return null;
      const [attendance,assignments]=await inSequence([
        ()=>client.query(
          `SELECT event_date,status,family_acknowledged_at
             FROM attendance_events
            WHERE district_id=$1 AND student_id=$2
            ORDER BY event_date DESC LIMIT 60`,
          [req.actor.districtId,req.params.studentId]
        ),
        ()=>client.query(
          `SELECT a.id,a.title,a.due_at,a.status AS assignment_status,
                  sub.submitted_at,sub.score,sub.feedback,sub.graded_at
             FROM assignments a
             LEFT JOIN assignment_submissions sub
               ON sub.assignment_id=a.id AND sub.student_id=$2 AND sub.district_id=a.district_id
            WHERE a.district_id=$1 AND a.school_id=$3 AND a.status='published'
            ORDER BY a.due_at DESC NULLS LAST,a.created_at DESC LIMIT 100`,
          [req.actor.districtId,req.params.studentId,linked.rows[0].school_id]
        )
      ]);
      await auditRead(client,req,"family_student_summary",req.params.studentId);
      return {student:linked.rows[0],attendance:attendance.rows,assignments:assignments.rows};
    });
    if(!result)return res.status(404).json({error:"linked_student_not_found"});
    res.json(result);
  }catch(e){next(e)}
});


// Phase 32.0.34: authenticated family messaging. Both sides of a conversation
// must be an authorized participant for the selected learner and school.
function familyConversationScope(actor, studentId, client) {
  return client.query(
    `SELECT s.id,s.school_id FROM students s
      WHERE s.id=$1 AND s.district_id=$2
        AND (
          ($3='parent' AND EXISTS(SELECT 1 FROM student_user_links l
            WHERE l.district_id=s.district_id AND l.student_id=s.id AND l.user_id=$4
              AND l.status='active' AND l.relationship IN ('parent','guardian')))
          OR ($3='principal' AND s.school_id=$5)
          OR ($3='teacher' AND s.school_id=$5 AND ${rosterSql("s.id","$4")})
          OR ($3='superintendent')
        )`,
    [studentId,actor.districtId,actor.role,actor.userId,actor.schoolId]
  );
}

app.get("/api/family/contacts",requireSession,async(req,res,next)=>{
  if(!["parent","teacher","principal","superintendent"].includes(req.actor.role)||!validId(req.query.studentId))return res.status(403).json({error:"authorized_family_workspace_required"});
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const scope=await familyConversationScope(req.actor,req.query.studentId,client);
      if(!scope.rowCount)return null;
      if(req.actor.role==="parent")return client.query(
        `SELECT u.id,u.display_name,m.role
           FROM memberships m JOIN users u ON u.id=m.user_id
          WHERE m.district_id=$1 AND m.status='active'
            AND (m.role='superintendent' OR (m.school_id=$2 AND m.role IN ('teacher','principal')))
          ORDER BY CASE m.role WHEN 'teacher' THEN 1 WHEN 'principal' THEN 2 ELSE 3 END,u.display_name`,
        [req.actor.districtId,scope.rows[0].school_id]
      );
      return client.query(
        `SELECT u.id,u.display_name,'parent'::text AS role
           FROM student_user_links l JOIN memberships m
             ON m.district_id=l.district_id AND m.user_id=l.user_id
           JOIN users u ON u.id=l.user_id
          WHERE l.district_id=$1 AND l.student_id=$2 AND l.status='active'
            AND l.relationship IN ('parent','guardian') AND m.status='active' AND m.role='parent'
          ORDER BY u.display_name`,
        [req.actor.districtId,req.query.studentId]
      );
    });
    if(!result)return res.status(404).json({error:"learner_not_authorized"});
    res.json({data:result.rows});
  }catch(e){next(e)}
});
app.get("/api/family/messages",requireSession,async(req,res,next)=>{
  const pgn=pageOf(req);
  if(!["parent","teacher","principal","superintendent"].includes(req.actor.role))
    return res.status(403).json({error:"family_messaging_role_required"});
  if(req.query.studentId&&!validId(req.query.studentId))return res.status(400).json({error:"invalid_student_id"});
  try{
    const rows=await withTenantTransaction(req.actor,async client=>{
      if(req.query.studentId){
        const scope=await familyConversationScope(req.actor,req.query.studentId,client);
        if(!scope.rowCount)return null;
      }
      return client.query(
        `SELECT m.id,m.student_id,m.sender_user_id,m.recipient_user_id,m.body,m.created_at,m.read_at,
                sender.display_name AS sender_name,recipient.display_name AS recipient_name
           FROM family_messages m
           JOIN users sender ON sender.id=m.sender_user_id
           JOIN users recipient ON recipient.id=m.recipient_user_id
          WHERE m.district_id=$1 AND (m.sender_user_id=$2 OR m.recipient_user_id=$2)
            AND ($3::uuid IS NULL OR m.student_id=$3::uuid)
          ORDER BY m.created_at DESC ${pageSql(pgn)}`,
        [req.actor.districtId,req.actor.userId,req.query.studentId||null]
      );
    });
    if(!rows)return res.status(404).json({error:"learner_not_authorized"});
    res.json(paged(rows.rows,pgn));
  }catch(e){next(e)}
});
app.post("/api/family/messages",requireSession,requireCsrf,async(req,res,next)=>{
  if(!["parent","teacher","principal","superintendent"].includes(req.actor.role))
    return res.status(403).json({error:"family_messaging_role_required"});
  const {studentId,recipientUserId,body}=req.body||{};
  if(!validId(studentId)||!validId(recipientUserId)||!cleanText(body,4000)||recipientUserId===req.actor.userId)
    return res.status(400).json({error:"invalid_message_payload"});
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const scope=await familyConversationScope(req.actor,studentId,client);
      if(!scope.rowCount)return {status:404,error:"learner_not_authorized"};
      const schoolId=scope.rows[0].school_id;
      let recipient;
      if(req.actor.role==="parent"){
        recipient=await client.query(
          `SELECT 1 FROM memberships WHERE district_id=$1 AND user_id=$2 AND status='active'
             AND role IN ('teacher','principal','superintendent')
             AND (role='superintendent' OR school_id=$3)`,
          [req.actor.districtId,recipientUserId,schoolId]
        );
      }else{
        recipient=await client.query(
          `SELECT 1 FROM student_user_links l
             JOIN memberships m ON m.district_id=l.district_id AND m.user_id=l.user_id
            WHERE l.district_id=$1 AND l.student_id=$2 AND l.user_id=$3
              AND l.status='active' AND l.relationship IN ('parent','guardian')
              AND m.status='active' AND m.role='parent'`,
          [req.actor.districtId,studentId,recipientUserId]
        );
      }
      if(!recipient.rowCount)return {status:403,error:"recipient_not_authorized"};
      const saved=await client.query(
        `INSERT INTO family_messages(district_id,student_id,sender_user_id,recipient_user_id,body)
         VALUES($1,$2,$3,$4,$5)
         RETURNING id,student_id,sender_user_id,recipient_user_id,body,created_at,read_at`,
        [req.actor.districtId,studentId,req.actor.userId,recipientUserId,body.trim()]
      );
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,request_id)
         VALUES($1,$2,$3,'send','family_message',$4,'success',$5)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,saved.rows[0].id,req.requestId]
      );
      return {status:201,data:saved.rows[0]};
    });
    if(result.status!==201)return res.status(result.status).json({error:result.error});
    res.status(201).json({data:result.data});
  }catch(e){next(e)}
});
app.post("/api/family/messages/:messageId/read",requireSession,requireCsrf,async(req,res,next)=>{
  if(!validId(req.params.messageId))return res.status(400).json({error:"invalid_message_id"});
  try{
    const result=await withTenantTransaction(req.actor,client=>client.query(
      `UPDATE family_messages SET read_at=COALESCE(read_at,now())
        WHERE id=$1 AND district_id=$2 AND recipient_user_id=$3
        RETURNING id,read_at`,
      [req.params.messageId,req.actor.districtId,req.actor.userId]
    ));
    if(!result.rowCount)return res.status(404).json({error:"message_not_found"});
    res.json({data:result.rows[0]});
  }catch(e){next(e)}
});

// Account-owned teacher preferences. These are room setup preferences only,
// never official building drawings or emergency routes.
app.get("/api/teacher/classroom-preferences",requireSession,async(req,res,next)=>{
  if(!["teacher","principal"].includes(req.actor.role))return res.status(403).json({error:"teacher_workspace_required"});
  try{
    const result=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT id,school_id,room_label,floor_number,layout,seat_position,preference,updated_at
         FROM teacher_classroom_preferences
        WHERE district_id=$1 AND teacher_user_id=$2 AND school_id=$4 AND $3 IN ('teacher','principal')
        ORDER BY updated_at DESC`,
      [req.actor.districtId,req.actor.userId,req.actor.role,req.actor.schoolId]
    ));
    res.json({data:result.rows});
  }catch(e){next(e)}
});
app.put("/api/teacher/classroom-preferences",requireSession,requireCsrf,async(req,res,next)=>{
  if(!["teacher","principal"].includes(req.actor.role))return res.status(403).json({error:"teacher_workspace_required"});
  const {schoolId,roomLabel,floorNumber,layout,seatPosition,preference={}}=req.body||{};
  if(!validId(schoolId)||!cleanText(roomLabel,80)||!Number.isInteger(floorNumber)||floorNumber<1||floorNumber>100||
     !["rows","pods","u","groups"].includes(layout)||
     !["front-left","front-center","front-right","side-left","side-right","back-center"].includes(seatPosition)||
     !preference||typeof preference!=="object"||Array.isArray(preference)||Buffer.byteLength(JSON.stringify(preference))>16384)
    return res.status(400).json({error:"invalid_classroom_preference"});
  if(schoolId!==req.actor.schoolId)return res.status(403).json({error:"school_scope_denied"});
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const school=await client.query("SELECT 1 FROM schools WHERE id=$1 AND district_id=$2 AND status='active'",[schoolId,req.actor.districtId]);
      if(!school.rowCount)return null;
      const saved=await client.query(
        `INSERT INTO teacher_classroom_preferences(district_id,school_id,teacher_user_id,room_label,floor_number,layout,seat_position,preference)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT(district_id,teacher_user_id,school_id,room_label)
         DO UPDATE SET floor_number=EXCLUDED.floor_number,layout=EXCLUDED.layout,
           seat_position=EXCLUDED.seat_position,preference=EXCLUDED.preference,updated_at=now()
         RETURNING id,school_id,room_label,floor_number,layout,seat_position,preference,updated_at`,
        [req.actor.districtId,schoolId,req.actor.userId,roomLabel.trim(),floorNumber,layout,seatPosition,JSON.stringify(preference)]
      );
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,request_id)
         VALUES($1,$2,$3,'save','classroom_preference',$4,'success',$5)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,saved.rows[0].id,req.requestId]
      );
      return saved.rows[0];
    });
    if(!result)return res.status(404).json({error:"school_not_found"});
    res.json({data:result});
  }catch(e){next(e)}
});



// District-controlled SIS import adapter. Vendor transport and credentials are
// intentionally external; this endpoint accepts a validated, authenticated batch.
app.get("/api/integrations/sis/runs",requireSession,requirePermission("schools","read"),async(req,res,next)=>{
  const pgn=pageOf(req);
  try{
    const result=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT r.id,r.school_id,s.name AS school_name,r.source_system,r.source_batch_id,r.status,
              r.students_received,r.students_upserted,r.attendance_received,r.attendance_imported,
              r.created_at,u.display_name AS initiated_by
         FROM sis_sync_runs r JOIN schools s ON s.id=r.school_id AND s.district_id=r.district_id
         JOIN users u ON u.id=r.initiated_by
        WHERE r.district_id=$1 AND ($2 IN ('superintendent','it_admin') OR r.school_id=$3)
        ORDER BY r.created_at DESC ${pageSql(pgn)}`,
      [req.actor.districtId,req.actor.role,req.actor.schoolId]
    ));
    res.json(paged(result.rows,pgn));
  }catch(e){next(e)}
});
app.post("/api/integrations/sis/import",requireSession,requireCsrf,requirePermission("schools","update"),bulkJson,(req,res,next)=>importSisBatch(req.body,req,res,next));
// 32.1.0: the same import from CSV text (what SIS exports actually produce).
// Body: {schoolId,sourceSystem,sourceBatchId,studentsCsv?,attendanceCsv?}; see src/csv.js for the columns.
app.post("/api/integrations/sis/import-csv",requireSession,requireCsrf,requirePermission("schools","update"),bulkJson,(req,res,next)=>{
  const {schoolId,sourceSystem,sourceBatchId,studentsCsv,attendanceCsv}=req.body||{};
  if(typeof studentsCsv!=="string"&&typeof attendanceCsv!=="string")return res.status(400).json({error:"csv_required"});
  let parsed;
  try{parsed=parseSisCsv({studentsCsv,attendanceCsv});}
  catch(e){if(e.code?.startsWith("csv_"))return res.status(400).json({error:e.code,line:e.line,detail:e.detail});return next(e);}
  return importSisBatch({schoolId,sourceSystem,sourceBatchId,...parsed},req,res,next);
});
const SIS_CHUNK=2000;
// District-configurable caps (32.2.0, district_settings). NULL = unlimited, the default.
const DISTRICT_CAPS=["max_schools","max_students","max_users","max_active_webhooks","max_apps"];
async function districtCap(client,districtId,key){
  if(!DISTRICT_CAPS.includes(key))throw new Error("unknown district cap");
  const r=await client.query(`SELECT ${key} AS v FROM district_settings WHERE district_id=$1`,[districtId]);
  return r.rows[0]?.v??null;
}
async function importSisBatch(batch,req,res,next){
  const {schoolId,sourceSystem,sourceBatchId,students=[],attendance=[]}=batch||{};
  if(!validId(schoolId)||!cleanText(sourceSystem,80)||!cleanText(sourceBatchId,160)||
     !Array.isArray(students)||!Array.isArray(attendance))
    return res.status(400).json({error:"invalid_sis_batch"});
  // 32.2.0: no row caps (were 5,000 students / 10,000 attendance rows per
  // batch). Size is bounded by SIS_IMPORT_MAX_MB; rows are written set-based in
  // chunks, so a 50,000-student district imports in one batch.
  // A school-scoped role or grant may only import into that school.
  if(!isDistrictRole(req.actor.role)&&schoolId!==req.actor.schoolId)
    return res.status(403).json({error:"school_scope_denied"});
  if(req.permissionSource?.via==="grant"&&req.permissionSource.schoolId&&req.permissionSource.schoolId!==schoolId)
    return res.status(403).json({error:"school_scope_denied"});
  const seenStudents=new Set();
  for(const s of students){
    if(!s||!cleanText(s.localStudentNumber,80)||!cleanText(s.displayName,160)||
       (s.gradeLevel!==null&&s.gradeLevel!==undefined&&typeof s.gradeLevel!=="string")||
       seenStudents.has(String(s.localStudentNumber).trim()))
      return res.status(400).json({error:"invalid_or_duplicate_student_record"});
    seenStudents.add(String(s.localStudentNumber).trim());
  }
  for(const a of attendance){
    if(!a||!cleanText(a.sourceEventId,160)||!cleanText(a.localStudentNumber,80)||
       typeof a.eventDate!=="string"||!isCalendarDate(a.eventDate)||
       !["present","absent","tardy","excused"].includes(a.status))
      return res.status(400).json({error:"invalid_sis_attendance_record"});
  }
  const payloadHash=crypto.createHash("sha256").update(JSON.stringify(batch)).digest("hex");
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const school=await client.query("SELECT id FROM schools WHERE id=$1 AND district_id=$2 AND status='active'",[schoolId,req.actor.districtId]);
      if(!school.rowCount)return {status:404,error:"school_not_found"};
      const duplicate=await client.query(
        "SELECT id,status FROM sis_sync_runs WHERE district_id=$1 AND source_system=$2 AND source_batch_id=$3",
        [req.actor.districtId,sourceSystem.trim(),sourceBatchId.trim()]
      );
      if(duplicate.rowCount)return {status:409,error:"batch_already_imported",runId:duplicate.rows[0].id};
      const run=await client.query(
        `INSERT INTO sis_sync_runs(district_id,school_id,initiated_by,source_system,source_batch_id,status,
          students_received,attendance_received,payload_sha256)
         VALUES($1,$2,$3,$4,$5,'completed',$6,$7,$8) RETURNING id`,
        [req.actor.districtId,schoolId,req.actor.userId,sourceSystem.trim(),sourceBatchId.trim(),students.length,attendance.length,payloadHash]
      );
      let studentCount=0,attendanceCount=0;
      const src=sourceSystem.trim();
      const cap=await districtCap(client,req.actor.districtId,"max_students");
      // Last row wins for a repeated student number, as with the row-by-row import.
      const uniqueStudents=[...new Map(students.map(s=>[String(s.localStudentNumber).trim(),s])).values()];
      for(let k=0;k<uniqueStudents.length;k+=SIS_CHUNK){
        const chunk=uniqueStudents.slice(k,k+SIS_CHUNK);
        const saved=await client.query(
          `INSERT INTO students(district_id,school_id,local_student_number,display_name,grade_level)
           SELECT $1,$2,n,d,g FROM unnest($3::text[],$4::text[],$5::text[]) AS t(n,d,g)
           ON CONFLICT(district_id,local_student_number) DO UPDATE
             SET display_name=EXCLUDED.display_name,grade_level=EXCLUDED.grade_level
             WHERE students.school_id=EXCLUDED.school_id
           RETURNING id`,
          [req.actor.districtId,schoolId,chunk.map(s=>String(s.localStudentNumber).trim()),chunk.map(s=>s.displayName.trim()),chunk.map(s=>s.gradeLevel||null)]
        );
        // A row that already belongs to another school is not updated (and not returned).
        if(saved.rowCount!==chunk.length)throw Object.assign(new Error("student_school_conflict"),{code:"SIS_STUDENT_SCHOOL_CONFLICT"});
        studentCount+=saved.rowCount;
      }
      if(cap!==null&&students.length){
        const n=(await client.query("SELECT count(*)::int AS n FROM students WHERE district_id=$1",[req.actor.districtId])).rows[0].n;
        if(n>cap)throw Object.assign(new Error("district_student_limit"),{code:"DISTRICT_LIMIT_MAX_STUDENTS"});
      }
      for(let k=0;k<attendance.length;k+=SIS_CHUNK){
        const chunk=attendance.slice(k,k+SIS_CHUNK);
        const args=[req.actor.districtId,schoolId,chunk.map(a=>a.sourceEventId.trim()),chunk.map(a=>String(a.localStudentNumber).trim()),chunk.map(a=>a.eventDate),chunk.map(a=>a.status),src,run.rows[0].id];
        const missing=await client.query(
          `SELECT count(*)::int AS n FROM unnest($3::text[]) AS t(num)
            WHERE NOT EXISTS(SELECT 1 FROM students s WHERE s.district_id=$1 AND s.school_id=$2 AND s.local_student_number=t.num)`,
          [req.actor.districtId,schoolId,args[3]]);
        if(missing.rows[0].n)throw Object.assign(new Error("attendance_student_not_found"),{code:"SIS_STUDENT_NOT_FOUND"});
        // Events already imported (by source_event_id) are skipped, as before.
        const inserted=await client.query(
          `WITH input AS (
             SELECT DISTINCT ON (eid) eid,num,d,st
               FROM unnest($3::text[],$4::text[],$5::date[],$6::text[]) WITH ORDINALITY AS t(eid,num,d,st,ord)
              ORDER BY eid,ord),
           fresh AS MATERIALIZED (
             SELECT gen_random_uuid() AS new_id,i.eid,i.d,i.st,s.id AS sid FROM input i
               JOIN students s ON s.district_id=$1 AND s.school_id=$2 AND s.local_student_number=i.num
              WHERE NOT EXISTS(SELECT 1 FROM sis_attendance_imports x WHERE x.district_id=$1 AND x.source_system=$7 AND x.source_event_id=i.eid)),
           ev AS (INSERT INTO attendance_events(id,district_id,student_id,event_date,status) SELECT new_id,$1,sid,d,st FROM fresh RETURNING id),
           imp AS (INSERT INTO sis_attendance_imports(district_id,source_system,source_event_id,attendance_event_id,sync_run_id)
                   SELECT $1,$7,f.eid,f.new_id,$8 FROM fresh f JOIN ev ON ev.id=f.new_id RETURNING 1)
           SELECT count(*)::int AS n FROM imp`,args);
        attendanceCount+=inserted.rows[0].n;
      }
      await client.query(
        `UPDATE sis_sync_runs SET students_upserted=$1,attendance_imported=$2 WHERE id=$3`,
        [studentCount,attendanceCount,run.rows[0].id]
      );
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
         VALUES($1,$2,$3,'sis_import','sis_sync_run',$4,'success',$5,$6)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,run.rows[0].id,
         JSON.stringify({sourceSystem,students:studentCount,attendance:attendanceCount,payloadHash}),req.requestId]
      );
      return {status:201,data:{runId:run.rows[0].id,studentsUpserted:studentCount,attendanceImported:attendanceCount,payloadSha256:payloadHash}};
    });
    if(result.status!==201)return res.status(result.status).json({error:result.error,runId:result.runId});
    res.status(201).json(result);
  }catch(e){
    if(e.code==="SIS_STUDENT_SCHOOL_CONFLICT"||e.code==="SIS_STUDENT_NOT_FOUND")
      return res.status(409).json({error:e.code.toLowerCase()});
    if(e.code==="DISTRICT_LIMIT_MAX_STUDENTS")return res.status(409).json({error:"district_limit_reached",limit:"max_students"});
    if(e.code==="23505")return res.status(409).json({error:"duplicate_sis_batch_or_event"});
    next(e);
  }
}


// Guardian onboarding is deliberately bound to an already-provisioned parent
// account. Acceptance requires the email the IdP verified at sign-in (see
// OIDC_EMAIL_VERIFICATION); this workflow never trusts a client-supplied
// identity claim or upgrades an existing staff membership.
export const GUARDIAN_EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
app.get("/api/guardian-invitations",requireSession,async(req,res,next)=>{
  const pgn=pageOf(req);
  if(!["principal","superintendent"].includes(req.actor.role))return res.status(403).json({error:"staff_only"});
  try{
    const rows=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT gi.id,gi.school_id,gi.student_id,s.display_name AS student_name,
              gi.invited_email,gi.relationship,gi.status,gi.expires_at,gi.created_at,
              gi.accepted_at,gi.revoked_at
         FROM guardian_invitations gi JOIN students s ON s.id=gi.student_id AND s.district_id=gi.district_id
        WHERE ($1='superintendent' OR gi.school_id=$2)
        ORDER BY gi.created_at DESC ${pageSql(pgn)}`,[req.actor.role,req.actor.schoolId]
    ));
    res.json(paged(rows.rows,pgn));
  }catch(e){next(e)}
});

app.post("/api/guardian-invitations",guardianInviteLimiter,requireSession,requireCsrf,async(req,res,next)=>{
  if(!["principal","superintendent"].includes(req.actor.role))return res.status(403).json({error:"staff_only"});
  const {studentId,email,relationship="guardian"}=req.body||{};
  if(!validId(studentId)||typeof email!=="string"||email.trim().length>320||
     !GUARDIAN_EMAIL_RE.test(email.trim())||! ["parent","guardian"].includes(relationship))
    return res.status(400).json({error:"invalid_guardian_invitation"});
  const normalizedEmail=email.trim().toLowerCase();
  const rawToken=crypto.randomBytes(32).toString("base64url");
  const tokenHash=crypto.createHash("sha256").update(rawToken).digest("hex");
  try{
    const created=await withTenantTransaction(req.actor,async client=>{
      const student=await client.query(
        `SELECT id,school_id FROM students WHERE id=$1 AND district_id=$2`,[studentId,req.actor.districtId]);
      if(!student.rowCount)return {status:404,error:"student_not_found"};
      if(req.actor.role!=="superintendent"&&student.rows[0].school_id!==req.actor.schoolId)
        return {status:403,error:"school_scope_denied"};
      const targetSchool=student.rows[0].school_id;
      const duplicate=await client.query(
        `SELECT 1 FROM guardian_invitations WHERE student_id=$1 AND lower(invited_email)=$2 AND status='pending' AND expires_at>now() LIMIT 1`,
        [studentId,normalizedEmail]);
      if(duplicate.rowCount)return {status:409,error:"pending_invitation_exists"};
      const inserted=await client.query(
        `INSERT INTO guardian_invitations(district_id,school_id,student_id,invited_by,invited_email,relationship,token_hash,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '7 days')
         RETURNING id,school_id,student_id,invited_email,relationship,status,expires_at,created_at`,
        [req.actor.districtId,targetSchool,studentId,req.actor.userId,normalizedEmail,relationship,tokenHash]);
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
         VALUES($1,$2,$3,'create','guardian_invitation',$4,'success',$5,$6)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,inserted.rows[0].id,JSON.stringify({studentId,relationship}),req.requestId]);
      return {status:201,data:inserted.rows[0]};
    });
    if(created.status!==201)return res.status(created.status).json({error:created.error});
    // No outbound mail transport is configured. Return the raw secret once only;
    // persist only its SHA-256 digest and never write the secret to logs/audit.
    res.status(201).json({data:created.data,invitationUrl:`/#guardianInvite=${encodeURIComponent(rawToken)}`,delivery:"not_configured",message:"Copy this one-time link to the verified recipient. Email delivery is not configured."});
  }catch(e){next(e)}
});

app.post("/api/guardian-invitations/accept",guardianAcceptLimiter,requireSession,requireCsrf,async(req,res,next)=>{
  const token=req.body?.token;
  if(typeof token!=="string"||token.length<40||token.length>128)return res.status(400).json({error:"invalid_invitation_token"});
  if(req.actor.role!=="parent")return res.status(403).json({error:"preprovisioned_parent_account_required"});
  const tokenHash=crypto.createHash("sha256").update(token).digest("hex");
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const invite=await client.query(
        `SELECT gi.* FROM guardian_invitations gi WHERE gi.token_hash=$1 AND gi.district_id=$2 FOR UPDATE`,
        [tokenHash,req.actor.districtId]);
      if(!invite.rowCount)return {status:404,error:"invitation_not_found"};
      const row=invite.rows[0];
      if(row.status!=="pending")return {status:409,error:"invitation_not_pending"};
      if(row.expires_at<=new Date()){
        await client.query(`UPDATE guardian_invitations SET status='expired' WHERE id=$1`,[row.id]);
        return {status:410,error:"invitation_expired"};
      }
      if(!req.actor.verifiedEmail)return {status:403,error:"idp_verified_email_required"};
      // Any active parent membership at the learner's school (a parent may hold
      // memberships at several schools) plus the IdP-verified email must match.
      const identity=await client.query(
        `SELECT 1 FROM users u JOIN memberships m ON m.user_id=u.id
          WHERE u.id=$1 AND u.status='active' AND m.district_id=$2 AND m.status='active'
            AND m.role='parent' AND m.school_id=$3`,
        [req.actor.userId,req.actor.districtId,row.school_id]);
      if(!identity.rowCount||req.actor.verifiedEmail.trim().toLowerCase()!==row.invited_email)
        return {status:403,error:"verified_account_does_not_match_invitation"};
      await client.query(
        `INSERT INTO student_user_links(district_id,user_id,student_id,relationship,status)
         VALUES($1,$2,$3,$4,'active')
         ON CONFLICT(user_id,student_id,relationship) DO UPDATE SET status='active'`,
        [req.actor.districtId,req.actor.userId,row.student_id,row.relationship]);
      await client.query(
        `UPDATE guardian_invitations SET status='accepted',accepted_by=$1,accepted_at=now() WHERE id=$2`,
        [req.actor.userId,row.id]);
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
         VALUES($1,$2,$3,'accept','guardian_invitation',$4,'success',$5,$6)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,row.id,JSON.stringify({studentId:row.student_id,relationship:row.relationship}),req.requestId]);
      return {status:200,data:{invitationId:row.id,studentId:row.student_id,relationship:row.relationship}};
    });
    if(result.status!==200)return res.status(result.status).json({error:result.error});
    res.json({data:result.data});
  }catch(e){next(e)}
});

app.post("/api/guardian-invitations/:invitationId/revoke",requireSession,requireCsrf,async(req,res,next)=>{
  if(!["principal","superintendent"].includes(req.actor.role))return res.status(403).json({error:"staff_only"});
  if(!validId(req.params.invitationId))return res.status(400).json({error:"invalid_invitation_id"});
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const invite=await client.query(`SELECT id,school_id,status FROM guardian_invitations WHERE id=$1 FOR UPDATE`,[req.params.invitationId]);
      if(!invite.rowCount)return {status:404};
      if(req.actor.role!=="superintendent"&&invite.rows[0].school_id!==req.actor.schoolId)return {status:403};
      if(invite.rows[0].status!=="pending")return {status:409};
      await client.query(`UPDATE guardian_invitations SET status='revoked',revoked_by=$1,revoked_at=now() WHERE id=$2`,[req.actor.userId,req.params.invitationId]);
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,request_id)
         VALUES($1,$2,$3,'revoke','guardian_invitation',$4,'success',$5)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,req.params.invitationId,req.requestId]);
      return {status:200};
    });
    if(result.status!==200)return res.status(result.status).json({error:result.status===403?"school_scope_denied":result.status===409?"invitation_not_pending":"invitation_not_found"});
    res.json({revoked:true});
  }catch(e){next(e)}
});

// Server-backed access requests. Grants are additive, user-specific, scoped,
// time-limited, approved by a different superintendent, and checked on each API call.
app.get("/api/access-requests",requireSession,requirePermission("access_requests","read"),async(req,res,next)=>{
  const pgn=pageOf(req);
  try{
    const rows=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT ar.id,ar.resource,ar.action,ar.reason,ar.school_id,ar.requested_expires_at,
              ar.status,ar.decision_note,ar.created_at,ar.reviewed_at,
              requester.display_name AS requester_name,ar.requester_role,
              reviewer.display_name AS reviewer_name
         FROM access_requests ar
         JOIN users requester ON requester.id=ar.requester_user_id
         LEFT JOIN users reviewer ON reviewer.id=ar.reviewed_by
        WHERE ($1='superintendent' OR ar.requester_user_id=$2)
        ORDER BY ar.created_at DESC ${pageSql(pgn)}`,
      [req.actor.role,req.actor.userId]
    ));
    res.json(paged(rows.rows,pgn));
  }catch(e){next(e)}
});

app.post("/api/access-requests",requireSession,requireCsrf,requirePermission("access_requests","create"),async(req,res,next)=>{
  const {resource,action,reason,schoolId=null,expiresAt}=req.body||{};
  if(!["superintendent","principal","teacher"].includes(req.actor.role))
    return res.status(403).json({error:"staff_only"});
  if(typeof resource!=="string"||typeof action!=="string"||!isGrantable(resource,action)||
     canPerform(req.actor,resource,action)||typeof reason!=="string"||reason.trim().length<20||reason.trim().length>1000||
     typeof expiresAt!=="string"||Number.isNaN(Date.parse(expiresAt)))
    return res.status(400).json({error:"invalid_access_request"});
  const expiry=new Date(expiresAt), now=Date.now();
  if(expiry.getTime()<=now||expiry.getTime()>now+90*24*60*60*1000)
    return res.status(400).json({error:"expiry_must_be_within_90_days"});
  let targetSchool=req.actor.role==="superintendent"?(schoolId||null):req.actor.schoolId;
  if(req.actor.role!=="superintendent"&&schoolId&&schoolId!==req.actor.schoolId)
    return res.status(403).json({error:"school_scope_denied"});
  if(targetSchool&&!validId(targetSchool))return res.status(400).json({error:"invalid_school_id"});
  try{
    const created=await withTenantTransaction(req.actor,async client=>{
      if(targetSchool){
        const school=await client.query("SELECT 1 FROM schools WHERE id=$1",[targetSchool]);
        if(!school.rowCount)return {status:404};
      }
      const pending=await client.query(
        `SELECT 1 FROM access_requests WHERE requester_user_id=$1 AND resource=$2 AND action=$3
          AND school_id IS NOT DISTINCT FROM $4 AND status='pending' LIMIT 1`,
        [req.actor.userId,resource,action,targetSchool]
      );
      if(pending.rowCount)return {status:409,error:"duplicate_pending_request"};
      const activeGrant=await client.query(
        `SELECT 1 FROM permission_grants WHERE user_id=$1 AND resource=$2 AND action=$3
          AND (school_id IS NULL OR school_id IS NOT DISTINCT FROM $4)
          AND starts_at<=now() AND expires_at>now() AND revoked_at IS NULL LIMIT 1`,
        [req.actor.userId,resource,action,targetSchool]
      );
      if(activeGrant.rowCount)return {status:409,error:"permission_already_granted"};
      const row=await client.query(
        `INSERT INTO access_requests(district_id,requester_user_id,requester_role,resource,action,reason,school_id,requested_expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id,resource,action,reason,school_id,requested_expires_at,status,created_at`,
        [req.actor.districtId,req.actor.userId,req.actor.role,resource,action,reason.trim(),targetSchool,expiry]
      );
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
         VALUES($1,$2,$3,'request_access','access_request',$4,'success',$5,$6)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,row.rows[0].id,`${resource}:${action}`,req.requestId]
      );
      return {status:201,data:row.rows[0]};
    });
    if(created.status!==201)return res.status(created.status).json({error:created.error||"school_not_found"});
    res.status(201).json({data:created.data});
  }catch(e){next(e)}
});

app.post("/api/access-requests/:requestId/decision",requireSession,requireCsrf,requirePermission("access_requests","review"),async(req,res,next)=>{
  if(!validId(req.params.requestId))return res.status(400).json({error:"invalid_request_id"});
  const {decision,note=""}=req.body||{};
  if(!["approved","denied"].includes(decision)||typeof note!=="string"||note.length>1000)
    return res.status(400).json({error:"invalid_decision"});
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const selected=await client.query(
        `SELECT * FROM access_requests WHERE id=$1 AND status='pending' FOR UPDATE`,[req.params.requestId]
      );
      if(!selected.rowCount)return {status:404};
      const request=selected.rows[0];
      if(request.requester_user_id===req.actor.userId)return {status:409,error:"self_approval_prohibited"};
      if(decision==="approved"&&!isGrantable(request.resource,request.action))return {status:409,error:"permission_not_grantable"};
      if(request.requested_expires_at<=new Date())return {status:409,error:"request_expired"};
      const updated=await client.query(
        `UPDATE access_requests SET status=$1,reviewed_by=$2,reviewed_at=now(),decision_note=$3
          WHERE id=$4 RETURNING id,resource,action,status`,
        [decision,req.actor.userId, note.trim()||null,request.id]
      );
      let grant=null;
      if(decision==="approved"){
        const inserted=await client.query(
          `INSERT INTO permission_grants(district_id,user_id,granted_by,resource,action,school_id,source_request_id,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id,resource,action,school_id,expires_at`,
          [request.district_id,request.requester_user_id,req.actor.userId,request.resource,request.action,
           request.school_id,request.id,request.requested_expires_at]
        );
        grant=inserted.rows[0];
      }
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
         VALUES($1,$2,$3,$4,'access_request',$5,'success',$6,$7)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,decision,request.id,note.trim()||null,req.requestId]
      );
      return {status:200,request:updated.rows[0],grant};
    });
    if(result.status!==200)return res.status(result.status).json({error:result.error||"request_not_pending"});
    res.json({data:result});
  }catch(e){next(e)}
});

app.post("/api/access-requests/:requestId/revoke",requireSession,requireCsrf,requirePermission("access_requests","review"),async(req,res,next)=>{
  if(!validId(req.params.requestId))return res.status(400).json({error:"invalid_request_id"});
  const {note=""}=req.body||{};
  if(typeof note!=="string"||note.length>1000)return res.status(400).json({error:"invalid_note"});
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const selected=await client.query(
        `SELECT id,status,requester_user_id FROM access_requests WHERE id=$1 FOR UPDATE`,[req.params.requestId]
      );
      if(!selected.rowCount||selected.rows[0].status!=="approved")return {status:404};
      const grant=await client.query(
        `UPDATE permission_grants SET revoked_at=now()
          WHERE source_request_id=$1 AND revoked_at IS NULL RETURNING id`,[req.params.requestId]
      );
      if(!grant.rowCount)return {status:404};
      await client.query(
        `UPDATE access_requests SET status='revoked',reviewed_by=$1,reviewed_at=now(),decision_note=$2 WHERE id=$3`,
        [req.actor.userId,note.trim()||null,req.params.requestId]
      );
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
         VALUES($1,$2,$3,'revoke','permission_grant',$4,'success',$5,$6)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,grant.rows[0].id,note.trim()||null,req.requestId]
      );
      return {status:200};
    });
    if(result.status!==200)return res.status(404).json({error:"active_grant_not_found"});
    res.json({revoked:true});
  }catch(e){next(e)}
});

app.get("/api/audit",requireSession,requirePermission("audit","read"),async(req,res,next)=>{
  const pgn=pageOf(req);
  try {
    const rows=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT occurred_at,actor_role,action,resource_type,resource_id,outcome,detail
         FROM audit_events WHERE ($1 IN ('superintendent','it_admin') OR school_id=$2::uuid)
        ORDER BY occurred_at DESC ${pageSql(pgn)}`,[req.actor.role,req.actor.schoolId]
    ));
    res.json(paged(rows.rows,pgn));
  } catch(e){next(e)}
});

// 32.21.0: authenticated Server-Sent Events stream backed by PostgreSQL
// LISTEN/NOTIFY. The notification contains only a tenant ID and event UUID;
// every event is re-read under the subscriber's tenant/RLS context before it
// is emitted. Resource IDs, details, prompts and student data are not streamed.
app.get("/api/operations/stream",requireSession,requirePermission("audit","read"),async(req,res,next)=>{
  let listener;
  let heartbeat;
  let onNotification;
  let onListenerError;
  let closed=false;
  let replaying=true;
  const notificationBacklog=[];
  const MAX_NOTIFICATION_BACKLOG=500;
  // Bound memory for slow clients. When the queue fills, close the stream;
  // EventSource reconnects with Last-Event-ID and the server replays safely.
  const MAX_PENDING_FRAMES=128;
  const pendingFrames=[];
  let blocked=false;
  const writeFrame=frame=>{
    if(closed)return false;
    if(blocked){
      if(pendingFrames.length>=MAX_PENDING_FRAMES){res.end();close();return false;}
      pendingFrames.push(frame);
      return true;
    }
    blocked=!res.write(frame);
    return true;
  };
  const onDrain=()=>{
    blocked=false;
    while(!closed&&!blocked&&pendingFrames.length){
      blocked=!res.write(pendingFrames.shift());
    }
  };
  res.on("drain",onDrain);
  const sent=new Set();
  const send=(row,eventName="operational")=>{
    if(closed||!row||sent.has(row.id))return;
    sent.add(row.id);
    if(sent.size>500)sent.delete(sent.values().next().value);
    const classification=classifyOperationalEvent({action:row.action,resourceType:row.resource_type,outcome:row.outcome});
    const payload={occurredAt:row.occurred_at,actorRole:row.actor_role,action:row.action,
      resourceType:row.resource_type,outcome:row.outcome,eventType:classification.type,
      label:classification.label,severity:classification.severity};
    writeFrame(`id: ${row.id}\nevent: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const visibleSql=`($1 IN ('superintendent','it_admin') OR school_id=$2::uuid)`;
  const readEvent=async eventId=>withTenantTransaction(req.actor,async client=>{
    const result=await client.query(
      `SELECT id,occurred_at,actor_role,action,resource_type,outcome
         FROM audit_events WHERE id=$3 AND ${visibleSql}`,
      [req.actor.role,req.actor.schoolId,eventId]
    );
    return result.rows[0]||null;
  });
  const close=()=>{
    if(closed)return;
    closed=true;
    clearInterval(heartbeat);
    pendingFrames.length=0;
    notificationBacklog.length=0;
    res.off("drain",onDrain);
    if(listener){
      const activeListener=listener;
      listener=null;
      if(onNotification)activeListener.off("notification",onNotification);
      if(onListenerError)activeListener.off("error",onListenerError);
      activeListener.query("UNLISTEN eduos_operational_events").catch(()=>{}).finally(()=>activeListener.release());
    }
  };
  res.on("close",close);
  try{
    const pgListener=await pool.connect();
    listener=pgListener;
    if(closed){listener=null;pgListener.release();return;}
    await pgListener.query("LISTEN eduos_operational_events");
    if(closed)return;
    res.status(200);
    res.setHeader("Content-Type","text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control","no-cache, no-transform");
    res.setHeader("Connection","keep-alive");
    res.setHeader("X-Accel-Buffering","no");
    res.flushHeaders?.();
    writeFrame("retry: 5000\n: connected\n\n");
    const handleNotification=async message=>{
      if(closed)return;
      let notice;
      try{notice=JSON.parse(message.payload||"{}")}catch{return}
      if(notice.districtId!==req.actor.districtId||typeof notice.eventId!=="string")return;
      try{send(await readEvent(notice.eventId))}catch(error){
        console.error("Operational stream event lookup failed",{requestId:req.requestId,message:error.message});
      }
    };
    // Subscribe before taking the replay/snapshot. PostgreSQL can deliver
    // notifications while the initial query is running; buffer them so the
    // snapshot-to-live transition cannot silently lose an event.
    onNotification=message=>{
      if(closed)return;
      if(replaying){
        if(notificationBacklog.length>=MAX_NOTIFICATION_BACKLOG){res.end();close();return;}
        notificationBacklog.push(message);
        return;
      }
      void handleNotification(message);
    };
    onListenerError=()=>{if(!closed)res.end();close()};
    listener.on("notification",onNotification);
    listener.on("error",onListenerError);
    const lastId=String(req.get("Last-Event-ID")||"");
    if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lastId)){
      const replay=await withTenantTransaction(req.actor,client=>client.query(
        `WITH cursor AS (SELECT occurred_at,id FROM audit_events WHERE id=$3)
         SELECT e.id,e.occurred_at,e.actor_role,e.action,e.resource_type,e.outcome
           FROM audit_events e,cursor c
          WHERE (e.occurred_at,e.id)>(c.occurred_at,c.id) AND ${visibleSql.replaceAll("school_id","e.school_id")} 
          ORDER BY e.occurred_at,e.id LIMIT 100`,
        [req.actor.role,req.actor.schoolId,lastId]
      ));
      replay.rows.forEach(send);
    }else{
      const snapshot=await withTenantTransaction(req.actor,client=>client.query(
        `SELECT id,occurred_at,actor_role,action,resource_type,outcome FROM audit_events
          WHERE ${visibleSql} ORDER BY occurred_at DESC,id DESC LIMIT 20`,
        [req.actor.role,req.actor.schoolId]
      ));
      snapshot.rows.reverse().forEach(row=>send(row,"snapshot"));
    }
    replaying=false;
    const bufferedNotifications=notificationBacklog.splice(0);
    for(const message of bufferedNotifications){
      if(closed)break;
      await handleNotification(message);
    }
    heartbeat=setInterval(()=>{if(!closed)writeFrame(`: heartbeat ${Date.now()}\n\n`)},25_000);
    heartbeat.unref?.();
  }catch(error){
    if(listener){try{listener.release()}catch{}listener=null;}
    if(!res.headersSent)return next(error);
    res.end();
  }
});

// Records only a bounded orchestration category and approved handoff route.
// The user's original question and arbitrary agent output are never accepted.
app.post("/api/agent-events",requireSession,requireCsrf,requirePermission("audit","read"),async(req,res,next)=>{
  const event=normalizeAgentEvent(req.body);
  if(!event)return res.status(400).json({error:"invalid_agent_event"});
  try{
    await writeAudit(req.actor,{
      action:"agent_orchestration",resourceType:"agent_orchestration",resourceId:event.runId,
      outcome:"recorded",detail:`category=${event.category};route=${event.route.join(">")};mode=local-deterministic`,
      requestId:req.requestId
    });
    res.status(201).json({recorded:true,runId:event.runId});
  }catch(e){next(e)}
});

// 32.2.0: the export was truncated at the newest 5,000 events. It now streams
// every event in keyset-ordered chunks inside one transaction, so memory use is
// flat no matter how large the district is.
const AUDIT_EXPORT_CHUNK=2000;
app.post("/api/audit/export",requireSession,requireCsrf,requirePermission("audit","export"),async(req,res,next)=>{
  const columns=["occurred_at","actor_role","action","resource_type","resource_id","outcome","detail"];
  const cell=value=>{
    let text=value instanceof Date?value.toISOString():String(value??"");
    if(/^[\s]*[=+@-]/.test(text))text="'"+text;
    return '"'+text.replace(/"/g,'""')+'"';
  };
  const line=row=>row.map(cell).join(",")+"\r\n";
  const write=chunk=>res.write(chunk)?Promise.resolve():new Promise(resolve=>res.once("drain",resolve));
  try{
    await withTenantTransaction(req.actor,async client=>{
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,outcome,request_id)
         VALUES($1,$2,$3,'export','audit','success',$4)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,req.requestId]
      );
      res.setHeader("Content-Type","text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",'attachment; filename="eduos-server-audit.csv"');
      res.setHeader("Cache-Control","no-store");
      await write(line(columns));
      let cursor=null;
      for(;;){
        const rows=await client.query(
          `SELECT id,occurred_at,occurred_at::text AS cursor_at,actor_role,action,resource_type,resource_id,outcome,detail
             FROM audit_events
            WHERE ($1::timestamptz IS NULL OR (occurred_at,id)<($1::timestamptz,$2::uuid))
            ORDER BY occurred_at DESC,id DESC LIMIT ${AUDIT_EXPORT_CHUNK}`,
          [cursor?.cursor_at??null,cursor?.id??null] // text keeps microseconds
        );
        if(!rows.rowCount)break;
        await write(rows.rows.map(row=>line(columns.map(c=>row[c]))).join(""));
        if(rows.rowCount<AUDIT_EXPORT_CHUNK)break;
        cursor=rows.rows[rows.rowCount-1];
        if(res.destroyed)break;
      }
    });
    res.end();
  }catch(e){if(res.headersSent){console.error("Audit export failed",{message:e.message});res.destroy();}else next(e)}
});

// Example write route: tenant and school constraints are enforced in SQL/RLS,
// permission checks are server-side, and the audit write is in the same transaction.
app.post("/api/attendance/:eventId/acknowledge",requireSession,requireCsrf,requirePermission("attendance","acknowledge"),async(req,res,next)=>{
  if(!validId(req.params.eventId)) return res.status(400).json({error:"invalid_attendance_event_id"});
  try {
    const result=await withTenantTransaction(req.actor,async client=>{
      const event=await client.query(
        `SELECT e.id,e.student_id FROM attendance_events e
          WHERE e.id=$1 FOR UPDATE`,[req.params.eventId]
      );
      if(event.rowCount!==1) return {status:404};
      const link=await client.query(
        `SELECT 1 FROM student_user_links WHERE user_id=$1 AND student_id=$2
          AND status='active' AND relationship IN ('parent','guardian')`,
        [req.actor.userId,event.rows[0].student_id]
      );
      if(link.rowCount!==1) return {status:403};
      const update=await client.query(
        `UPDATE attendance_events SET family_acknowledged_at=now(),family_acknowledged_by=$1
          WHERE id=$2 AND family_acknowledged_at IS NULL RETURNING id`,
        [req.actor.userId,req.params.eventId]
      );
      if(update.rowCount===1){
        await client.query(
          `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,request_id)
           VALUES($1,$2,$3,'acknowledge','attendance',$4,'success',$5)`,
          [req.actor.districtId,req.actor.userId,req.actor.role,req.params.eventId,req.requestId]
        );
      }
      return {status:200,acknowledged:update.rowCount===1};
    });
    if(result.status!==200) return res.status(result.status).json({error:result.status===403?"student_relationship_required":"not_found"});
    res.json({acknowledged:result.acknowledged});
  } catch(e){next(e)}
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// One pg client runs one query at a time; concurrent client.query() calls on a
// transaction client are deprecated in pg 8 and removed in pg 9 (32.1.0).
async function inSequence(queries){const out=[];for(const q of queries)out.push(await q());return out;}
const cleanText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
const validId = value => typeof value === "string" && UUID_RE.test(value);

// Student profile: school staff see their school, superintendent sees district,
// family/student personas see only explicitly linked learner records.
app.get("/api/students/:studentId",requireSession,requirePermission("students","read"),async(req,res,next)=>{
  if(!validId(req.params.studentId)) return res.status(400).json({error:"invalid_student_id"});
  try {
    const result=await withTenantTransaction(req.actor,async client=>{const found=await client.query(
      `SELECT s.id,s.local_student_number,s.display_name,s.grade_level,s.school_id,sc.name AS school_name
         FROM students s JOIN schools sc ON sc.id=s.school_id AND sc.district_id=s.district_id
        WHERE s.id=$1 AND (
          $2='superintendent'
          OR ($2='principal' AND s.school_id=$3)
          OR ($2='teacher' AND s.school_id=$3 AND ${rosterSql("s.id","$4")})
          OR ($2 IN ('parent','pupil') AND EXISTS (
            SELECT 1 FROM student_user_links l WHERE l.student_id=s.id AND l.user_id=$4 AND l.status='active'
              AND (($2='parent' AND l.relationship IN ('parent','guardian')) OR ($2='pupil' AND l.relationship='pupil'))
          ))
        )`,[req.params.studentId,req.actor.role,req.actor.schoolId,req.actor.userId]
    );if(found.rowCount)await auditRead(client,req,"student_profile",req.params.studentId);return found;});
    if(!result.rowCount) return res.status(404).json({error:"student_not_found"});
    res.json({data:result.rows[0]});
  } catch(e){next(e)}
});

app.get("/api/assignments",requireSession,requirePermission("assignments","read"),async(req,res,next)=>{
  const pgn=pageOf(req);
  try {
    const result=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT a.id,a.title,a.instructions,a.due_at,a.status,a.school_id,sc.name AS school_name,
              (SELECT COUNT(*)::int FROM assignment_submissions sub WHERE sub.assignment_id=a.id) AS submission_count
         FROM assignments a JOIN schools sc ON sc.id=a.school_id AND sc.district_id=a.district_id
        WHERE $1='superintendent'
           OR ($1 IN ('teacher','principal') AND a.school_id=$2)
           OR ($1 IN ('parent','pupil') AND a.status='published' AND EXISTS (
             SELECT 1 FROM students st JOIN student_user_links l ON l.student_id=st.id
              WHERE st.school_id=a.school_id AND l.user_id=$3 AND l.status='active'
                AND (($1='parent' AND l.relationship IN ('parent','guardian')) OR ($1='pupil' AND l.relationship='pupil'))
           ))
        ORDER BY a.created_at DESC ${pageSql(pgn)}`,
      [req.actor.role,req.actor.schoolId,req.actor.userId]
    ));
    res.json(paged(result.rows,pgn));
  } catch(e){next(e)}
});

app.post("/api/assignments",requireSession,requireCsrf,requirePermission("assignments","create"),async(req,res,next)=>{
  // 32.1.0: assignments may be saved as drafts (hidden from families and pupils).
  const {title,instructions="",dueAt=null,schoolId,status="published"}=req.body||{};
  if(!cleanText(title,180)||typeof instructions!=="string"||instructions.length>10000||
     (dueAt!==null&&(typeof dueAt!=="string"||Number.isNaN(Date.parse(dueAt))))||!["draft","published"].includes(status))
    return res.status(400).json({error:"invalid_assignment_payload"});
  if(req.actor.role!=="superintendent"&&schoolId&&schoolId!==req.actor.schoolId)
    return res.status(403).json({error:"school_scope_denied"});
  const targetSchool=req.actor.role==="superintendent"?schoolId:req.actor.schoolId;
  if(!validId(targetSchool))return res.status(400).json({error:"valid_school_id_required"});
  try{
    const row=await withTenantTransaction(req.actor,async client=>{
      const created=await client.query(
        `INSERT INTO assignments(district_id,school_id,created_by,title,instructions,due_at,status)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING id,title,instructions,due_at,status,school_id`,
        [req.actor.districtId,targetSchool,req.actor.userId,title.trim(),instructions,dueAt,status]
      );
      const a=created.rows[0];
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,request_id)
         VALUES($1,$2,$3,'create','assignment',$4,'success',$5)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,a.id,req.requestId]
      );
      return a;
    });
    res.status(201).json({data:row});
    if(row.status==="published")emitServerFlow(req,"assignment.created",row.id,row.school_id);
  }catch(e){next(e)}
});

// 32.1.0: edit, publish or close an assignment (staff at its school; superintendent anywhere).
app.patch("/api/assignments/:assignmentId",requireSession,requireCsrf,requirePermission("assignments","update"),async(req,res,next)=>{
  if(!validId(req.params.assignmentId))return res.status(400).json({error:"invalid_assignment_id"});
  const {title,instructions,dueAt,status}=req.body||{};
  if((title!==undefined&&!cleanText(title,180))||(instructions!==undefined&&(typeof instructions!=="string"||instructions.length>10000))||
     (dueAt!==undefined&&dueAt!==null&&(typeof dueAt!=="string"||Number.isNaN(Date.parse(dueAt))))||
     (status!==undefined&&!["draft","published","closed"].includes(status))||[title,instructions,dueAt,status].every(v=>v===undefined))
    return res.status(400).json({error:"invalid_assignment_update"});
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const found=await client.query(`SELECT id,school_id,status FROM assignments WHERE id=$1 FOR UPDATE`,[req.params.assignmentId]);
      if(!found.rowCount)return {status:404,error:"assignment_not_found"};
      if(req.actor.role!=="superintendent"&&found.rows[0].school_id!==req.actor.schoolId)return {status:403,error:"school_scope_denied"};
      if(status==="draft"&&found.rows[0].status!=="draft"){
        const subs=await client.query(`SELECT 1 FROM assignment_submissions WHERE assignment_id=$1 LIMIT 1`,[req.params.assignmentId]);
        if(subs.rowCount)return {status:409,error:"assignment_has_submissions"};
      }
      const updated=await client.query(
        `UPDATE assignments SET title=COALESCE($2,title),instructions=COALESCE($3,instructions),
                due_at=CASE WHEN $5 THEN $4::timestamptz ELSE due_at END,status=COALESCE($6,status),updated_at=now()
          WHERE id=$1 RETURNING id,title,instructions,due_at,status,school_id`,
        [req.params.assignmentId,title?.trim()??null,instructions??null,dueAt??null,dueAt!==undefined,status??null]);
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
         VALUES($1,$2,$3,'update','assignment',$4,'success',$5,$6)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,req.params.assignmentId,JSON.stringify({from:found.rows[0].status,to:updated.rows[0].status}),req.requestId]);
      return {status:200,data:updated.rows[0],published:found.rows[0].status!=="published"&&updated.rows[0].status==="published"};
    });
    if(result.status!==200)return res.status(result.status).json({error:result.error});
    res.json({data:result.data});
    if(result.published)emitServerFlow(req,"assignment.created",result.data.id,result.data.school_id);
  }catch(e){next(e)}
});

app.get("/api/assignments/:assignmentId/submissions",requireSession,requirePermission("assignments","grade"),async(req,res,next)=>{
  if(!validId(req.params.assignmentId))return res.status(400).json({error:"invalid_assignment_id"});
  try{
    const result=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT sub.id,sub.student_id,st.display_name,sub.response_text,sub.submitted_at,sub.score,sub.feedback
         FROM assignment_submissions sub JOIN assignments a ON a.id=sub.assignment_id
         JOIN students st ON st.id=sub.student_id
        WHERE a.id=$1 AND ($2='superintendent' OR a.school_id=$3)
          AND ($2<>'teacher' OR ${rosterSql("st.id","$4")})
        ORDER BY sub.submitted_at`,[req.params.assignmentId,req.actor.role,req.actor.schoolId,req.actor.userId]
    ));
    res.json({data:result.rows});
  }catch(e){next(e)}
});

app.post("/api/assignments/:assignmentId/submit",requireSession,requireCsrf,requirePermission("assignments","submit"),async(req,res,next)=>{
  if(!validId(req.params.assignmentId))return res.status(400).json({error:"invalid_assignment_id"});
  const {studentId,responseText=""}=req.body||{};
  if(!validId(studentId)||typeof responseText!=="string"||responseText.length>20000)
    return res.status(400).json({error:"invalid_submission_payload"});
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const relationship=["pupil"];
      const link=await client.query(
        `SELECT 1 FROM student_user_links WHERE user_id=$1 AND student_id=$2 AND status='active'
          AND relationship=ANY($3::text[])`,[req.actor.userId,studentId,relationship]
      );
      if(!link.rowCount)return {status:403};
      // 32.6.0: quizzes are taken through /api/learning/quizzes (timed, auto-scored).
      const assignment=await client.query(`SELECT id,school_id,status,due_at FROM assignments WHERE id=$1 AND kind='work'`,[req.params.assignmentId]);
      if(!assignment.rowCount||assignment.rows[0].status!=="published"||
         (assignment.rows[0].due_at && new Date(assignment.rows[0].due_at).getTime()<Date.now()))return {status:404};
      const student=await client.query(`SELECT id FROM students WHERE id=$1 AND school_id=$2`,
        [studentId,assignment.rows[0].school_id]);
      if(!student.rowCount)return {status:403};
      const saved=await client.query(
        `INSERT INTO assignment_submissions(district_id,assignment_id,student_id,response_text)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(assignment_id,student_id) DO UPDATE
           SET response_text=EXCLUDED.response_text,submitted_at=now(),
               score=NULL,feedback=NULL,graded_by=NULL,graded_at=NULL
         RETURNING id,assignment_id,student_id,response_text,submitted_at,score,feedback`,
        [req.actor.districtId,req.params.assignmentId,studentId,responseText]
      );
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,request_id)
         VALUES($1,$2,$3,'submit','assignment_submission',$4,'success',$5)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,saved.rows[0].id,req.requestId]
      );
      return {status:200,data:saved.rows[0]};
    });
    if(result.status!==200)return res.status(result.status).json({error:"submission_not_allowed"});
    res.json({data:result.data});
  }catch(e){next(e)}
});

app.post("/api/assignments/:assignmentId/submissions/:submissionId/grade",requireSession,requireCsrf,requirePermission("assignments","grade"),async(req,res,next)=>{
  if(!validId(req.params.assignmentId)||!validId(req.params.submissionId))return res.status(400).json({error:"invalid_record_id"});
  const {score,feedback=""}=req.body||{};
  if(typeof score!=="number"||!Number.isFinite(score)||score<0||score>100||typeof feedback!=="string"||feedback.length>4000)
    return res.status(400).json({error:"invalid_grade_payload"});
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const updated=await client.query(
        `UPDATE assignment_submissions sub SET score=$1,feedback=$2,graded_by=$3,graded_at=now()
          FROM assignments a
         WHERE sub.id=$4 AND sub.assignment_id=$5 AND a.id=sub.assignment_id
           AND ($6='superintendent' OR a.school_id=$7)
           AND ($6<>'teacher' OR ${rosterSql("sub.student_id","$3")})
         RETURNING sub.id,sub.score,sub.feedback,sub.graded_at`,
        [score,feedback,req.actor.userId,req.params.submissionId,req.params.assignmentId,req.actor.role,req.actor.schoolId]
      );
      if(!updated.rowCount)return null;
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,request_id)
         VALUES($1,$2,$3,'grade','assignment_submission',$4,'success',$5)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,req.params.submissionId,req.requestId]
      );
      return updated.rows[0];
    });
    if(!result)return res.status(404).json({error:"submission_not_found"});
    res.json({data:result});
  }catch(e){next(e)}
});

app.get("/api/attendance",requireSession,requirePermission("attendance","read"),async(req,res,next)=>{
  const pgn=pageOf(req);
  try{
    const result=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT e.id,e.event_date,e.status,e.family_acknowledged_at,e.student_id,s.display_name
         FROM attendance_events e JOIN students s ON s.id=e.student_id AND s.district_id=e.district_id
        WHERE $1='superintendent' OR ($1 IN ('principal','vice_principal') AND s.school_id=$2)
           OR ($1='teacher' AND s.school_id=$2 AND ${rosterSql("s.id","$3")})
           OR ($1 IN ('parent','pupil') AND EXISTS (
             SELECT 1 FROM student_user_links l WHERE l.student_id=s.id AND l.user_id=$3 AND l.status='active'
              AND (($1='parent' AND l.relationship IN ('parent','guardian')) OR ($1='pupil' AND l.relationship='pupil'))
           ))
        ORDER BY e.event_date DESC ${pageSql(pgn)}`,[req.actor.role,req.actor.schoolId,req.actor.userId]
    ));
    res.json(paged(result.rows,pgn));
  }catch(e){next(e)}
});

app.post("/api/attendance",requireSession,requireCsrf,requirePermission("attendance","create"),async(req,res,next)=>{
  const {studentId,eventDate,status}=req.body||{};
  if(!validId(studentId)||typeof eventDate!=="string"||!isCalendarDate(eventDate)||!["present","absent","tardy","excused"].includes(status))
    return res.status(400).json({error:"invalid_attendance_payload"});
  let observed;
  try{observed=queuedAt(req);idempotencyKey(req);}catch(e){return res.status(e.status).json({error:e.code});}
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      if(await claimReplay(client,req,"attendance",observed))return {duplicate:true};
      const student=await client.query(
        `SELECT st.id,st.school_id FROM students st WHERE st.id=$1 AND ($2='superintendent' OR st.school_id=$3)
           AND ($2<>'teacher' OR ${rosterSql("st.id","$4")})`,
        [studentId,req.actor.role,req.actor.schoolId,req.actor.userId]
      );
      if(!student.rowCount)return null;
      const saved=await client.query(
        `INSERT INTO attendance_events(district_id,student_id,event_date,status,observed_at)
         VALUES($1,$2,$3,$4,coalesce($5::timestamptz,now())) RETURNING id,event_date,status,student_id`,
        [req.actor.districtId,studentId,eventDate,status,observed]
      );
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,request_id)
         VALUES($1,$2,$3,'record','attendance',$4,'success',$5)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,saved.rows[0].id,req.requestId]
      );
      return {...saved.rows[0],school_id:student.rows[0].school_id};
    });
    if(!result)return res.status(404).json({error:"student_not_found"});
    if(result.duplicate)return res.status(200).json({data:{duplicate:true}});
    const {school_id:attendanceSchoolId,...attendanceRow}=result;
    res.status(201).json({data:attendanceRow});
    // Scoped to the learner's school and subject so only linked families see it.
    emitServerFlow(req,"attendance.recorded",result.id,attendanceSchoolId,result.student_id);
  }catch(e){next(e)}
});

// Phase 32: unified Student 360 read model and server-backed intervention workflow.
const staffRoles = ["superintendent", "principal", "teacher"];
const studentScopeSql = `(
  $2='superintendent'
  OR ($2='principal' AND st.school_id=$3)
  OR ($2='teacher' AND st.school_id=$3 AND EXISTS(SELECT 1 FROM teacher_student_rosters tr WHERE tr.student_id=st.id AND tr.teacher_user_id=$4))
  OR ($2='parent' AND EXISTS (SELECT 1 FROM student_user_links l WHERE l.student_id=st.id AND l.user_id=$4 AND l.status='active' AND l.relationship IN ('parent','guardian')))
  OR ($2='pupil' AND EXISTS (SELECT 1 FROM student_user_links l WHERE l.student_id=st.id AND l.user_id=$4 AND l.status='active' AND l.relationship='pupil'))
)`;

app.get("/api/student-360/:studentId",requireSession,requirePermission("students","read"),async(req,res,next)=>{
  if(!validId(req.params.studentId))return res.status(400).json({error:"invalid_student_id"});
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const profile=await client.query(
        `SELECT st.id,st.local_student_number,st.display_name,st.grade_level,st.school_id,sc.name AS school_name
           FROM students st JOIN schools sc ON sc.id=st.school_id AND sc.district_id=st.district_id
          WHERE st.id=$1 AND ${studentScopeSql}`,
        [req.params.studentId,req.actor.role,req.actor.schoolId,req.actor.userId]
      );
      if(!profile.rowCount)return null;
      const studentId=req.params.studentId;
      const [attendance,assignments,cases,timeline]=await inSequence([
        ()=>client.query(`SELECT id,event_date,status,family_acknowledged_at FROM attendance_events WHERE student_id=$1 ORDER BY event_date DESC LIMIT 100`,[studentId]),
        ()=>client.query(`SELECT a.id,a.title,a.due_at,a.status,sub.score,sub.feedback,sub.submitted_at FROM assignments a LEFT JOIN assignment_submissions sub ON sub.assignment_id=a.id AND sub.student_id=$1 WHERE a.school_id=$2 AND (a.status<>'draft' OR $3 IN ('superintendent','principal','teacher')) ORDER BY a.created_at DESC LIMIT 100`,[studentId,profile.rows[0].school_id,req.actor.role]),
        ()=>client.query(`SELECT c.id,c.category,c.priority,c.status,c.title,c.summary,c.family_visible,c.follow_up_at,c.created_at,c.updated_at,owner.display_name AS owner_name
           FROM student_intervention_cases c LEFT JOIN users owner ON owner.id=c.owner_user_id
          WHERE c.student_id=$1 AND ($2 IN ('superintendent','principal','teacher') OR ($2='parent' AND c.family_visible=true))
          ORDER BY c.updated_at DESC LIMIT 100`,[studentId,req.actor.role]),
        ()=>client.query(`SELECT kind,id,occurred_at,label,detail,actor_name FROM (
          SELECT 'attendance'::text AS kind,e.id,e.event_date::timestamp AT TIME ZONE 'UTC' AS occurred_at,
                 'Attendance recorded: '||e.status AS label,NULL::text AS detail,recorder.display_name AS actor_name
            FROM attendance_events e
            LEFT JOIN LATERAL (
              SELECT u.display_name FROM audit_events ae JOIN users u ON u.id=ae.actor_user_id
               WHERE ae.district_id=e.district_id AND ae.resource_type='attendance' AND ae.resource_id=e.id::text AND ae.action='record'
               ORDER BY ae.occurred_at LIMIT 1
            ) recorder ON true
           WHERE e.student_id=$1
          UNION ALL
          SELECT 'attendance_acknowledged',e.id,e.family_acknowledged_at,'Attendance acknowledged',NULL::text,ack.display_name
            FROM attendance_events e LEFT JOIN users ack ON ack.id=e.family_acknowledged_by
           WHERE e.student_id=$1 AND e.family_acknowledged_at IS NOT NULL
          UNION ALL
          SELECT 'assignment',a.id,a.created_at,'Assigned: '||a.title,NULL::text,creator.display_name
            FROM assignments a JOIN users creator ON creator.id=a.created_by
           WHERE a.school_id=$2 AND (a.status<>'draft' OR $3 IN ('superintendent','principal','teacher'))
          UNION ALL
          SELECT 'submission',sub.id,sub.submitted_at,'Submitted: '||a.title,NULL::text,pupil.display_name
            FROM assignment_submissions sub JOIN assignments a ON a.id=sub.assignment_id
            LEFT JOIN LATERAL (
              SELECT u.display_name FROM student_user_links l JOIN users u ON u.id=l.user_id
               WHERE l.student_id=sub.student_id AND l.relationship='pupil' AND l.status='active' LIMIT 1
            ) pupil ON true
           WHERE sub.student_id=$1 AND a.school_id=$2 AND (a.status<>'draft' OR $3 IN ('superintendent','principal','teacher'))
          UNION ALL
          SELECT 'grade',sub.id,sub.graded_at,'Graded: '||a.title,
                 'Score: '||sub.score::text||CASE WHEN COALESCE(sub.feedback,'')='' THEN '' ELSE ' · Feedback: '||sub.feedback END,
                 grader.display_name
            FROM assignment_submissions sub JOIN assignments a ON a.id=sub.assignment_id
            LEFT JOIN users grader ON grader.id=sub.graded_by
           WHERE sub.student_id=$1 AND sub.graded_at IS NOT NULL AND a.school_id=$2
             AND (a.status<>'draft' OR $3 IN ('superintendent','principal','teacher'))
          UNION ALL
          SELECT 'case_note',n.id,n.created_at,c.title,n.note,author.display_name
            FROM student_case_notes n JOIN student_intervention_cases c ON c.id=n.case_id
            JOIN users author ON author.id=n.author_user_id
           WHERE n.student_id=$1 AND ($3 IN ('superintendent','principal','teacher') OR ($3='parent' AND c.family_visible=true AND n.family_visible=true))
        ) events ORDER BY occurred_at DESC LIMIT 200`,[studentId,profile.rows[0].school_id,req.actor.role])
      ]);
      await auditRead(client,req,"student_360",studentId);
      return {student:profile.rows[0],attendance:attendance.rows,academics:assignments.rows,cases:cases.rows,timeline:timeline.rows};
    });
    if(!result)return res.status(404).json({error:"student_not_found"});
    res.json({data:result});
  }catch(e){next(e)}
});

// Teachers may act on a case they own or opened, or for a learner on their roster.
const teacherCaseSql=`($2<>'teacher' OR c.owner_user_id=$4 OR c.created_by=$4 OR EXISTS(SELECT 1 FROM teacher_student_rosters tr WHERE tr.student_id=c.student_id AND tr.teacher_user_id=$4))`;
// A case owner must be staff: a teacher/principal at the case's school or a superintendent.
async function validCaseOwner(client,districtId,ownerUserId,schoolId){
  const owner=await client.query(
    `SELECT 1 FROM memberships WHERE user_id=$1 AND district_id=$2 AND status='active'
       AND (role='superintendent' OR (role IN ('teacher','principal') AND school_id=$3))`,
    [ownerUserId,districtId,schoolId]);
  return owner.rowCount>0;
}

app.get("/api/cases",requireSession,requirePermission("cases","read"),async(req,res,next)=>{
  const pgn=pageOf(req);
  try{
    const result=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT c.id,c.student_id,st.display_name,c.school_id,c.category,c.priority,c.status,c.title,c.summary,c.family_visible,c.follow_up_at,c.created_at,c.updated_at,owner.display_name AS owner_name
         FROM student_intervention_cases c JOIN students st ON st.id=c.student_id
         LEFT JOIN users owner ON owner.id=c.owner_user_id
        WHERE ($1='superintendent' OR ($1='principal' AND c.school_id=$2)
          OR ($1='teacher' AND c.school_id=$2 AND (c.owner_user_id=$3 OR c.created_by=$3 OR ${rosterSql("c.student_id","$3")}))
          OR ($1='parent' AND c.family_visible=true AND EXISTS(SELECT 1 FROM student_user_links l WHERE l.student_id=c.student_id AND l.user_id=$3 AND l.status='active' AND l.relationship IN ('parent','guardian'))))
        ORDER BY c.updated_at DESC ${pageSql(pgn)}`,[req.actor.role,req.actor.schoolId,req.actor.userId]
    ).then(async rows=>{await auditRead(client,req,"intervention_case_list",null,`count=${rows.rowCount}`);return rows;}));
    res.json(paged(result.rows,pgn));
  }catch(e){next(e)}
});

app.post("/api/cases",requireSession,requireCsrf,requirePermission("cases","create"),async(req,res,next)=>{
  if(!staffRoles.includes(req.actor.role))return res.status(403).json({error:"staff_only"});
  const {studentId,category,priority="normal",title,summary,supportPlan="",familyVisible=false,followUpAt=null,ownerUserId=null}=req.body||{};
  if(!validId(studentId)||!['academic','attendance','behavior','wellbeing','family_support','other'].includes(category)||!['low','normal','high','urgent'].includes(priority)||!cleanText(title,180)||!cleanText(summary,4000)||typeof supportPlan!=="string"||supportPlan.length>8000||typeof familyVisible!=="boolean"||(followUpAt!==null&&(typeof followUpAt!=="string"||Number.isNaN(Date.parse(followUpAt))))||(ownerUserId!==null&&!validId(ownerUserId)))return res.status(400).json({error:"invalid_case_payload"});
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const student=await client.query(`SELECT st.id,st.school_id FROM students st WHERE st.id=$1 AND ($2='superintendent' OR st.school_id=$3) AND ($2<>'teacher' OR ${rosterSql("st.id","$4")})`,[studentId,req.actor.role,req.actor.schoolId,req.actor.userId]);
      if(!student.rowCount)return {status:404};
      if(ownerUserId&&!(await validCaseOwner(client,req.actor.districtId,ownerUserId,student.rows[0].school_id)))return {status:400,error:"invalid_case_owner"};
      const created=await client.query(`INSERT INTO student_intervention_cases(district_id,student_id,school_id,created_by,owner_user_id,category,priority,title,summary,support_plan,family_visible,follow_up_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,student_id,school_id,category,priority,status,title,summary,family_visible,follow_up_at,created_at,updated_at`,
        [req.actor.districtId,studentId,student.rows[0].school_id,req.actor.userId,ownerUserId,category,priority,title.trim(),summary.trim(),supportPlan,familyVisible,followUpAt]);
      await client.query(`INSERT INTO student_case_notes(district_id,case_id,student_id,author_user_id,note,family_visible) VALUES($1,$2,$3,$4,$5,$6)`,[req.actor.districtId,created.rows[0].id,studentId,req.actor.userId,"Case opened: "+title.trim(),familyVisible]);
      await client.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,request_id) VALUES($1,$2,$3,'create','intervention_case',$4,'success',$5)`,[req.actor.districtId,req.actor.userId,req.actor.role,created.rows[0].id,req.requestId]);
      return {status:201,data:created.rows[0]};
    });
    if(result.status!==201)return res.status(result.status).json({error:result.error||"student_not_found"});
    res.status(201).json({data:result.data});
  }catch(e){next(e)}
});

app.patch("/api/cases/:caseId",requireSession,requireCsrf,requirePermission("cases","update"),async(req,res,next)=>{
  if(!validId(req.params.caseId))return res.status(400).json({error:"invalid_case_id"});
  const {status,priority,familyVisible,followUpAt,ownerUserId}=req.body||{};
  if(status!==undefined&&!['open','in_progress','monitoring','closed'].includes(status)||priority!==undefined&&!['low','normal','high','urgent'].includes(priority)||familyVisible!==undefined&&typeof familyVisible!=="boolean"||followUpAt!==undefined&&followUpAt!==null&&(typeof followUpAt!=="string"||Number.isNaN(Date.parse(followUpAt)))||ownerUserId!==undefined&&ownerUserId!==null&&!validId(ownerUserId))return res.status(400).json({error:"invalid_case_update"});
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const current=await client.query(`SELECT c.id,c.student_id,c.school_id,c.status FROM student_intervention_cases c WHERE c.id=$1 AND ($2='superintendent' OR c.school_id=$3) AND ${teacherCaseSql} FOR UPDATE`,[req.params.caseId,req.actor.role,req.actor.schoolId,req.actor.userId]);
      if(!current.rowCount)return null;
      if(ownerUserId&&!(await validCaseOwner(client,req.actor.districtId,ownerUserId,current.rows[0].school_id)))return {error:"invalid_case_owner"};
      const updated=await client.query(`UPDATE student_intervention_cases SET status=COALESCE($1,status),priority=COALESCE($2,priority),family_visible=COALESCE($3,family_visible),follow_up_at=CASE WHEN $4 THEN $5 ELSE follow_up_at END,owner_user_id=CASE WHEN $6 THEN $7::uuid ELSE owner_user_id END,closed_at=CASE WHEN COALESCE($1,status)='closed' THEN COALESCE(closed_at,now()) ELSE NULL END,updated_at=now() WHERE id=$8 RETURNING id,status,priority,family_visible,follow_up_at,owner_user_id,closed_at,updated_at`,[status??null,priority??null,familyVisible??null,Object.hasOwn(req.body,"followUpAt"),followUpAt??null,Object.hasOwn(req.body,"ownerUserId"),ownerUserId??null,req.params.caseId]);
      const changed=[];
      if(status!==undefined)changed.push(`status → ${status}`);
      if(priority!==undefined)changed.push(`priority → ${priority}`);
      if(familyVisible!==undefined)changed.push(`family visibility ${familyVisible?'enabled':'disabled'}`);
      if(Object.hasOwn(req.body,"followUpAt"))changed.push("follow-up date changed");
      if(Object.hasOwn(req.body,"ownerUserId"))changed.push("case owner changed");
      await client.query(`INSERT INTO student_case_notes(district_id,case_id,student_id,author_user_id,note,family_visible) VALUES($1,$2,$3,$4,$5,false)`,[req.actor.districtId,req.params.caseId,current.rows[0].student_id,req.actor.userId,`Case updated: ${changed.join('; ')||'record reviewed'}`]);
      await client.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,request_id) VALUES($1,$2,$3,'update','intervention_case',$4,'success',$5)`,[req.actor.districtId,req.actor.userId,req.actor.role,req.params.caseId,req.requestId]);
      return {data:updated.rows[0]};
    });
    if(!result)return res.status(404).json({error:"case_not_found"});if(result.error)return res.status(400).json({error:result.error});res.json({data:result.data});
  }catch(e){next(e)}
});

app.post("/api/cases/:caseId/notes",requireSession,requireCsrf,requirePermission("cases","update"),async(req,res,next)=>{
  if(!validId(req.params.caseId))return res.status(400).json({error:"invalid_case_id"});
  const {note,familyVisible=false}=req.body||{};
  if(!cleanText(note,4000)||typeof familyVisible!=="boolean")return res.status(400).json({error:"invalid_case_note"});
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const c=await client.query(`SELECT c.id,c.student_id FROM student_intervention_cases c WHERE c.id=$1 AND ($2='superintendent' OR c.school_id=$3) AND ${teacherCaseSql}`,[req.params.caseId,req.actor.role,req.actor.schoolId,req.actor.userId]);
      if(!c.rowCount)return null;
      const saved=await client.query(`INSERT INTO student_case_notes(district_id,case_id,student_id,author_user_id,note,family_visible) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,note,family_visible,created_at`,[req.actor.districtId,req.params.caseId,c.rows[0].student_id,req.actor.userId,note.trim(),familyVisible]);
      await client.query(`UPDATE student_intervention_cases SET updated_at=now() WHERE id=$1`,[req.params.caseId]);
      await client.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,request_id) VALUES($1,$2,$3,'append_note','intervention_case',$4,'success',$5)`,[req.actor.districtId,req.actor.userId,req.actor.role,req.params.caseId,req.requestId]);
      return saved.rows[0];
    });
    if(!result)return res.status(404).json({error:"case_not_found"});res.status(201).json({data:result});
  }catch(e){next(e)}
});

// ---- 32.0.53: teacher rosters ----
// Principals manage rosters for their school; superintendents for any school.
// Teachers can read their own roster.
app.get("/api/rosters",requireSession,async(req,res,next)=>{
  const pgn=pageOf(req);
  if(!staffRoles.includes(req.actor.role))return res.status(403).json({error:"staff_only"});
  const teacherUserId=req.actor.role==="teacher"?req.actor.userId:(req.query.teacherUserId||null);
  if(teacherUserId&&!validId(teacherUserId))return res.status(400).json({error:"invalid_teacher_id"});
  try{
    const rows=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT tr.teacher_user_id,u.display_name AS teacher_name,tr.student_id,st.display_name AS student_name,tr.school_id,tr.created_at
         FROM teacher_student_rosters tr JOIN students st ON st.id=tr.student_id JOIN users u ON u.id=tr.teacher_user_id
        WHERE ($1::uuid IS NULL OR tr.teacher_user_id=$1::uuid) AND ($2='superintendent' OR tr.school_id=$3)
        ORDER BY u.display_name,st.display_name ${pageSql(pgn)}`,[teacherUserId,req.actor.role,req.actor.schoolId]));
    res.json(paged(rows.rows,pgn));
  }catch(e){next(e)}
});
app.post("/api/rosters",requireSession,requireCsrf,async(req,res,next)=>{
  if(!["principal","superintendent"].includes(req.actor.role))return res.status(403).json({error:"roster_admin_required"});
  const {teacherUserId,studentId}=req.body||{};
  if(!validId(teacherUserId)||!validId(studentId))return res.status(400).json({error:"invalid_roster_entry"});
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const student=await client.query(`SELECT id,school_id FROM students WHERE id=$1 AND ($2='superintendent' OR school_id=$3)`,[studentId,req.actor.role,req.actor.schoolId]);
      if(!student.rowCount)return {status:404,error:"student_not_found"};
      const teacher=await client.query(`SELECT 1 FROM memberships WHERE user_id=$1 AND district_id=$2 AND role='teacher' AND status='active' AND school_id=$3`,
        [teacherUserId,req.actor.districtId,student.rows[0].school_id]);
      if(!teacher.rowCount)return {status:400,error:"teacher_not_at_student_school"};
      await client.query(`INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [req.actor.districtId,student.rows[0].school_id,teacherUserId,studentId,req.actor.userId]);
      await client.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
        VALUES($1,$2,$3,'roster_add','teacher_roster',$4,'success',$5,$6)`,[req.actor.districtId,req.actor.userId,req.actor.role,studentId,`teacher=${teacherUserId}`,req.requestId]);
      return {status:201};
    });
    if(result.status!==201)return res.status(result.status).json({error:result.error});
    res.status(201).json({added:true});
  }catch(e){next(e)}
});
app.delete("/api/rosters/:teacherUserId/:studentId",requireSession,requireCsrf,async(req,res,next)=>{
  if(!["principal","superintendent"].includes(req.actor.role))return res.status(403).json({error:"roster_admin_required"});
  if(!validId(req.params.teacherUserId)||!validId(req.params.studentId))return res.status(400).json({error:"invalid_roster_entry"});
  try{
    const removed=await withTenantTransaction(req.actor,async client=>{
      const del=await client.query(`DELETE FROM teacher_student_rosters WHERE teacher_user_id=$1 AND student_id=$2 AND ($3='superintendent' OR school_id=$4) RETURNING student_id`,
        [req.params.teacherUserId,req.params.studentId,req.actor.role,req.actor.schoolId]);
      if(!del.rowCount)return false;
      await client.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
        VALUES($1,$2,$3,'roster_remove','teacher_roster',$4,'success',$5,$6)`,[req.actor.districtId,req.actor.userId,req.actor.role,req.params.studentId,`teacher=${req.params.teacherUserId}`,req.requestId]);
      return true;
    });
    if(!removed)return res.status(404).json({error:"roster_entry_not_found"});
    res.json({removed:true});
  }catch(e){next(e)}
});

// ---- 32.0.53: FERPA record requests (export / delete) ----
// Export: superintendent (any school) or principal (own school). Delete:
// superintendent only, with the student number re-typed as confirmation.
app.post("/api/students/:studentId/records-export",requireSession,requireCsrf,async(req,res,next)=>{
  if(!["principal","superintendent"].includes(req.actor.role))return res.status(403).json({error:"records_officer_required"});
  if(!validId(req.params.studentId))return res.status(400).json({error:"invalid_student_id"});
  try{
    const record=await withTenantTransaction(req.actor,async client=>{
      const id=req.params.studentId;
      const student=await client.query(`SELECT id,local_student_number,display_name,grade_level,school_id,created_at FROM students WHERE id=$1 AND ($2='superintendent' OR school_id=$3)`,[id,req.actor.role,req.actor.schoolId]);
      if(!student.rowCount)return null;
      const q=(sql)=>client.query(sql,[id]).then(r=>r.rows);
      const out={exportedAt:new Date().toISOString(),student:student.rows[0],
        attendance:await q(`SELECT id,event_date,status,family_acknowledged_at FROM attendance_events WHERE student_id=$1 ORDER BY event_date`),
        submissions:await q(`SELECT sub.id,a.title,sub.response_text,sub.submitted_at,sub.score,sub.feedback,sub.graded_at FROM assignment_submissions sub JOIN assignments a ON a.id=sub.assignment_id WHERE sub.student_id=$1 ORDER BY sub.submitted_at`),
        cases:await q(`SELECT id,category,priority,status,title,summary,support_plan,family_visible,follow_up_at,created_at,closed_at FROM student_intervention_cases WHERE student_id=$1 ORDER BY created_at`),
        caseNotes:await q(`SELECT id,case_id,note,family_visible,created_at FROM student_case_notes WHERE student_id=$1 ORDER BY created_at`),
        familyMessages:await q(`SELECT id,sender_user_id,recipient_user_id,body,created_at,read_at FROM family_messages WHERE student_id=$1 ORDER BY created_at`),
        guardianLinks:await q(`SELECT l.user_id,u.display_name,l.relationship,l.status FROM student_user_links l JOIN users u ON u.id=l.user_id WHERE l.student_id=$1`),
        // 32.4.0 learner data (driver check-ins at stops only; no location data exists to export).
        transportAssignments:await q(`SELECT a.route_id,r.name AS route_name,a.stop_id,a.created_at,a.revoked_at FROM transport_rider_assignments a JOIN transport_routes r ON r.id=a.route_id WHERE a.student_id=$1 ORDER BY a.created_at`),
        transportCheckins:await q(`SELECT c.id,c.run_id,c.stop_id,c.event,c.note,c.recorded_at FROM transport_checkins c WHERE c.student_id=$1 ORDER BY c.recorded_at`),
        christieSessions:await q(`SELECT id,skill_id,status,hint_level,needs_adult,provider,started_at,last_activity_at,reviewed_at FROM christie_sessions WHERE student_id=$1 ORDER BY started_at`),
        christieTurns:await q(`SELECT t.session_id,t.seq,t.speaker,t.kind,t.body,t.created_at FROM christie_turns t JOIN christie_sessions s ON s.id=t.session_id WHERE s.student_id=$1 ORDER BY t.created_at,t.seq`),
        skillMastery:await q(`SELECT skill_id,mastery,attempts,updated_at FROM student_skill_mastery WHERE student_id=$1 ORDER BY skill_id`),
        commsThreads:await q(`SELECT t.id,t.subject,t.status,t.created_at,coalesce((SELECT json_agg(json_build_object('author',m.author_user_id,'body',CASE WHEN m.hidden_at IS NULL THEN m.body END,'hidden',m.hidden_at IS NOT NULL,'at',m.created_at) ORDER BY m.created_at) FROM comms_messages m WHERE m.thread_id=t.id),'[]'::json) AS messages FROM comms_threads t WHERE t.student_id=$1 ORDER BY t.created_at`),
        // 32.5.0: roll-call entries, pick-up adults/restrictions/early dismissals and the release log (no photos or ID numbers exist).
        safetyRollcall:await q(`SELECT incident_id,status,note,recorded_by,recorded_at FROM safety_rollcall_entries WHERE student_id=$1 ORDER BY recorded_at`),
        pickupAdults:await q(`SELECT id,full_name,relationship,kind,status,requested_at,decided_at FROM pickup_adults WHERE student_id=$1 ORDER BY requested_at`),
        pickupRestrictions:await q(`SELECT id,kind,person_name,detail,document_on_file,status,created_at,lifted_at FROM pickup_restrictions WHERE student_id=$1 ORDER BY created_at`),
        pickupEarlyDismissals:await q(`SELECT id,dismissal_date,dismissal_time,reason,status,requested_at FROM pickup_early_dismissals WHERE student_id=$1 ORDER BY requested_at`),
        pickupEvents:await q(`SELECT id,event,adult_id,id_checked,reason,incident_id,at FROM pickup_events WHERE student_id=$1 ORDER BY at`),
        // 32.6.0: learning core (courses, quizzes, mastery evidence, final grades, credentials, EDAL records about the learner).
        courseEnrollments:await q(`SELECT e.course_id,c.title,e.status,e.enrolled_at FROM course_enrollments e JOIN courses c ON c.id=e.course_id WHERE e.student_id=$1 ORDER BY e.enrolled_at`),
        quizAttempts:await q(`SELECT q.id,a.title,q.attempt_no,q.status,q.started_at,q.submitted_at,q.late,q.total_points,q.possible_points,coalesce((SELECT json_agg(json_build_object('item',r.item_id,'response',r.response,'auto',r.auto_points,'teacher',r.teacher_points,'comment',r.teacher_comment)) FROM quiz_responses r WHERE r.attempt_id=q.id),'[]'::json) AS responses FROM quiz_attempts q JOIN assignments a ON a.id=q.assignment_id WHERE q.student_id=$1 ORDER BY q.started_at`),
        accommodations:await q(`SELECT extra_time_pct,read_aloud,notes,updated_at FROM student_accommodations WHERE student_id=$1`),
        masteryEvidence:await q(`SELECT e.standard_id,ls.code,e.source,e.label,e.score,e.weight,e.observed_at FROM mastery_evidence e JOIN learning_standards ls ON ls.id=e.standard_id WHERE e.student_id=$1 ORDER BY e.observed_at`),
        standardMastery:await q(`SELECT m.standard_id,ls.code,m.mastery,m.level,m.evidence_count,m.mastered_at FROM standard_mastery m JOIN learning_standards ls ON ls.id=m.standard_id WHERE m.student_id=$1 ORDER BY ls.code`),
        finalGrades:await q(`SELECT f.id,c.title AS course,f.percent,f.letter,f.reason,f.supersedes,f.posted_at,f.edal_entry_id FROM course_final_grades f JOIN courses c ON c.id=f.course_id WHERE f.student_id=$1 ORDER BY f.posted_at`),
        credentials:await q(`SELECT id,kind,title,description,issued_at,revoked_at,revoke_reason,edal_entry_id FROM credentials WHERE student_id=$1 ORDER BY issued_at`),
        edalRecords:await q(`SELECT e.id,e.seq,e.kind,e.entry_hash,e.recorded_at,p.payload FROM edal_entries e LEFT JOIN edal_payloads p ON p.entry_id=e.id WHERE e.subject_student_id=$1 ORDER BY e.seq`),
        accessLog:await q(`SELECT occurred_at,actor_role,action,resource_type,outcome FROM audit_events WHERE resource_id=$1::text ORDER BY occurred_at`)};
      await client.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,request_id)
        VALUES($1,$2,$3,'export','student_record',$4,'success',$5)`,[req.actor.districtId,req.actor.userId,req.actor.role,id,req.requestId]);
      return out;
    });
    if(!record)return res.status(404).json({error:"student_not_found"});
    res.setHeader("Cache-Control","no-store");
    res.setHeader("Content-Disposition",`attachment; filename="eduos-student-record-${req.params.studentId}.json"`);
    res.json(record);
  }catch(e){next(e)}
});
app.post("/api/students/:studentId/records-delete",requireSession,requireCsrf,async(req,res,next)=>{
  if(req.actor.role!=="superintendent")return res.status(403).json({error:"superintendent_required"});
  if(!validId(req.params.studentId))return res.status(400).json({error:"invalid_student_id"});
  const {confirmLocalStudentNumber,reason}=req.body||{};
  if(!cleanText(confirmLocalStudentNumber,80)||typeof reason!=="string"||reason.trim().length<20||reason.trim().length>1000)
    return res.status(400).json({error:"invalid_deletion_request"});
  try{
    const result=await withTenantTransaction(req.actor,async client=>{
      const student=await client.query(`SELECT local_student_number FROM students WHERE id=$1`,[req.params.studentId]);
      if(!student.rowCount)return {status:404,error:"student_not_found"};
      if(student.rows[0].local_student_number!==confirmLocalStudentNumber.trim())return {status:409,error:"confirmation_mismatch"};
      const purged=await client.query(`SELECT eduos_purge_student($1) AS counts`,[req.params.studentId]);
      await client.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
        VALUES($1,$2,$3,'delete','student_record',$4,'success',$5,$6)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,req.params.studentId,JSON.stringify({reason:reason.trim(),counts:purged.rows[0].counts}),req.requestId]);
      return {status:200,counts:purged.rows[0].counts};
    });
    if(result.status!==200)return res.status(result.status).json({error:result.error});
    res.json({deleted:true,counts:result.counts});
  }catch(e){next(e)}
});

// ---- Phase 32.0.44: cross-profile flow events and signed outbound webhooks ----
// Flow events carry an allow-listed type, opaque references and counters only.
// Webhooks are disabled unless WEBHOOK_SIGNING_KEY is configured (fail closed).
// 32.2.0: both limiters are abuse protections, configurable (docs/LIMITS.md).
const flowLimiter=rateLimit({windowMs:60_000,limit:config.flowEventRateLimit,standardHeaders:true,legacyHeaders:false});
const webhookAdminLimiter=rateLimit({windowMs:15*60_000,limit:config.webhookAdminRateLimit,standardHeaders:true,legacyHeaders:false});
// 32.2.0: no fixed number of subscriptions (was 10). A district may set its own
// cap in district_settings.max_active_webhooks (NULL = unlimited). Deliveries
// to every matching subscription are queued behind a concurrency bound instead
// of being dropped when the dispatcher was busy.
const webhookSlots=[];
async function acquireWebhookSlot(){
  if(webhooksInFlight<config.webhookMaxInFlight){webhooksInFlight++;return;}
  await new Promise(resolve=>webhookSlots.push(resolve));
}
function releaseWebhookSlot(){const next=webhookSlots.shift();if(next)next();else webhooksInFlight--;}
let webhooksInFlight=0;
const webhookOptions=()=>({allowInsecureLoopback:config.webhookAllowInsecureLoopback,allowedHosts:config.webhookAllowedHosts});
const tenantActor=actor=>({districtId:actor.districtId,userId:actor.userId,role:actor.role,schoolId:actor.schoolId||null});
const webhooksEnabled=(_req,res,next)=>config.webhookSigningKey?next():res.status(503).json({error:"webhooks_not_configured"});
const validWebhookEventTypes=list=>Array.isArray(list)&&list.length>=1&&list.length<=16&&new Set(list).size===list.length&&
  ((list.length===1&&list[0]==="*")||list.every(type=>isFlowEventType(type)&&type!=="webhook.test"));

// subjectStudentId limits family visibility to the learner's linked guardians
// and the learner; it is stored only for feed filtering, never sent in webhooks.
async function recordFlowEvent(actor,event,schoolId,subjectStudentId=null){
  return withTenantTransaction(actor,async client=>{
    const inserted=await client.query(
      `INSERT INTO flow_events(district_id,school_id,actor_user_id,actor_role,event_type,audience,source,refs,counts,subject_student_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10) RETURNING id,occurred_at`,
      [actor.districtId,schoolId||null,actor.userId,actor.role,event.type,event.audience,event.source,
       JSON.stringify(event.refs),JSON.stringify(event.counts),subjectStudentId]
    );
    const saved={id:inserted.rows[0].id,occurredAt:new Date(inserted.rows[0].occurred_at).toISOString(),type:event.type,source:event.source,
      actorRole:actor.role,audience:event.audience,districtId:actor.districtId,refs:event.refs,counts:event.counts};
    if(config.webhookSigningKey){
      const subscriptions=await client.query(
        `SELECT id FROM webhook_subscriptions WHERE status='active' AND ($1=ANY(event_types) OR '*'=ANY(event_types)) ORDER BY created_at`,[event.type]);
      const payload=JSON.stringify(webhookPayload(saved));
      for(const sub of subscriptions.rows) await client.query(
        `INSERT INTO webhook_outbox(district_id,subscription_id,event_id,event_type,payload)
         VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(district_id,subscription_id,event_id) DO NOTHING`,
        [actor.districtId,sub.id,saved.id,event.type,payload]);
    }
    return saved;
  });
}

// "Send test" delivery for one subscription (POST /api/webhooks/:id/test).
// Restored in the 37.4.0 audit: the endpoint has called this since 37.3.0, but
// the function was dropped when the outbox replaced direct delivery, so every
// test returned 500. One signed webhook.test payload, attempted synchronously
// (no outbox), recorded in the delivery ledger and shown as the subscription's
// last delivery (the webhooks screen's "Last delivery" column). A test result
// never changes the failure count or status, so it can't disable or re-arm it.
async function deliverToSubscription(actor,subscription,event,_eventId=null,maxAttempts=1){
  const deliveryId=crypto.randomUUID();
  const attempts=await deliverWebhook({subscription,secret:deriveWebhookSecret(config.webhookSigningKey,subscription.id),
    eventType:event.type,deliveryId,body:JSON.stringify(webhookPayload(event)),options:{...webhookOptions(),maxAttempts}});
  await withTenantTransaction(actor,async client=>{
    for(const a of attempts) await client.query(
      `INSERT INTO webhook_deliveries(district_id,subscription_id,delivery_id,event_id,event_type,attempt,outcome,status_code,duration_ms)
       VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [actor.districtId,subscription.id,deliveryId,event.type,a.attempt,a.outcome,a.statusCode,a.durationMs]);
    await client.query(`UPDATE webhook_subscriptions SET last_delivery_at=now(),last_outcome=$2 WHERE id=$1`,
      [subscription.id,attempts[attempts.length-1].outcome]);
  });
  return attempts[attempts.length-1];
}

// Durable outbox worker: src/webhook-outbox.js (extracted for lifecycle tests).
async function processWebhookOutbox(actorInput,{limit=10}={}){
  return processOutbox(actorInput,{limit},{withTenantTransaction,signingKey:config.webhookSigningKey,deliveryOptions:webhookOptions()});
}

function dispatchFlowWebhooks(actorInput,_event){
  if(!config.webhookSigningKey)return;
  processWebhookOutbox(actorInput,{limit:10}).catch(error=>console.error('Webhook outbox dispatch failed',{message:error.message}));
}

// Event recording and outbox insertion commit together; request-side delivery
// is merely a latency optimization. Pending jobs remain recoverable on later
// authenticated activity in this district.
function emitServerFlow(req,type,resourceId,schoolId,subjectStudentId=null){
  const event=serverFlowEvent(type,req.actor.role,resourceId); if(!event)return;
  const actor=tenantActor(req.actor);
  recordFlowEvent(actor,event,schoolId,subjectStudentId)
    .then(saved=>dispatchFlowWebhooks(actor,saved))
    .catch(error=>console.error('Flow event not recorded',{requestId:req.requestId,message:error.message}));
}

app.get("/api/flow-events",requireSession,requirePermission("flow_events","read"),async(req,res,next)=>{
  const pgn=pageOf(req);
  try{
    const rows=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT id,event_type,actor_role,audience,source,refs,counts,occurred_at
         FROM flow_events
        WHERE ($1=ANY(audience) OR actor_user_id=$2)
          AND (
            $1 IN ('superintendent','it_admin') OR actor_user_id=$2
            OR ($1 IN ('principal','teacher') AND (school_id IS NULL OR school_id=$3)
                AND ($1<>'teacher' OR subject_student_id IS NULL OR ${rosterSql("subject_student_id","$2")}))
            OR ($1 IN ('parent','pupil') AND (
              CASE WHEN subject_student_id IS NOT NULL THEN EXISTS(
                SELECT 1 FROM student_user_links l WHERE l.student_id=flow_events.subject_student_id AND l.user_id=$2 AND l.status='active'
                  AND (($1='parent' AND l.relationship IN ('parent','guardian')) OR ($1='pupil' AND l.relationship='pupil')))
              ELSE (school_id IS NULL OR school_id=$3 OR school_id IN (
                SELECT st.school_id FROM student_user_links l JOIN students st ON st.id=l.student_id
                 WHERE l.user_id=$2 AND l.status='active'))
              END))
          )
        ORDER BY occurred_at DESC ${pageSql(pgn)}`,
      [req.actor.role,req.actor.userId,req.actor.schoolId]
    ));
    res.setHeader("Cache-Control","no-store");
    const pageOut=paged(rows.rows,pgn);
    res.json({...pageOut,data:pageOut.data.map(r=>({id:r.id,type:r.event_type,actorRole:r.actor_role,audience:r.audience,source:r.source,refs:r.refs,counts:r.counts,occurredAt:r.occurred_at}))});
    // Authenticated feed activity also recovers pending jobs after a restart.
    dispatchFlowWebhooks(req.actor,null);
  }catch(e){next(e)}
});

app.post("/api/flow-events",flowLimiter,requireSession,requireCsrf,requirePermission("flow_events","create"),async(req,res,next)=>{
  const event=normalizeFlowEvent(req.body,req.actor.role);
  if(!event)return res.status(400).json({error:"invalid_flow_event"});
  try{
    const saved=await recordFlowEvent(req.actor,event,req.actor.schoolId);
    await writeAudit(req.actor,{action:"flow_event",resourceType:"flow_event",resourceId:saved.id,outcome:"recorded",
      detail:`type=${event.type};source=${event.source}`,requestId:req.requestId});
    res.status(201).json({recorded:true,id:saved.id,audience:event.audience});
    dispatchFlowWebhooks(req.actor,saved);
  }catch(e){next(e)}
});

app.get("/api/webhooks",requireSession,requirePermission("webhooks","read"),async(req,res,next)=>{
  const pgn=pageOf(req);
  try{
    const rows=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT id,url,event_types,status,failure_count,last_delivery_at,last_outcome,created_at
         FROM webhook_subscriptions ORDER BY created_at DESC ${pageSql(pgn)}`
    ));
    res.setHeader("Cache-Control","no-store");
    const pageOut=paged(rows.rows,pgn);
    res.json({enabled:Boolean(config.webhookSigningKey),eventTypes:Object.keys(FLOW_EVENT_TYPES).filter(type=>type!=="webhook.test"),page:pageOut.page,
      data:pageOut.data.map(r=>({id:r.id,url:r.url,eventTypes:r.event_types,status:r.status,failureCount:r.failure_count,lastDeliveryAt:r.last_delivery_at,lastOutcome:r.last_outcome,createdAt:r.created_at}))});
  }catch(e){next(e)}
});

app.post("/api/webhooks",webhookAdminLimiter,requireSession,requireCsrf,requirePermission("webhooks","manage"),webhooksEnabled,async(req,res,next)=>{
  const body=req.body||{};
  if(Object.keys(body).some(key=>!["url","eventTypes"].includes(key))||!validWebhookEventTypes(body.eventTypes))
    return res.status(400).json({error:"invalid_webhook_payload"});
  const checked=validateWebhookUrl(body.url,webhookOptions());
  if(!checked.ok)return res.status(400).json({error:"webhook_url_not_allowed",reason:checked.reason});
  try{
    const target=await resolveWebhookTarget(checked.url,webhookOptions());
    if(!target.ok)return res.status(400).json({error:"webhook_url_not_allowed",reason:target.reason});
    const href=checked.url.href;
    const created=await withTenantTransaction(req.actor,async client=>{
      const existing=await client.query(`SELECT url FROM webhook_subscriptions WHERE status='active' FOR UPDATE`);
      const cap=await districtCap(client,req.actor.districtId,"max_active_webhooks");
      if(cap!==null&&existing.rowCount>=cap)return {error:"webhook_limit_reached"};
      if(existing.rows.some(row=>row.url===href))return {error:"webhook_already_registered"};
      const inserted=await client.query(
        `INSERT INTO webhook_subscriptions(district_id,created_by,url,event_types) VALUES($1,$2,$3,$4)
         RETURNING id,url,event_types,status,created_at`,
        [req.actor.districtId,req.actor.userId,href,body.eventTypes]
      );
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
         VALUES($1,$2,$3,'create','webhook_subscription',$4,'success',$5,$6)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,inserted.rows[0].id,`host=${checked.host};events=${body.eventTypes.join(",")}`,req.requestId]
      );
      return {row:inserted.rows[0]};
    });
    if(created.error)return res.status(409).json({error:created.error});
    const row=created.row;
    res.setHeader("Cache-Control","no-store");
    // The signing secret is shown once, at creation. It is derived, not stored.
    res.status(201).json({
      data:{id:row.id,url:row.url,eventTypes:row.event_types,status:row.status,createdAt:row.created_at},
      secret:deriveWebhookSecret(config.webhookSigningKey,row.id),
      signature:{header:"X-EduOS-Signature",format:"t=<unix seconds>,v1=<hex hmac-sha256(secret, t + \".\" + raw body)>",toleranceSeconds:300}
    });
  }catch(e){next(e)}
});

app.delete("/api/webhooks/:webhookId",webhookAdminLimiter,requireSession,requireCsrf,requirePermission("webhooks","manage"),async(req,res,next)=>{
  if(!validId(req.params.webhookId))return res.status(400).json({error:"invalid_webhook_id"});
  try{
    const disabled=await withTenantTransaction(req.actor,async client=>{
      const updated=await client.query(
        `UPDATE webhook_subscriptions SET status='disabled',disabled_at=now(),disabled_by=$2
          WHERE id=$1 AND status='active' RETURNING id`,
        [req.params.webhookId,req.actor.userId]
      );
      if(!updated.rowCount)return false;
      await client.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,request_id)
         VALUES($1,$2,$3,'disable','webhook_subscription',$4,'success',$5)`,
        [req.actor.districtId,req.actor.userId,req.actor.role,req.params.webhookId,req.requestId]
      );
      return true;
    });
    if(!disabled)return res.status(404).json({error:"webhook_not_found"});
    res.json({disabled:true});
  }catch(e){next(e)}
});

app.post("/api/webhooks/:webhookId/test",webhookAdminLimiter,requireSession,requireCsrf,requirePermission("webhooks","manage"),webhooksEnabled,async(req,res,next)=>{
  if(!validId(req.params.webhookId))return res.status(400).json({error:"invalid_webhook_id"});
  try{
    const found=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT id,url FROM webhook_subscriptions WHERE id=$1 AND status='active'`,[req.params.webhookId]
    ));
    if(!found.rowCount)return res.status(404).json({error:"webhook_not_found"});
    const event={id:crypto.randomUUID(),type:"webhook.test",occurredAt:new Date().toISOString(),source:"server",
      actorRole:req.actor.role,audience:["superintendent","it_admin"],districtId:req.actor.districtId,refs:{},counts:{}};
    const final=await deliverToSubscription(tenantActor(req.actor),found.rows[0],event,null,1);
    await writeAudit(req.actor,{action:"test",resourceType:"webhook_subscription",resourceId:req.params.webhookId,
      outcome:final.outcome==="delivered"?"success":"failure",detail:`outcome=${final.outcome}`,requestId:req.requestId});
    res.json({outcome:final.outcome,statusCode:final.statusCode});
  }catch(e){next(e)}
});

app.get("/api/webhooks/:webhookId/deliveries",requireSession,requirePermission("webhooks","read"),async(req,res,next)=>{
  const pgn=pageOf(req);
  if(!validId(req.params.webhookId))return res.status(400).json({error:"invalid_webhook_id"});
  try{
    const rows=await withTenantTransaction(req.actor,client=>client.query(
      `SELECT delivery_id,event_type,attempt,outcome,status_code,duration_ms,occurred_at
         FROM webhook_deliveries WHERE subscription_id=$1 ORDER BY occurred_at DESC,attempt DESC ${pageSql(pgn)}`,
      [req.params.webhookId]
    ));
    res.setHeader("Cache-Control","no-store");
    const pageOut=paged(rows.rows,pgn);
    res.json({...pageOut,data:pageOut.data.map(r=>({deliveryId:r.delivery_id,eventType:r.event_type,attempt:r.attempt,outcome:r.outcome,statusCode:r.status_code,durationMs:r.duration_ms,occurredAt:r.occurred_at}))});
  }catch(e){next(e)}
});

// 32.1.0: schools, users and memberships (district administration).
registerAdminRoutes(app);
registerMeshRoutes(app,{emitServerFlow});
registerHomeRoutes(app);
registerBrandingRoutes(app,{emitServerFlow});
// 32.4.0: mobile role apps (transport, Christie tutor, Comms Hub).
registerTransportRoutes(app);
registerChristieRoutes(app);
registerCommsRoutes(app);
registerSafetyRoutes(app);
registerPickupRoutes(app);
registerArrivalRoutes(app);
registerArrivalExceptionRoutes(app);
registerLearningRoutes(app);
registerEdalRoutes(app);
registerLibraryRoutes(app);
registerLibraryCirculationRoutes(app);
registerLibraryIntelligenceRoutes(app);
registerSchoolOperationsRoutes(app);
registerUnifiedSchoolOperationsRoutes(app);
registerSchoolOperationsAutomationRoutes(app);
registerSchoolOperationsNotificationRoutes(app);
registerStaffDailyWorkspaceRoutes(app);
registerStaffManagementRoutes(app);
registerEdgeDeviceRoutes(app);
registerEdgeUpdateRoutes(app);
// 32.7.0 EDEN: a district hub or a school node (EDUOS_NODE_TIER).
const edenStatus = config.nodeTier === "district" ? registerEdenHub(app) : config.nodeTier === "school" ? registerEdenNode(app) : null;
app.get("/api/eden/tier",requireSession,(req,res)=>{res.setHeader("Cache-Control","no-store");res.json({data:{tier:config.nodeTier||"classic",enabled:Boolean(edenStatus?.enabled),reason:edenStatus?.reason||null}})});

// Serve the integrated single-origin EduOS interface after API routes.
app.use(express.static(publicDir, { index: "index.html", fallthrough: true, etag: true, setHeaders:(res,p)=>{ if(/\.html?$/.test(p)||/[\\/]app[\\/]/.test(p)||/\.webmanifest$/.test(p)) res.setHeader("Cache-Control","no-cache"); else res.setHeader("Cache-Control","public, max-age=604800"); } }));

// 32.4.0: the mobile app is a single page under /app/; deep links load its shell.
app.get(/^\/app(\/.*)?$/,(req,res,next)=>{ if(req.path.includes("."))return next(); res.setHeader("Cache-Control","no-cache"); res.sendFile(path.join(publicDir,"app","index.html")); });

app.use((err,req,res,_next)=>{
  // Client errors from body parsing are reported as such, not as 500s.
  if(err?.type==="entity.parse.failed")return res.status(400).json({error:"invalid_json",requestId:req.requestId});
  if(err?.type==="entity.too.large")return res.status(413).json({error:"payload_too_large",requestId:req.requestId});
  if(Number.isInteger(err?.status)&&err.status>=400&&err.status<500&&err.expose)
    return res.status(err.status).json({error:"bad_request",requestId:req.requestId});
  console.error("Request failed", {requestId:req.requestId, message:err.message});
  res.status(500).json({error:"internal_server_error",requestId:req.requestId});
});

export { app };

// Start only when run directly (tests import the app without listening).
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  try{await assertSafeRuntimeRole();await assertSchemaReady();}
  catch(error){console.error(error.message);process.exit(1);}
  app.listen(config.port,()=>{
    console.log(`EduOS API listening on ${config.port}${config.nodeTier?` (EDEN ${config.nodeTier} tier)`:""}`);
    if(config.nodeTier==="school"&&process.env.EDEN_AGENT!=="off")startAgent();
  });
}
