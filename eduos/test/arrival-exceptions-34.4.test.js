import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyArrivalExceptions } from '../src/arrival-exceptions.js';
const now = new Date('2026-11-10T15:00:00.000Z');
const record = (id, status, minutes, attendanceRecorded) => ({ id, status, initiatedAt: new Date(now.getTime()-minutes*60000).toISOString(), studentId: `student-${id}`, schoolId: 'school-1', attendanceRecorded });

test('classifies overdue pending handoffs and escalates older ones', () => {
  const out = classifyArrivalExceptions([record('a','pending',9),record('b','pending',10),record('c','pending',31)], {now});
  assert.deepEqual(out.map(x=>[x.handoffId,x.severity]), [['c','high'],['b','medium']]);
});
test('flags received handoffs missing first attendance only after threshold', () => {
  const out = classifyArrivalExceptions([record('a','received',14,false),record('b','received',15,false),record('c','received',50,true)], {now});
  assert.equal(out.length,1); assert.equal(out[0].kind,'first_attendance_missing'); assert.equal(out[0].handoffId,'b');
});
test('does not flag future, invalid, completed, or unknown records', () => {
  const out = classifyArrivalExceptions([record('a','pending',20),{id:'bad',status:'pending',initiatedAt:'bad'},record('future','pending',-2),record('done','received',60,true)],{now});
  assert.deepEqual(out.map(x=>x.handoffId),['a']);
});
test('rejects invalid inputs and supports custom thresholds', () => {
  assert.throws(()=>classifyArrivalExceptions(null,{now}),/array/);
  assert.throws(()=>classifyArrivalExceptions([],{now:'invalid'}),/now/);
  assert.equal(classifyArrivalExceptions([record('a','pending',4)],{now,pendingMinutes:4})[0].severity,'medium');
});
test('returns stable, oldest-first ordering with deterministic identifiers', () => {
  const out = classifyArrivalExceptions([record('z','pending',20),record('a','pending',20)],{now});
  assert.deepEqual(out.map(x=>x.id),['arrival-pending:a','arrival-pending:z']);
});
