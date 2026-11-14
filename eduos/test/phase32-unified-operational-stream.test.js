import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const migration=readFileSync(new URL('../db/016_operational_event_stream.sql',import.meta.url),'utf8');
const bridge=readFileSync(new URL('../public/api-bridge.js',import.meta.url),'utf8');
const migrate=readFileSync(new URL('../src/migrate.js',import.meta.url),'utf8');

test('operational stream requires an authenticated audit reader',()=>{
  assert.match(server,/app\.get\("\/api\/operations\/stream",requireSession,requirePermission\("audit","read"\)/);
  assert.match(server,/LISTEN eduos_operational_events/);
});

test('stream re-reads notifications in the subscriber tenant and school scope',()=>{
  assert.match(server,/notice\.districtId!==req\.actor\.districtId/);
  assert.match(server,/withTenantTransaction\(req\.actor/);
  assert.match(server,/school_id=\$2::uuid/);
  assert.match(server,/res\.on\(\"close\",close\)/);
  assert.doesNotMatch(server,/req\.on\(\"close\",close\)/);
  assert.match(server,/resource_type,outcome/);
  assert.doesNotMatch(server,/payload\.detail|payload\.resourceId|payload\.studentId/);
});

test('PostgreSQL trigger publishes only district and event identifiers',()=>{
  assert.match(migration,/AFTER INSERT ON audit_events/);
  assert.match(migration,/pg_notify\(/);
  assert.match(migration,/json_build_object\('districtId', NEW\.district_id, 'eventId', NEW\.id\)/);
  assert.doesNotMatch(migration,/NEW\.(detail|resource_id|actor_user_id|school_id)/);
});

test('migration is registered in the ordered migration runner',()=>{
  assert.match(migrate,/016_operational_event_stream\.sql/);
});

test('audit workspace uses EventSource only while authorized audit view is active',()=>{
  assert.match(bridge,/new EventSource\("\/api\/operations\/stream"/);
  assert.match(bridge,/operationalStream\.close\(\)/);
  assert.match(bridge,/activeTab!=="audit"/);
  assert.match(bridge,/addEventListener\("operational"/);
});

test('SSE payload includes only fixed operational taxonomy metadata in addition to scoped audit fields',()=>{
  assert.match(server,/classifyOperationalEvent\(\{action:row\.action,resourceType:row\.resource_type,outcome:row\.outcome\}\)/);
  assert.match(server,/eventType:classification\.type/);
  assert.match(server,/label:classification\.label/);
  assert.match(server,/severity:classification\.severity/);
  const sender=server.slice(server.indexOf('const send=(row,eventName="operational")'),server.indexOf('const visibleSql='));
  assert.doesNotMatch(sender,/detail:row\.detail|studentName:|studentId:|resourceId:/);
  assert.match(bridge,/JSON\.parse\(event\.data\|\|"\{\}"\)/);
});


test('SSE stream bounds slow-client buffering and relies on Last-Event-ID replay',()=>{
  assert.match(server,/MAX_PENDING_FRAMES=128/);
  assert.match(server,/pendingFrames\.length>=MAX_PENDING_FRAMES/);
  assert.match(server,/res\.on\("drain",onDrain\)/);
  assert.match(server,/res\.off\("drain",onDrain\)/);
  assert.match(server,/heartbeat\.unref\?\.\(\)/);
  assert.match(server,/Last-Event-ID/);
});


test('stream subscribes before replay and buffers notifications until replay completes',()=>{
  const route=server.slice(server.indexOf('app.get("/api/operations/stream"'),server.indexOf('// Records only a bounded orchestration category'));
  assert.match(route,/let replaying=true/);
  assert.match(route,/MAX_NOTIFICATION_BACKLOG=500/);
  assert.match(route,/listener\.on\("notification",onNotification\)/);
  assert.ok(route.indexOf('listener.on("notification",onNotification)') < route.indexOf('const lastId='));
  assert.match(route,/if\(replaying\)/);
  assert.match(route,/replaying=false/);
  assert.match(route,/notificationBacklog\.splice\(0\)/);
  assert.match(route,/notificationBacklog\.length=0/);
});
