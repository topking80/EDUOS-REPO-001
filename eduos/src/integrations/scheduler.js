// SIS-02 durable scheduled roster-sync worker.
// Runs as a district-scoped service principal. It never impersonates a user.
import crypto from "node:crypto";
import { pool } from "../db.js";
import { config } from "../config.js";
import { decryptSecret } from "./secrets.js";
import * as oneroster from "./oneroster.js";
import * as edfi from "./edfi.js";
import * as powerschool from "./powerschool.js";
import { loadPlanInputs, planImport, applyPlan } from "./sync.js";

const KINDS = { oneroster, edfi, powerschool };
export const SYNC_JOB_LEASE_SECONDS = 300;
export const SYNC_JOB_MAX_ATTEMPTS = 5;
const urlOptions = () => ({ allowInsecureLoopback: config.integrationsAllowInsecureLoopback, allowedHosts: config.integrationsAllowedHosts });

// Service transactions intentionally set only the tenant boundary. The
// service identity is represented in immutable actor columns, not app.user_id.
export function schedulerTenantTransaction(db = pool) {
  return async (districtId, callback) => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.district_id',$1,true)", [String(districtId)]);
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  };
}

async function enqueueDue(tx, districtId) {
  return tx(districtId, async c => {
    const due = await c.query(
      `SELECT id,connector_id,config_version,interval_minutes
         FROM integration_sync_schedules
        WHERE district_id=$1 AND enabled=true AND paused_at IS NULL AND next_run_at<=now()
        ORDER BY next_run_at,id FOR UPDATE SKIP LOCKED LIMIT 10`, [districtId]);
    for (const s of due.rows) {
      await c.query(
        `INSERT INTO integration_sync_jobs(district_id,connector_id,schedule_id,config_version)
         VALUES($1,$2,$3,$4)`, [districtId,s.connector_id,s.id,s.config_version]);
      await c.query(
        `UPDATE integration_sync_schedules SET next_run_at=now()+make_interval(mins=>$2),updated_at=now()
          WHERE id=$1 AND district_id=$3`, [s.id,s.interval_minutes,districtId]);
    }
    return due.rowCount;
  });
}

