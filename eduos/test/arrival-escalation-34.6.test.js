import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyArrivalExceptions } from '../src/arrival-exceptions.js';

const migration=readFileSync(new URL('../db/019_arrival_escalation_alerts.sql',import.meta.url),'utf8');
const grants=readFileSync(new URL('../db/runtime_grants.template.sql',import.meta.url),'utf8');
const migrate=readFileSync(new URL('../src/migrate.js',import.meta.url),'utf8');
const dispatch=readFileSync(new URL('../src/arrival-escalation-dispatch.js',import.meta.url),'utf8');
const bridge=readFileSync(new URL('../public/api-bridge.js',import.meta.url),'utf8');
const now=new Date('2026-11-11T12:00:00Z');
const row=(id,status,minutes,attendanceRecorded)=>({id,status,initiatedAt:new Date(now.getTime()-minutes*60000).toISOString(),attendanceRecorded,schoolId:'school'});

test('arrival escalation uses medium and high thresholds for unresolved handoffs',()=>{
  const out=classifyArrivalExceptions([row('m','pending',10,false),row('h','pending',30,false)],{now});
  assert.deepEqual(out.map(x=>x.severity),['high','medium']);
});
test('attendance exceptions escalate at 15 and 45 minutes and stop when recorded',()=>{
  const out=classifyArrivalExceptions([row('m','received',15,false),row('h','received',45,false),row('done','received',90,true)],{now});
  assert.deepEqual(out.map(x=>x.severity),['high','medium']);
  assert.equal(out.length,2);
});
test('migration registers the immutable per-exception severity dedupe ledger with RLS',()=>{
  assert.match(migration,/UNIQUE\(district_id,handoff_id,exception_kind,severity\)/);
  assert.match(migration,/ENABLE ROW LEVEL SECURITY/);
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
});
test('migration runner applies exception resolution before escalation ledger',()=>{
  assert.ok(migrate.indexOf('018_arrival_exception_resolution.sql')<migrate.indexOf('019_arrival_escalation_alerts.sql'));
});
test('runtime grants permit resolution workflow but keep alert ledger scheduler-owned',()=>{
  assert.match(grants,/GRANT SELECT, INSERT, UPDATE ON arrival_exception_resolutions/);
  assert.match(grants,/GRANT SELECT ON arrival_escalation_alerts/);
  assert.match(grants,/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON arrival_escalation_alerts/);
});
test('dispatcher deduplicates severity alerts and sends recipient-scoped notifications',()=>{
  assert.match(dispatch,/ON CONFLICT\(district_id,handoff_id,exception_kind,severity\) DO NOTHING/);
  assert.match(dispatch,/m\.role='principal'/);
  assert.match(dispatch,/m\.role='superintendent'/);
  assert.match(dispatch,/outboxRows\(/);
  assert.match(dispatch,/set_config\('app\.district_id'/);
});
test('authenticated UI exposes notification inbox and read actions',()=>{
  assert.match(bridge,/\["notifications","Notifications"\]/);
  assert.match(bridge,/\/api\/notifications/);
  assert.match(bridge,/notifications-read-all/);
});
