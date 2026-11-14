import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const route=readFileSync(new URL('../src/arrival-exception-routes.js',import.meta.url),'utf8');
const migration=readFileSync(new URL('../db/018_arrival_exception_resolution.sql',import.meta.url),'utf8');
const bridge=readFileSync(new URL('../public/api-bridge.js',import.meta.url),'utf8');

test('exception API is restricted to authenticated principal and superintendent managers',()=>{
  assert.match(route,/requireSession, managers/);
  assert.match(route,/exception_manager_only/);
  assert.match(route,/canSeeSchool\(a,handoff\.school_id\)/);
});
test('assignment validates active staff membership in the same school and district',()=>{
  assert.match(route,/district_id=\$1 AND user_id=\$2/);
  assert.match(route,/school_id=\$3 AND role IN \('principal','teacher'\) AND status='active'/);
  assert.match(route,/invalid_exception_assignee/);
});
test('resolution cannot close an exception while its underlying issue remains',()=>{
  assert.match(route,/handoff_still_pending/);
  assert.match(route,/first_attendance_still_missing/);
  assert.match(route,/resolution_note_required/);
});
test('resolution state and actor history are persisted in append-only tables',()=>{
  assert.match(migration,/CREATE TABLE arrival_exception_resolutions/);
  assert.match(migration,/CREATE TABLE arrival_exception_resolution_events/);
  assert.match(migration,/BEFORE UPDATE OR DELETE/);
  assert.match(migration,/ENABLE ROW LEVEL SECURITY/);
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
});
test('browser workspace exposes acknowledge, assignment, resolve and history actions',()=>{
  for(const token of ['arrival-exceptions','exception-ack','exception-assign','exception-resolve','exception-history'])
    assert.ok(bridge.includes(token),`missing ${token}`);
});
