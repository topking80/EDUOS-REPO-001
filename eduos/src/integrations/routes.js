// District integrations: OneRoster 1.2 and Ed-Fi connectors (db/040).
//
// EduOS doesn't depend on any of them. Nothing runs unless INTEGRATIONS_KEY is
// set, a district lead adds a connector and a different district lead approves
// it; syncs run manually (preview first, then apply) or on a separately approved schedule. Connectors
// only read from the external system, and imports go through the same rules
// as the SIS CSV import.
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import { requireSession, requireCsrf } from "../auth.js";
import { withTenantTransaction } from "../db.js";
import { HttpError, audit, rows, one, validId, cleanText, sendError } from "../role-app-util.js";
import { encryptSecret, decryptSecret } from "./secrets.js";
import { checkUrl, IntegrationError } from "./http.js";
import * as oneroster from "./oneroster.js";
import * as edfi from "./edfi.js";
import * as powerschool from "./powerschool.js";
import * as canvas from "./canvas.js";
import { registerCanvasOAuthRoutes } from "./canvas-oauth.js";
import { planImport, loadPlanInputs, applyPlan } from "./sync.js";

const MANAGERS = ["superintendent", "it_admin"];
const KINDS = { oneroster, edfi, powerschool, canvas };
const COLS = `c.id, c.kind, c.name, c.base_url, c.token_url, c.client_id, c.scope, c.data_scope, c.status, c.created_at, c.updated_at,
  c.approved_at, c.disabled_at, c.last_sync_at, c.last_sync_status, uu.display_name AS updated_by_name, ua.display_name AS approved_by_name, c.updated_by`;
const FROM = `FROM integration_connectors c JOIN users uu ON uu.id=c.updated_by LEFT JOIN users ua ON ua.id=c.approved_by`;
const urlOptions = () => ({ allowInsecureLoopback: config.integrationsAllowInsecureLoopback, allowedHosts: config.integrationsAllowedHosts });

async function cancelScheduleJobs(client,districtId,scheduleId,reason){
  return client.query(
    `UPDATE integration_sync_jobs SET status='cancelled',lease_until=NULL,lease_token=NULL,
       finished_at=now(),last_error=$3
      WHERE district_id=$1 AND schedule_id=$2 AND status IN ('pending','processing')`,
    [districtId,scheduleId,String(reason||"schedule_changed").slice(0,300)]);
}

async function invalidateScheduleForConnector(client,districtId,connectorId,reason){
  await client.query(
    `UPDATE integration_sync_schedules SET enabled=false,next_run_at=NULL,paused_at=now(),approved_by=NULL,approved_at=NULL,
       pause_reason=$3,updated_at=now()
      WHERE district_id=$1 AND connector_id=$2`,
    [districtId,connectorId,String(reason||"connector_approval_changed").slice(0,240)]);
  await client.query(
    `UPDATE integration_sync_jobs SET status='cancelled',lease_until=NULL,lease_token=NULL,
       finished_at=now(),last_error=$3
      WHERE district_id=$1 AND connector_id=$2 AND status IN ('pending','processing')`,
    [districtId,connectorId,String(reason||"connector_approval_changed").slice(0,300)]);
}

const managerRole = (req,res,next) => {
  if (!MANAGERS.includes(req.actor?.role)) return res.status(403).json({ error: "integrations_access_denied" });
  next();
};
const manager = (req, res, next) => {
  if (!MANAGERS.includes(req.actor?.role)) return res.status(403).json({ error: "integrations_access_denied" });
  if (!config.integrationsKey) return res.status(503).json({ error: "integrations_disabled", hint: "Set INTEGRATIONS_KEY (32+ characters) on the server to use integrations." });
  next();
};

