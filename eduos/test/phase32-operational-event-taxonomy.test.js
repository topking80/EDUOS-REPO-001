import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOperationalEvent } from '../src/operational-event-taxonomy.js';

test('attendance records are represented by a safe district operations category',()=>{
  assert.deepEqual(classifyOperationalEvent({action:'record',resourceType:'attendance',outcome:'success'}),{
    type:'attendance.recorded',label:'Attendance recorded',severity:'info'
  });
});

test('transportation run and rider check-in events are classified separately',()=>{
  assert.equal(classifyOperationalEvent({action:'checkin',resourceType:'transport_checkin'}).type,'transportation.rider_checkin');
  assert.equal(classifyOperationalEvent({action:'create',resourceType:'transport_run'}).type,'transportation.run_started');
  assert.equal(classifyOperationalEvent({action:'complete',resourceType:'transport_run'}).type,'transportation.run_completed');
});

test('dismissal release and denied-release events have distinct severity',()=>{
  assert.equal(classifyOperationalEvent({action:'release',resourceType:'pickup_event'}).type,'dismissal.student_released');
  assert.equal(classifyOperationalEvent({action:'deny',resourceType:'pickup_tag'}).severity,'warning');
  assert.equal(classifyOperationalEvent({action:'verify',resourceType:'pickup_tag',outcome:'failure'}).type,'dismissal.pass_verification_failed');
});

test('AI orchestration is classified without exposing trace detail',()=>{
  const event=classifyOperationalEvent({action:'agent_orchestration',resourceType:'agent_orchestration'});
  assert.equal(event.type,'ai.agent_run_recorded');
  assert.deepEqual(Object.keys(event).sort(),['label','severity','type']);
});

test('unknown events fall back to a fixed safe label and failed outcomes are elevated',()=>{
  assert.deepEqual(classifyOperationalEvent({action:'something',resourceType:'unknown',outcome:'failure'}),{
    type:'operations.audit_event',label:'Operational record updated',severity:'warning'
  });
});
