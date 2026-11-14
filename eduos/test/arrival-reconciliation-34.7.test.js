import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reconcileTransportArrival } from '../src/arrival-reconciliation.js';
const route=readFileSync(new URL('../src/arrival-routes.js',import.meta.url),'utf8');
const bridge=readFileSync(new URL('../public/api-bridge.js',import.meta.url),'utf8');
const dispatch=readFileSync(new URL('../src/arrival-escalation-dispatch.js',import.meta.url),'utf8');

test('reconciliation distinguishes each transport-to-classroom state',()=>{
  const cases=[
    [{},'missing_route_checkin'],
    [{checkinEvent:'boarded'},'on_route'],
    [{checkinEvent:'not_riding'},'not_riding'],
    [{checkinEvent:'alighted'},'missing_school_handoff'],
    [{checkinEvent:'alighted',handoffCount:1,handoffStatus:'pending'},'awaiting_school_receipt'],
    [{checkinEvent:'alighted',handoffCount:1,handoffStatus:'received'},'missing_first_attendance'],
    [{checkinEvent:'alighted',handoffCount:1,handoffStatus:'received',attendanceRecorded:true},'complete'],
    [{checkinEvent:'alighted',handoffCount:2,handoffStatus:'received',attendanceRecorded:true},'duplicate_arrival']
  ];
  for(const [input,expected] of cases) assert.equal(reconcileTransportArrival(input),expected);
});
test('authenticated reconciliation query joins route assignments, latest check-in, handoff and attendance',()=>{
  assert.match(route,/\/api\/arrival\/reconciliation/);
  assert.match(route,/transport_rider_assignments/);
  assert.match(route,/LEFT JOIN LATERAL/);
  assert.match(route,/transport_checkins/);
  assert.match(route,/arrival_handoffs/);
  assert.match(route,/attendance_events/);
  assert.match(route,/r\.school_id=\$2/);
  assert.match(route,/r\.driver_user_id=\$2/);
});
test('principal and driver UI can open the reconciliation workspace',()=>{
  assert.match(bridge,/\["arrival-reconciliation","Arrival reconciliation"\]/);
  assert.match(bridge,/\/api\/arrival\/reconciliation/);
  assert.match(bridge,/duplicate_arrival/);
  assert.match(bridge,/missing_school_handoff/);
});
test('escalation dedupe is written only after an eligible recipient is found',()=>{
  assert.ok(dispatch.indexOf('if(!recipients.length) continue;')<dispatch.indexOf('INSERT INTO arrival_escalation_alerts'));
});