function readFields(b, partial) {
  const out = {};
  const bad = (f) => { throw new HttpError(400, "invalid_connector", { field: f }); };
  if (!partial || b.kind !== undefined) { if (!KINDS[b.kind]) bad("kind"); out.kind = b.kind; }
  if (!partial || b.name !== undefined) { if (!cleanText(b.name, 80)) bad("name"); out.name = b.name.trim(); }
  for (const [k, col] of [["baseUrl", "base_url"], ["tokenUrl", "token_url"]]) {
    if (!partial || b[k] !== undefined) {
      if (typeof b[k] !== "string") bad(k);
      try { checkUrl(b[k].trim(), urlOptions()); } catch { bad(k); }
      out[col] = b[k].trim();
    }
  }
  if (!partial || b.clientId !== undefined) { if (!cleanText(b.clientId, 300)) bad("clientId"); out.client_id = b.clientId.trim(); }
  if (!partial || b.clientSecret !== undefined) { if (!cleanText(b.clientSecret, 2000)) bad("clientSecret"); out.secret = b.clientSecret.trim(); }
  if (b.scope !== undefined && b.scope !== null && b.scope !== "") { if (!cleanText(b.scope, 1000)) bad("scope"); out.scope = b.scope.trim(); }
  else if (b.scope === null || b.scope === "") out.scope = null;
  return out;
}

const shape = (c) => c && ({ id: c.id, kind: c.kind, name: c.name, baseUrl: c.base_url, tokenUrl: c.token_url, clientId: c.client_id, scope: c.scope,
  dataScope: c.data_scope, status: c.status, updatedBy: c.updated_by_name, updatedAt: c.updated_at, approvedBy: c.approved_by_name, approvedAt: c.approved_at,
  disabledAt: c.disabled_at, lastSyncAt: c.last_sync_at, lastSyncStatus: c.last_sync_status, hasSecret: true });

