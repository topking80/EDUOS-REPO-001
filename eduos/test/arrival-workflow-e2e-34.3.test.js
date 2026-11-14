import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { arrivalInitiationDenial, arrivalReceiptDenial, firstAttendanceDenial } from '../src/arrival-workflow.js';

const routes = await readFile(new URL('../src/arrival-routes.js', import.meta.url), 'utf8');
const schema = await readFile(new URL('../db/017_arrival_handoff.sql', import.meta.url), 'utf8');
const ui = await readFile(new URL('../public/api-bridge.js', import.meta.url), 'utf8');

const base = { role:'teacher', actorUserId:'teacher-2', initiatorUserId:'driver-1', actorSchoolId:'school-1', handoffSchoolId:'school-1', status:'pending', assignedTeacherUserId:'teacher-2', isRostered:false };

test('morning arrival lifecycle accepts principal car-rider/walk-in and assigned driver bus initiation only', () => {
  assert.equal(arrivalInitiationDenial({role:'principal',method:'car_rider',routeRunId:null}), null);
  assert.equal(arrivalInitiationDenial({role:'principal',method:'walk_in',routeRunId:null}), null);
  assert.equal(arrivalInitiationDenial({role:'driver',method:'bus',routeRunId:'run-1'}), null);
  assert.equal(arrivalInitiationDenial({role:'teacher',method:'bus',routeRunId:'run-1'}), 'assigned_driver_required');
  assert.equal(arrivalInitiationDenial({role:'driver',method:'bus',routeRunId:null}), 'transport_run_required');
});

test('receipt requires a different authorized staff member and is idempotent after receipt', () => {
  assert.equal(arrivalReceiptDenial(base), null);
  assert.equal(arrivalReceiptDenial({...base,actorUserId:'driver-1'}), 'independent_receipt_required');
  assert.equal(arrivalReceiptDenial({...base,actorSchoolId:'school-2'}), 'school_scope_denied');
  assert.equal(arrivalReceiptDenial({...base,status:'received'}), null);
  assert.equal(arrivalReceiptDenial({...base,status:'cancelled'}), 'handoff_not_pending');
  assert.equal(arrivalReceiptDenial({...base,assignedTeacherUserId:'teacher-3',isRostered:false}), 'student_not_on_roster');
});

test('first attendance is blocked until receipt and limited to assigned/rostered teacher or principal', () => {
  assert.equal(firstAttendanceDenial({...base,status:'pending'}), 'attendance_requires_received_handoff');
  assert.equal(firstAttendanceDenial({...base,status:'received'}), null);
  assert.equal(firstAttendanceDenial({...base,status:'received',role:'teacher',assignedTeacherUserId:'teacher-3',isRostered:false}), 'student_not_on_roster');
  assert.equal(firstAttendanceDenial({...base,status:'received',role:'principal'}), null);
  assert.equal(firstAttendanceDenial({...base,status:'received',role:'driver'}), 'school_staff_only');
});

test('API route handlers invoke the shared lifecycle policy and keep tenant-scoped persistence', () => {
  assert.match(routes,/arrivalInitiationDenial\(/);
  assert.match(routes,/arrivalReceiptDenial\(/);
  assert.match(routes,/firstAttendanceDenial\(/);
  assert.match(routes,/withTenantTransaction\(req\.actor/);
  assert.match(routes,/h\.district_id=\$1/);
  assert.match(routes,/pg_advisory_xact_lock/);
});

test('database preserves append-only event history and one pending arrival per student', () => {
  assert.match(schema,/reject_arrival_event_mutation/);
  assert.match(schema,/BEFORE UPDATE OR DELETE/);
  assert.match(schema,/arrival_handoffs_one_pending_student/);
  assert.match(schema,/ENABLE ROW LEVEL SECURITY/);
  assert.match(schema,/FORCE ROW LEVEL SECURITY/);
});

test('authenticated UI exposes each step of the workflow through the authoritative API', () => {
  for (const endpoint of ['/api/arrival/today','/api/arrival/handoffs','/receive','/first-attendance']) assert.ok(ui.includes(endpoint));
  assert.match(ui,/arrival-receive/);
  assert.match(ui,/arrival-attendance/);
});
