import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root=process.cwd();
const worker=readFileSync(join(root,"src/integrations/scheduler.js"),"utf8");
const routes=readFileSync(join(root,"src/integrations/routes.js"),"utf8");
const server=readFileSync(join(root,"src/server.js"),"utf8");
const pkg=readFileSync(join(root,"package.json"),"utf8");

test("scheduled jobs are claimed with database leases and SKIP LOCKED",()=>{
  assert.match(worker,/FOR UPDATE SKIP LOCKED/);
  assert.match(worker,/lease_until/);
  assert.match(worker,/lease_token/);
  assert.match(worker,/SYNC_JOB_MAX_ATTEMPTS = 5/);
  assert.match(worker,/lease_expired_after_max_attempts/);
  assert.match(worker,/recordScheduledFailure/);
});

test("only enabled, approved, unpaused and version-current schedules enqueue",()=>{
  assert.match(worker,/enabled=true AND paused_at IS NULL AND next_run_at<=now\(\)/);
  assert.match(worker,/input\.config_version!==input\.connector_version/);
  assert.match(worker,/input\.config_version!==input\.schedule_version/);
  assert.match(worker,/v\.config_version!==input\.config_version/);
  assert.match(worker,/v\.job_version!==input\.config_version/);
  assert.match(worker,/v\.paused_at/);
});

test("scheduled imports reuse the shared SIS planner and import transaction",()=>{
  assert.match(worker,/loadPlanInputs/);
  assert.match(worker,/planImport/);
  assert.match(worker,/applyPlan\(c,actor/);
  assert.match(worker,/pg_advisory_xact_lock/);
});

test("service scheduler uses district-only RLS context, never a user session",()=>{
  assert.match(worker,/set_config\('app\.district_id'/);
  assert.doesNotMatch(worker,/set_config\('app\.user_id'/);
  assert.match(worker,/integration_service_actors WHERE actor_key='sis_scheduler'/);
});

test("district managers can separately approve schedules and pause all schedules",()=>{
  assert.match(routes,/schedule\/approve/);
  assert.match(routes,/approver_must_differ/);
  assert.match(routes,/schedules\/pause-all/);
  assert.match(routes,/schedule\/pause/);
  assert.match(routes,/schedule\/resume/);
  assert.match(routes,/cancelScheduleJobs/);
  assert.match(routes,/status IN \('pending','processing'\)/);
});

test("scheduler is wired into API startup and has a standalone command",()=>{
  assert.match(server,/dispatchScheduledSisSync/);
  assert.match(server,/startSisSyncSweep\(\)/);
  assert.match(pkg,/"sis:sync"/);
});