export function registerIntegrationRoutes(app) {
  const syncLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `integration-sync:${req.actor?.userId}` });
  const base = "/api/integrations/connectors";

  app.get(base, requireSession, async (req, res, next) => {
    if (!MANAGERS.includes(req.actor.role)) return res.status(403).json({ error: "integrations_access_denied" });
    if (!config.integrationsKey) return res.json({ data: { enabled: false, connectors: [] } });
    try {
      const data = await withTenantTransaction(req.actor, async (c) => {
        const list = await rows(c, `SELECT ${COLS} ${FROM} WHERE c.district_id=$1 ORDER BY c.name`, [req.actor.districtId]);
        const maps = await rows(c, `SELECT m.connector_id, m.external_id, m.school_id, s.name AS school_name FROM integration_school_map m
          JOIN schools s ON s.id=m.school_id WHERE m.district_id=$1 ORDER BY s.name`, [req.actor.districtId]);
        const schools = await rows(c, "SELECT id, name FROM schools WHERE district_id=$1 AND status='active' ORDER BY name", [req.actor.districtId]);
        return { enabled: true, schools, connectors: list.map(x => ({ ...shape(x), canApprove: x.updated_by !== req.actor.userId,
          schoolMap: maps.filter(m => m.connector_id === x.id).map(m => ({ externalId: m.external_id, schoolId: m.school_id, schoolName: m.school_name })) })) };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post(base, requireSession, requireCsrf, manager, async (req, res, next) => {
    try {
      const f = readFields(req.body || {}, false);
      const data = await withTenantTransaction(req.actor, async (c) => {
        const a = req.actor, id = crypto.randomUUID();
        if (await one(c, "SELECT 1 FROM integration_connectors WHERE district_id=$1 AND name=$2", [a.districtId, f.name])) throw new HttpError(409, "connector_name_taken");
        await c.query(`INSERT INTO integration_connectors(id, district_id, kind, name, base_url, token_url, client_id, client_secret_enc, scope, created_by, updated_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`, [id, a.districtId, f.kind, f.name, f.base_url, f.token_url, f.client_id,
          encryptSecret(config.integrationsKey, a.districtId, id, f.secret), f.scope ?? null, a.userId]);
        await audit(c, req, "create", "integration_connector", id, `kind=${f.kind}; base_url=${f.base_url}`);
        return shape(await one(c, `SELECT ${COLS} ${FROM} WHERE c.id=$1`, [id]));
      });
      res.status(201).json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // Any change to where a connector connects or how sends it back for approval.
  app.patch(`${base}/:id`, requireSession, requireCsrf, manager, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_connector_id" });
    try {
      const f = readFields(req.body || {}, true);
      if (f.kind) throw new HttpError(400, "invalid_connector", { field: "kind" });
      const data = await withTenantTransaction(req.actor, async (c) => {
        const a = req.actor;
        const cur = await one(c, "SELECT id FROM integration_connectors WHERE id=$1 AND district_id=$2 FOR UPDATE", [req.params.id, a.districtId]);
        if (!cur) throw new HttpError(404, "connector_not_found");
        const sets = [], args = [cur.id];
        const add = (col, v) => { args.push(v); sets.push(`${col}=$${args.length}`); };
        for (const col of ["name", "base_url", "token_url", "client_id", "scope"]) if (col in f) add(col, f[col]);
        if (f.secret) add("client_secret_enc", encryptSecret(config.integrationsKey, a.districtId, cur.id, f.secret));
        if (!sets.length) throw new HttpError(400, "nothing_to_change");
        add("updated_by", a.userId);
        await c.query(`UPDATE integration_connectors SET ${sets.join(", ")}, updated_at=now(), config_version=config_version+1, status='pending_approval', approved_by=NULL, approved_at=NULL WHERE id=$1`, args)
          .catch(e => { if (e.code === "23505") throw new HttpError(409, "connector_name_taken"); throw e; });
        await invalidateScheduleForConnector(c,a.districtId,cur.id,"connector_configuration_changed");
        await audit(c, req, "update", "integration_connector", cur.id, `changed=${Object.keys(f).map(k => k === "secret" ? "client_secret" : k).join(",")}; needs approval`);
        return shape(await one(c, `SELECT ${COLS} ${FROM} WHERE c.id=$1`, [cur.id]));
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post(`${base}/:id/approve`, requireSession, requireCsrf, manager, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_connector_id" });
    try {
      const data = await withTenantTransaction(req.actor, async (c) => {
        const a = req.actor;
        const cur = await one(c, "SELECT id, status, updated_by FROM integration_connectors WHERE id=$1 AND district_id=$2 FOR UPDATE", [req.params.id, a.districtId]);
        if (!cur) throw new HttpError(404, "connector_not_found");
        if (cur.status === "active") throw new HttpError(409, "connector_already_active");
        // Two people: whoever last set it up can't also approve it.
        if (cur.updated_by === a.userId) throw new HttpError(409, "approver_must_differ");
        await c.query("UPDATE integration_connectors SET status='active', approved_by=$2, approved_at=now(), disabled_by=NULL, disabled_at=NULL WHERE id=$1", [cur.id, a.userId]);
        await audit(c, req, "approve", "integration_connector", cur.id, "data_scope=students; read-only");
        return shape(await one(c, `SELECT ${COLS} ${FROM} WHERE c.id=$1`, [cur.id]));
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post(`${base}/:id/disable`, requireSession, requireCsrf, manager, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_connector_id" });
    try {
      const data = await withTenantTransaction(req.actor, async (c) => {
        const r = await one(c, `UPDATE integration_connectors SET status='disabled', disabled_by=$3, disabled_at=now(), updated_by=$3, updated_at=now(), config_version=config_version+1
          WHERE id=$1 AND district_id=$2 AND status<>'disabled' RETURNING id`, [req.params.id, req.actor.districtId, req.actor.userId]);
        if (!r) throw new HttpError(404, "connector_not_found");
        await invalidateScheduleForConnector(c,req.actor.districtId,r.id,"connector_disabled");
        await audit(c, req, "disable", "integration_connector", r.id);
        return shape(await one(c, `SELECT ${COLS} ${FROM} WHERE c.id=$1`, [r.id]));
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.put(`${base}/:id/school-map`, requireSession, requireCsrf, manager, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_connector_id" });
    const list = req.body?.mappings;
    if (!Array.isArray(list) || list.length > 1000 || !list.every(m => cleanText(m?.externalId, 255) && (m.schoolId === null || validId(m.schoolId))))
      return res.status(400).json({ error: "invalid_school_map" });
    try {
      await withTenantTransaction(req.actor, async (c) => {
        const a = req.actor;
        if (!await one(c, "SELECT 1 FROM integration_connectors WHERE id=$1 AND district_id=$2 FOR UPDATE", [req.params.id, a.districtId])) throw new HttpError(404, "connector_not_found");
        for (const m of list) {
          if (m.schoolId === null) { await c.query("DELETE FROM integration_school_map WHERE connector_id=$1 AND external_id=$2", [req.params.id, m.externalId.trim()]); continue; }
          if (!await one(c, "SELECT 1 FROM schools WHERE id=$1 AND district_id=$2 AND status='active'", [m.schoolId, a.districtId])) throw new HttpError(400, "school_not_found", { schoolId: m.schoolId });
          await c.query(`INSERT INTO integration_school_map(district_id, connector_id, external_id, school_id, mapped_by) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (connector_id, external_id) DO UPDATE SET school_id=EXCLUDED.school_id, mapped_by=EXCLUDED.mapped_by, mapped_at=now()`,
            [a.districtId, req.params.id, m.externalId.trim(), m.schoolId, a.userId]);
        }
        // Where students land is part of what was approved: a change needs a
        // different district lead's approval before the next import.
        await c.query(`UPDATE integration_connectors SET updated_by=$2, updated_at=now(), config_version=config_version+1,
            status=CASE WHEN status='disabled' THEN status ELSE 'pending_approval' END, approved_by=NULL, approved_at=NULL WHERE id=$1`, [req.params.id, a.userId]);
        await invalidateScheduleForConnector(c,a.districtId,req.params.id,"school_mapping_changed");
        await audit(c, req, "update", "integration_school_map", req.params.id, `${list.map(m => `${m.externalId}=>${m.schoolId ?? "none"}`).join("; ")}; needs approval`);
      });
      res.json({ data: { saved: list.length, status: "pending_approval" } });
    } catch (e) { sendError(res, next, e); }
  });

  // SIS-02: schedules are separately approved from connector configuration.
  app.get(`${base}/:id/schedule`, requireSession, manager, async (req,res,next) => {
    if(!validId(req.params.id))return res.status(400).json({error:"invalid_connector_id"});
    try {
      const data=await withTenantTransaction(req.actor,c=>one(c,
        `SELECT s.id,s.enabled,s.interval_minutes,s.next_run_at,s.paused_at,s.pause_reason,
                s.config_version,s.approved_at,u.display_name AS approved_by,
                s.updated_at,uu.display_name AS updated_by
           FROM integration_sync_schedules s
           JOIN users uu ON uu.id=s.updated_by LEFT JOIN users u ON u.id=s.approved_by
          WHERE s.connector_id=$1 AND s.district_id=$2`,
        [req.params.id,req.actor.districtId]));
      res.setHeader("Cache-Control","no-store");
      res.json({data});
    } catch(e){sendError(res,next,e);}
  });

  app.put(`${base}/:id/schedule`, requireSession, requireCsrf, manager, async(req,res,next)=>{
    if(!validId(req.params.id))return res.status(400).json({error:"invalid_connector_id"});
    const interval=req.body?.intervalMinutes;
    if(!Number.isInteger(interval)||interval<15||interval>10080)
      return res.status(400).json({error:"invalid_schedule_interval",minimumMinutes:15,maximumMinutes:10080});
    try{
      const data=await withTenantTransaction(req.actor,async c=>{
        const a=req.actor;
        const connector=await one(c,"SELECT id,status,config_version FROM integration_connectors WHERE id=$1 AND district_id=$2 FOR UPDATE",[req.params.id,a.districtId]);
        if(!connector)throw new HttpError(404,"connector_not_found");
        if(connector.status!=="active")throw new HttpError(409,"connector_not_approved");
        const saved=await one(c,
          `INSERT INTO integration_sync_schedules(district_id,connector_id,interval_minutes,created_by,updated_by,config_version)
           VALUES($1,$2,$3,$4,$4,$5)
           ON CONFLICT(district_id,connector_id) DO UPDATE SET interval_minutes=EXCLUDED.interval_minutes,
             updated_by=EXCLUDED.updated_by,updated_at=now(),config_version=EXCLUDED.config_version,
             enabled=false,next_run_at=NULL,paused_at=NULL,pause_reason=NULL,approved_by=NULL,approved_at=NULL
           RETURNING id,enabled,interval_minutes,config_version`,
          [a.districtId,connector.id,interval,a.userId,connector.config_version]);
        await cancelScheduleJobs(c,a.districtId,saved.id,"schedule_reconfigured");
        await audit(c,req,"configure","integration_sync_schedule",saved.id,`interval_minutes=${interval}; requires separate approval`);
        return saved;
      });
      res.status(200).json({data});
    }catch(e){sendError(res,next,e);}
  });

  app.post(`${base}/:id/schedule/approve`, requireSession, requireCsrf, manager, async(req,res,next)=>{
    if(!validId(req.params.id))return res.status(400).json({error:"invalid_connector_id"});
    try{
      const data=await withTenantTransaction(req.actor,async c=>{
        const a=req.actor;
        // Keep lock order consistent with connector edits and the sync worker:
        // connector first, then schedule, then job.
        const connector=await one(c,"SELECT status,config_version,approved_at FROM integration_connectors WHERE id=$1 AND district_id=$2 FOR UPDATE",[req.params.id,a.districtId]);
        if(!connector)throw new HttpError(404,"connector_not_found");
        const s=await one(c,"SELECT id,updated_by,config_version FROM integration_sync_schedules WHERE connector_id=$1 AND district_id=$2 FOR UPDATE",[req.params.id,a.districtId]);
        if(!s)throw new HttpError(404,"schedule_not_found");
        if(connector.status!=="active"||s.config_version!==connector.config_version)throw new HttpError(409,"connector_approval_stale");
        if(s.updated_by===a.userId)throw new HttpError(409,"approver_must_differ");
        const preview=await one(c,
          "SELECT id FROM integration_sync_runs WHERE connector_id=$1 AND district_id=$2 AND mode='preview' AND status='previewed' AND started_at >= $3 ORDER BY started_at DESC LIMIT 1",
          [req.params.id,a.districtId,connector.approved_at]);
        if(!preview)throw new HttpError(409,"schedule_requires_current_preview");
        const approved=await one(c,
          `UPDATE integration_sync_schedules SET enabled=true,paused_at=NULL,pause_reason=NULL,
             next_run_at=now(),approved_by=$2,approved_at=now(),updated_at=now()
            WHERE id=$1 RETURNING id,enabled,interval_minutes,next_run_at,approved_at`,
          [s.id,a.userId]);
        await audit(c,req,"approve","integration_sync_schedule",s.id,"scheduled roster apply approved");
        return approved;
      });
      res.json({data});
    }catch(e){sendError(res,next,e);}
  });

  app.post(`${base}/:id/schedule/pause`, requireSession, requireCsrf, managerRole, async(req,res,next)=>{
    if(!validId(req.params.id))return res.status(400).json({error:"invalid_connector_id"});
    const reason=typeof req.body?.reason==="string"?req.body.reason.trim().slice(0,240):"paused_by_district_manager";
    try{
      const data=await withTenantTransaction(req.actor,async c=>{
        const s=await one(c,
          `UPDATE integration_sync_schedules SET paused_at=now(),pause_reason=$3,next_run_at=NULL,updated_at=now()
            WHERE connector_id=$1 AND district_id=$2 RETURNING id,enabled,paused_at,pause_reason`,
          [req.params.id,req.actor.districtId,reason]);
        if(!s)throw new HttpError(404,"schedule_not_found");
        await cancelScheduleJobs(c,req.actor.districtId,s.id,reason);
        await audit(c,req,"pause","integration_sync_schedule",s.id,reason);
        return s;
      });
      res.json({data});
    }catch(e){sendError(res,next,e);}
  });

  app.post("/api/integrations/schedules/pause-all",requireSession,requireCsrf,managerRole,async(req,res,next)=>{
    const reason=typeof req.body?.reason==="string"?req.body.reason.trim().slice(0,240):"district_wide_pause";
    try{
      const data=await withTenantTransaction(req.actor,async c=>{
        const changed=await rows(c,
          `UPDATE integration_sync_schedules SET paused_at=now(),pause_reason=$2,next_run_at=NULL,updated_at=now()
            WHERE district_id=$1 AND enabled=true AND paused_at IS NULL RETURNING id`,
          [req.actor.districtId,reason]);
        await c.query(
          `UPDATE integration_sync_jobs j SET status='cancelled',lease_until=NULL,lease_token=NULL,
             finished_at=now(),last_error=$2
            FROM integration_sync_schedules s
           WHERE j.schedule_id=s.id AND j.district_id=$1 AND s.district_id=$1
             AND s.enabled=true AND s.paused_at IS NOT NULL AND j.status IN ('pending','processing')`,
          [req.actor.districtId,reason]);
        await audit(c,req,"pause_all","integration_sync_schedule",req.actor.districtId,`count=${changed.length}; ${reason}`);
        return {paused:changed.length};
      });
      res.json({data});
    }catch(e){sendError(res,next,e);}
  });

  app.post(`${base}/:id/schedule/resume`, requireSession, requireCsrf, manager, async(req,res,next)=>{
    if(!validId(req.params.id))return res.status(400).json({error:"invalid_connector_id"});
    try{
      const data=await withTenantTransaction(req.actor,async c=>{
        const s=await one(c,
          `UPDATE integration_sync_schedules s SET paused_at=NULL,pause_reason=NULL,next_run_at=now(),updated_at=now()
            FROM integration_connectors x
           WHERE s.connector_id=$1 AND s.district_id=$2 AND x.id=s.connector_id AND x.district_id=s.district_id
             AND s.enabled=true AND s.approved_by IS NOT NULL AND x.status='active'
             AND s.config_version=x.config_version
           RETURNING s.id,s.enabled,s.next_run_at`,
          [req.params.id,req.actor.districtId]);
        if(!s)throw new HttpError(409,"schedule_not_approved_or_connector_stale");
        await audit(c,req,"resume","integration_sync_schedule",s.id);
        return s;
      });
      res.json({data});
    }catch(e){sendError(res,next,e);}
  });

  app.get(`${base}/:id/runs`, requireSession, manager, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_connector_id" });
    try {
      const data = await withTenantTransaction(req.actor, (c) => rows(c, `SELECT r.id, r.mode, r.status, r.started_at, r.finished_at, r.counts, r.rejected, r.error,
          r.schedule_id,r.scheduled_job_id,r.schedule_approved_at,sau.display_name AS schedule_approved_by,
          COALESCE(u.display_name,sa.display_name,'EduOS SIS Scheduler') AS started_by,
          (r.started_by_service IS NOT NULL) AS service_initiated
          FROM integration_sync_runs r LEFT JOIN users u ON u.id=r.started_by
          LEFT JOIN integration_service_actors sa ON sa.id=r.started_by_service
          LEFT JOIN users sau ON sau.id=r.schedule_approved_by
          WHERE r.connector_id=$1 AND r.district_id=$2 ORDER BY r.started_at DESC LIMIT 20`, [req.params.id, req.actor.districtId]));
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // Preview (nothing changes) or apply. Fetches from the external system
  // outside any database transaction, then plans and imports in one.
  app.post(`${base}/:id/sync`, requireSession, requireCsrf, manager, syncLimiter, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_connector_id" });
    const mode = req.body?.mode === "apply" ? "apply" : "preview";
    const a = req.actor, started = new Date(), runId = crypto.randomUUID();
    let conn = null;
    const record = (c, status, extra) => c.query(`INSERT INTO integration_sync_runs(id, district_id, connector_id, mode, status, started_by, started_at, counts, rejected, error)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`, [runId, a.districtId, conn.id, mode, status, a.userId, started,
        JSON.stringify(extra.counts || {}), JSON.stringify(extra.rejected || []), extra.error || null])
      .then(() => c.query("UPDATE integration_connectors SET last_sync_at=now(), last_sync_status=$2 WHERE id=$1", [conn.id, status]));
    const fail = async (code, detail) => {
      const error = `${code}${detail ? `: ${detail}` : ""}`.slice(0, 300);
      await withTenantTransaction(a, async (c) => { await record(c, "failed", { error }); await audit(c, req, `sync_${mode}`, "integration_connector", conn.id, error, "failure"); });
    };
    try {
      conn = await withTenantTransaction(a, (c) => one(c, "SELECT * FROM integration_connectors WHERE id=$1 AND district_id=$2", [req.params.id, a.districtId]));
      if (!conn) throw new HttpError(404, "connector_not_found");
      if (conn.status !== "active") throw new HttpError(409, "connector_not_approved");
      let roster;
      try {
        const [secret, mapped] = await Promise.all([
          Promise.resolve(decryptSecret(config.integrationsKey, a.districtId, conn.id, conn.client_secret_enc)),
          withTenantTransaction(a, (c) => rows(c,
            "SELECT external_id FROM integration_school_map WHERE connector_id=$1 AND district_id=$2 ORDER BY external_id",
            [conn.id, a.districtId])),
        ]);
        roster = await KINDS[conn.kind].fetchRoster({
          baseUrl: conn.base_url, tokenUrl: conn.token_url, clientId: conn.client_id,
          clientSecret: secret, scope: conn.scope, options: urlOptions(),
          mappedSchoolIds: mapped.map((m) => m.external_id),
          maxStudentRecords: config.powerschoolMaxStudents,
        });
      } catch (e) {
        // An unreadable secret means INTEGRATIONS_KEY changed: re-enter the secret.
        const code = e instanceof IntegrationError ? e.code : e.message === "secret_unreadable" || /unable to authenticate data/i.test(e.message) ? "connector_secret_unreadable" : null;
        if (!code) throw e;
        await fail(code, e.detail);
        return res.status(502).json({ error: code, detail: e.detail || null, runId });
      }
      const out = await withTenantTransaction(a, async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(hashtext('integration-sync'), hashtext($1))", [conn.id]);
        // The connector may have been changed, re-mapped or turned off while we
        // were reading the external roster: import only under the configuration
        // that was approved when the sync started.
        const now = await one(c, "SELECT status, config_version FROM integration_connectors WHERE id=$1 AND district_id=$2 FOR UPDATE", [conn.id, a.districtId]);
        if (!now || now.status !== "active" || now.config_version !== conn.config_version)
          throw Object.assign(new Error("connector_changed_during_sync"), { code: "SYNC_STALE" });
        const inputs = await loadPlanInputs(c, a.districtId, conn.id, roster.students.map(s => s.localStudentNumber));
        const plan = planImport(roster, inputs.map, inputs.existing, inputs.schools);
        if (mode === "apply") plan.counts.imported = await applyPlan(c, a, conn, runId, plan, req.requestId);
        await record(c, mode === "apply" ? "completed" : "previewed", { counts: plan.counts, rejected: plan.rejected });
        await audit(c, req, `sync_${mode}`, "integration_connector", conn.id, `run=${runId}; to_import=${plan.counts.toImport}; not_mapped=${plan.counts.notMapped}; rejected=${plan.counts.rejected}`);
        return { runId, mode, counts: plan.counts, rejected: plan.rejected, externalSchools: plan.externalSchools };
      });
      res.json({ data: out });
    } catch (e) {
      if (e.code === "SYNC_STALE") {
        try { await fail("connector_changed_during_sync"); } catch { /* the response still explains */ }
        return res.status(409).json({ error: "connector_changed_during_sync", runId });
      }
      if (e.code === "SIS_STUDENT_SCHOOL_CONFLICT" || e.code === "DISTRICT_LIMIT_MAX_STUDENTS" || e.code === "SYNC_SCHOOL_FAILED") {
        // Nothing was imported (the transaction rolled back); say why.
        const detail = e.detail || e.code.toLowerCase();
        try { await fail("sync_not_applied", detail); } catch { /* the response still explains */ }
        return res.status(409).json({ error: "sync_not_applied", detail, runId });
      }
      sendError(res, next, e);
    }
  });
}
