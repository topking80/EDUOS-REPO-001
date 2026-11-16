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

test('first attendance: only the receiving staff member, or a principal override with a reason', () => {
  const rec = {...base,status:'received',receivedByUserId:'teacher-2'};
  assert.equal(firstAttendanceDenial({...rec,status:'pending'}), 'attendance_requires_received_handoff');
  assert.equal(firstAttendanceDenial(rec), null, 'the receiving teacher');
  assert.equal(firstAttendanceDenial({...rec,actorUserId:'teacher-4',isRostered:true}), 'receiving_staff_required', 'another rostered teacher');
  assert.equal(firstAttendanceDenial({...rec,actorUserId:'teacher-4',isRostered:true,overrideReason:'covering'}), 'receiving_staff_required', 'teachers cannot override');
  assert.equal(firstAttendanceDenial({...rec,role:'teacher',assignedTeacherUserId:'teacher-3',isRostered:false}), 'student_not_on_roster');
  assert.equal(firstAttendanceDenial({...rec,role:'principal',actorUserId:'principal-1'}), 'override_reason_required');
  assert.equal(firstAttendanceDenial({...rec,role:'principal',actorUserId:'principal-1',overrideReason:'  '}), 'override_reason_required');
  assert.equal(firstAttendanceDenial({...rec,role:'principal',actorUserId:'principal-1',overrideReason:'x'.repeat(301)}), 'override_reason_required');
  assert.equal(firstAttendanceDenial({...rec,role:'principal',actorUserId:'principal-1',overrideReason:'Receiving teacher left sick'}), null);
  assert.equal(firstAttendanceDenial({...rec,role:'principal',actorUserId:'principal-1',receivedByUserId:'principal-1'}), null, 'a principal who received the student');
  assert.equal(firstAttendanceDenial({...rec,role:'principal',actorUserId:'principal-1',actorSchoolId:'school-2',overrideReason:'reason'}), 'school_scope_denied');
  assert.equal(firstAttendanceDenial({...rec,role:'driver'}), 'school_staff_only');
});

test('API route handlers invoke the shared lifecycle policy and keep tenant-scoped persistence', async () => {
  assert.match(routes,/arrivalInitiationDenial\(/);
  assert.match(routes,/arrivalReceiptDenial\(/);
  assert.match(routes,/firstAttendanceDenial\(/);
  assert.match(routes,/withTenantTransaction\(req\.actor/);
  assert.match(routes,/h\.district_id=\$1/);
  // One attendance event per student per day: the shared lock (src/attendance-day.js).
  assert.match(routes,/lockStudentDay\(client,h\.student_id,day\.day\)/);
  assert.match(await readFile(new URL('../src/attendance-day.js', import.meta.url),'utf8'),/pg_advisory_xact_lock/);
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
