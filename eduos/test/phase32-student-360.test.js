import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');

test('Phase 32 migration adds district-scoped intervention cases and append-only notes',()=>{
  const sql=read('../db/004_student_360_cases.sql');
  assert.match(sql,/CREATE TABLE student_intervention_cases/);
  assert.match(sql,/FOREIGN KEY\(district_id,student_id\) REFERENCES students\(district_id,id\)/);
  assert.match(sql,/ALTER TABLE student_intervention_cases ENABLE ROW LEVEL SECURITY/);
  assert.match(sql,/CREATE TABLE student_case_notes/);
  assert.match(sql,/student_case_notes are append-only/);
  assert.match(sql,/BEFORE UPDATE OR DELETE ON student_case_notes/);
});

test('Student 360 API composes profile, attendance, academics, cases and timeline',()=>{
  const server=read('../src/server.js');
  assert.match(server,/app\.get\("\/api\/student-360\/:studentId"/);
  for(const key of ['attendance:attendance.rows','academics:assignments.rows','cases:cases.rows','timeline:timeline.rows'])assert.ok(server.includes(key));
  assert.match(server,/studentScopeSql/);
});

test('case mutations require authenticated CSRF-protected permission checks',()=>{
  const server=read('../src/server.js');
  assert.match(server,/app\.post\("\/api\/cases",requireSession,requireCsrf,requirePermission\("cases","create"\)/);
  assert.match(server,/app\.patch\("\/api\/cases\/:caseId",requireSession,requireCsrf,requirePermission\("cases","update"\)/);
  assert.match(server,/app\.post\("\/api\/cases\/:caseId\/notes",requireSession,requireCsrf,requirePermission\("cases","update"\)/);
  assert.match(server,/staff_only/);
});

test('connected services includes Student 360 and case workflow controls',()=>{
  const ui=read('../public/api-bridge.js');
  assert.match(ui,/Student 360/);
  // 32.2.0: the tab is labelled "Support cases" (plain language) in eduos-mesh.js.
  assert.match(read('../public/eduos-mesh.js'),/\["cases", "Support cases"\]/);
  assert.match(ui,/Intervention register/);
  assert.match(ui,/\/api\/student-360\//);
  assert.match(ui,/\/api\/cases/);
  assert.match(ui,/Append-only case note saved/);
});

test('migration runner applies Phase 32 after prior ordered migrations',()=>{
  const runner=read('../src/migrate.js');
  assert.match(runner,/004_student_360_cases\.sql/);
  assert.ok(runner.indexOf('003_access_control.sql')<runner.indexOf('004_student_360_cases.sql'));
});
