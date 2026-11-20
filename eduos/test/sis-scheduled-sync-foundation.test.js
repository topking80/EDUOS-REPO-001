import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root=process.cwd();
const migration=readFileSync(join(root,"db/086_sis_scheduled_sync_foundation.sql"),"utf8");
const sisImport=readFileSync(join(root,"src/sis-import.js"),"utf8");
const grants=readFileSync(join(root,"db/runtime_grants.template.sql"),"utf8");

test("SIS scheduler has a service principal, not a fabricated user",()=>{
  assert.match(migration,/CREATE TABLE integration_service_actors/);
  assert.match(migration,/VALUES \('sis_scheduler','EduOS SIS Scheduler'\)/);
  assert.match(migration,/started_by_service uuid REFERENCES integration_service_actors/);
  assert.match(migration,/initiated_by_service uuid REFERENCES integration_service_actors/);
  assert.match(migration,/actor_service_id uuid REFERENCES integration_service_actors/);
  assert.match(migration,/num_nonnulls\(actor_user_id,actor_service_id\)=1/);
});

test("scheduled SIS records preserve a single attributable actor",()=>{
  assert.match(migration,/num_nonnulls\(started_by,started_by_service\)=1/);
  assert.match(migration,/num_nonnulls\(initiated_by,initiated_by_service\)=1/);
  assert.match(sisImport,/exactly one user or service actor/);
  assert.match(sisImport,/actor_service_id/);
  assert.match(sisImport,/initiated_by_service/);
});

test("schedules are independently approved and connector-version bound",()=>{
  assert.match(migration,/approved_by uuid REFERENCES users/);
  assert.match(migration,/approved_by<>updated_by/);
  assert.match(migration,/config_version integer NOT NULL CHECK \(config_version>=1\)/);
  assert.match(migration,/CHECK \(\(NOT enabled OR paused_at IS NOT NULL\) = \(next_run_at IS NULL\)\)/);
  assert.match(migration,/interval_minutes BETWEEN 15 AND 10080/);
});

test("durable jobs have bounded attempts, leases and tenant-composite references",()=>{
  assert.match(migration,/attempts BETWEEN 0 AND 5/);
  assert.match(migration,/lease_until timestamptz/);
  assert.match(migration,/lease_token uuid/);
  assert.match(migration,/FOREIGN KEY\(district_id,connector_id,schedule_id\)/);
});

test("runtime grants are least privilege for durable scheduler records",()=>{
  assert.match(grants,/GRANT SELECT ON integration_service_actors TO eduos_app/);
  assert.match(grants,/GRANT SELECT, INSERT, UPDATE ON integration_sync_schedules, integration_sync_jobs TO eduos_app/);
  assert.match(grants,/REVOKE DELETE, TRUNCATE ON integration_service_actors, integration_sync_schedules, integration_sync_jobs FROM eduos_app/);
});