async function claimJob(tx, districtId) {
  return tx(districtId, async c => {
    const picked = await c.query(
      `SELECT id FROM integration_sync_jobs
        WHERE district_id=$1 AND attempts<$2
          AND ((status='pending' AND available_at<=now()) OR (status='processing' AND lease_until<now()))
        ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      [districtId,SYNC_JOB_MAX_ATTEMPTS]);
    if (!picked.rowCount) return null;
    const token = crypto.randomUUID();
    const claimed = await c.query(
      `UPDATE integration_sync_jobs SET status='processing',attempts=attempts+1,
          lease_until=now()+make_interval(secs=>$3),lease_token=$2,
          started_at=COALESCE(started_at,now())
        WHERE id=$1 AND district_id=$4
        RETURNING id,connector_id,schedule_id,config_version,attempts,lease_token`,
      [picked.rows[0].id,token,SYNC_JOB_LEASE_SECONDS,districtId]);
    return claimed.rows[0] || null;
  });
}

async function finishJob(tx, districtId, job, status, error = null, retry = false) {
  return tx(districtId, c => c.query(
    `UPDATE integration_sync_jobs SET status=$3,last_error=$4,
        available_at=CASE WHEN $5 THEN now()+make_interval(secs=>$6) ELSE available_at END,
        lease_until=NULL,lease_token=NULL,finished_at=CASE WHEN $3 IN ('completed','failed','cancelled') THEN now() ELSE NULL END
      WHERE id=$1 AND district_id=$2 AND status='processing' AND lease_token=$7`,
    [job.id,districtId,retry?'pending':status,error, retry,
      Math.min(3600,15*Math.pow(2,Math.max(0,job.attempts-1))),job.lease_token]));
}

export async function processScheduledSisSync(job, { db = pool, tx = schedulerTenantTransaction(db), log = console } = {}) {
  const districtId = job.district_id;
  const serviceActorId = await tx(districtId, async c => {
    const actor = await c.query("SELECT id FROM integration_service_actors WHERE actor_key='sis_scheduler'");
    if (!actor.rowCount) throw new Error("sis_scheduler_service_actor_missing");
    return actor.rows[0].id;
  });
  const input = await tx(districtId, async c => {
    const r = await c.query(
      `SELECT j.id,j.connector_id,j.schedule_id,j.config_version,j.attempts,j.lease_token,
              s.enabled,s.paused_at,s.config_version AS schedule_version,
              x.kind,x.status,x.config_version AS connector_version,x.base_url,x.token_url,
              x.client_id,x.client_secret_enc,x.scope
         FROM integration_sync_jobs j
         JOIN integration_sync_schedules s ON s.id=j.schedule_id AND s.district_id=j.district_id
         JOIN integration_connectors x ON x.id=j.connector_id AND x.district_id=j.district_id
        WHERE j.id=$1 AND j.district_id=$2 AND j.status='processing' AND j.lease_token=$3`,
      [job.id,districtId,job.lease_token]);
    return r.rows[0] || null;
  });
  if (!input || !input.enabled || input.paused_at || input.status!=="active"
      || input.config_version!==input.connector_version || input.config_version!==input.schedule_version) {
    await finishJob(tx,districtId,job,"cancelled","schedule_or_connector_no_longer_approved");
    return {status:"cancelled"};
  }

  let roster;
  try {
    const mapped = await tx(districtId,c=>c.query(
      "SELECT external_id FROM integration_school_map WHERE district_id=$1 AND connector_id=$2 ORDER BY external_id",
      [districtId,input.connector_id]));
    roster = await KINDS[input.kind].fetchRoster({
      baseUrl:input.base_url,tokenUrl:input.token_url,clientId:input.client_id,
      clientSecret:decryptSecret(config.integrationsKey,districtId,input.connector_id,input.client_secret_enc),
      scope:input.scope,options:urlOptions(),mappedSchoolIds:mapped.rows.map(x=>x.external_id),
      maxStudentRecords:config.powerschoolMaxStudents
    });
  } catch (error) {
    const retry = Number(job.attempts)<SYNC_JOB_MAX_ATTEMPTS;
    await finishJob(tx,districtId,job,retry?"pending":"failed",
      String(error.code||"connector_fetch_failed").slice(0,300),retry);
    log.error?.("Scheduled SIS connector fetch failed",{jobId:job.id,code:error.code||"connector_fetch_failed"});
    return {status:retry?"retry":"failed"};
  }

  const runId=crypto.randomUUID();
  try {
    const result = await tx(districtId,async c=>{
      await c.query("SELECT pg_advisory_xact_lock(hashtext('integration-sync'),hashtext($1))",[input.connector_id]);
      const current=await c.query(
        `SELECT x.status,x.config_version,s.enabled,s.paused_at,s.config_version AS schedule_version,
                j.status AS job_status,j.lease_token,j.lease_until
           FROM integration_connectors x
           JOIN integration_sync_schedules s ON s.connector_id=x.id AND s.district_id=x.district_id
           JOIN integration_sync_jobs j ON j.schedule_id=s.id AND j.district_id=s.district_id
          WHERE x.id=$1 AND x.district_id=$2 AND s.id=$3 AND j.id=$4 FOR UPDATE OF x,s,j`,
        [input.connector_id,districtId,input.schedule_id,job.id]);
      const v=current.rows[0];
      if(!v||v.status!=="active"||!v.enabled||v.paused_at||v.config_version!==input.config_version
         ||v.schedule_version!==input.config_version||v.job_status!=="processing"
         ||v.lease_token!==job.lease_token||!v.lease_until||new Date(v.lease_until)<=new Date())
        throw Object.assign(new Error("scheduled_sync_approval_or_lease_changed"),{code:"SCHEDULE_STALE"});
      const inputs=await loadPlanInputs(c,districtId,input.connector_id,roster.students.map(s=>s.localStudentNumber));
      const plan=planImport(roster,inputs.map,inputs.existing,inputs.schools);
      const actor={districtId,userId:null,serviceActorId,role:"sis_scheduler",schoolId:null};
      const imported=await applyPlan(c,actor,{kind:input.kind,id:input.connector_id},runId,plan,job.id);
      await c.query(
        `INSERT INTO integration_sync_runs(id,district_id,connector_id,mode,status,started_by,started_by_service,started_at,finished_at,counts,rejected)
         VALUES($1,$2,$3,'apply','completed',NULL,$4,now(),now(),$5::jsonb,$6::jsonb)`,
        [runId,districtId,input.connector_id,serviceActorId,JSON.stringify({...plan.counts,imported}),JSON.stringify(plan.rejected)]);
      await c.query("UPDATE integration_connectors SET last_sync_at=now(),last_sync_status='completed' WHERE id=$1",[input.connector_id]);
      await c.query(
        `INSERT INTO audit_events(district_id,actor_user_id,actor_service_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
         VALUES($1,NULL,$2,'sis_scheduler','scheduled_sync','integration_connector',$3,'success',$4,$5)`,
        [districtId,serviceActorId,input.connector_id,JSON.stringify({runId,jobId:job.id,configVersion:input.config_version}),job.id]);
      const settled=await c.query(
        `UPDATE integration_sync_jobs SET status='completed',lease_until=NULL,lease_token=NULL,finished_at=now(),last_error=NULL
          WHERE id=$1 AND district_id=$2 AND status='processing' AND lease_token=$3`,
        [job.id,districtId,job.lease_token]);
      if(!settled.rowCount) throw Object.assign(new Error("scheduled_sync_lease_lost"),{code:"SCHEDULE_STALE"});
      return {runId,counts:plan.counts,imported};
    });
    return {status:"completed",...result};
  } catch(error) {
    if(error.code==="SCHEDULE_STALE") {
      await finishJob(tx,districtId,job,"cancelled","schedule_or_lease_changed");
      return {status:"cancelled"};
    }
    const retry=Number(job.attempts)<SYNC_JOB_MAX_ATTEMPTS;
    await finishJob(tx,districtId,job,retry?"pending":"failed",
      String(error.code||"scheduled_sync_failed").slice(0,300),retry);
    log.error?.("Scheduled SIS sync failed",{jobId:job.id,code:error.code||"scheduled_sync_failed"});
    return {status:retry?"retry":"failed"};
  }
}

export async function dispatchScheduledSisSync({db=pool,maxJobsPerDistrict=20,log=console}={}) {
  if(!config.integrationsKey) return {skipped:"integrations_disabled",claimed:0};
  const tx=schedulerTenantTransaction(db);
  const districts=(await db.query("SELECT id FROM districts WHERE status='active' ORDER BY id")).rows;
  let claimed=0;
  for(const {id:districtId} of districts) {
    await enqueueDue(tx,districtId);
    for(let n=0;n<maxJobsPerDistrict;n++) {
      const job=await claimJob(tx,districtId);
      if(!job) break;
      claimed++;
      await processScheduledSisSync({...job,district_id:districtId},{db,tx,log});
    }
  }
  return {claimed};
}
