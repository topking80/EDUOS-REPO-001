import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const transport = await readFile(new URL('../src/transport-routes.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');

test('arrival screen cannot be mistaken for authoritative records', () => {
  assert.match(html, /DEMO ONLY — NOT AN AUTHORITATIVE STUDENT RECORD/);
  assert.match(html, /stored only in this browser/);
  assert.match(html, /persona selection is a presentation control, not authentication or authorization/i);
});

test('browser-local arrival mutations are visible as local storage operations', () => {
  assert.match(html, /const ARRIVAL_KEY="eduos_arrival_handoff_demo_v2"/);
  for (const fn of ['assignArrivalTeacher', 'arrivalCheckIn', 'arrivalHandoff', 'teacherFirstAttendance'])
    assert.match(html, new RegExp(`function ${fn}\\(`));
  assert.match(html, /localStorage\.setItem\(ARRIVAL_KEY/);
});

test('existing transport and attendance APIs remain separate from arrival lifecycle', () => {
  assert.match(transport, /\/api\/transport\/runs\/:runId\/checkins/);
  assert.match(server, /app\.post\("\/api\/attendance"/);
  assert.match(server, /registerArrivalRoutes\(app\)/);
  assert.match(server, /arrival-routes\.js/);
  assert.match(transport, /\/api\/transport\/runs\/:runId\/checkins/);
});

test('arrival integration contract names mandatory independent staff receipt', async () => {
  const report = await readFile(new URL('../ADVANCEMENT-32.25.0-ARRIVAL-INTEGRATION-READINESS-GATE.md', import.meta.url), 'utf8');
  assert.match(report, /receiving staff independently confirms handoff/);
  assert.match(report, /attendance-before-handoff/);
  assert.match(report, /cross-tenant and cross-school denial tests/);
});

test('33.8.0 authoritative arrival API enforces independent receipt and attendance ordering', async()=>{
 const routes=await readFile(new URL('../src/arrival-routes.js',import.meta.url),'utf8');
 const migration=await readFile(new URL('../db/017_arrival_handoff.sql',import.meta.url),'utf8');
 assert.match(routes,/independent_receipt_required/);
 assert.match(routes,/attendance_requires_received_handoff/);
 assert.match(routes,/transport_run_not_assigned/);
 assert.match(routes,/student_not_assigned_to_route/);
 assert.match(migration,/ENABLE ROW LEVEL SECURITY/);
 assert.match(migration,/FORCE ROW LEVEL SECURITY/);
 assert.match(migration,/CREATE POLICY arrival_handoff_create_scope ON arrival_handoffs FOR INSERT/);
 assert.match(migration,/CREATE POLICY arrival_handoff_receive_scope ON arrival_handoffs FOR UPDATE/);
 assert.match(migration,/FOREIGN KEY \(district_id, transport_run_id\)/);
 assert.match(migration,/arrival_handoff_events are append-only/);
});
