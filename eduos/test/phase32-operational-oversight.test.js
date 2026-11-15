import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeAgentEvent } from '../src/agent-events.js';

const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../public/api-bridge.js', import.meta.url), 'utf8');
const html = (readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')+readFileSync(new URL('../public/legacy-app.js', import.meta.url), 'utf8'));

test('agent event normalizer accepts only bounded, category-specific routes', () => {
  const event = normalizeAgentEvent({runId:'ORCH-MI9ABC12',category:'attendance',route:['Christie AI','Aurora','Christie AI']});
  assert.deepEqual(event.route, ['Christie AI','Aurora','Christie AI']);
  assert.equal(event.category, 'attendance');
});

test('agent event normalizer rejects raw prompt fields and unexpected route handoffs', () => {
  assert.equal(normalizeAgentEvent({runId:'ORCH-MI9ABC12',category:'attendance',route:['Christie AI','Aurora','Christie AI'],question:'private prompt'}), null);
  assert.equal(normalizeAgentEvent({runId:'ORCH-MI9ABC12',category:'attendance',route:['Christie AI','Vulcan','Christie AI']}), null);
  assert.equal(normalizeAgentEvent({runId:'ORCH-MI9ABC12',category:'unknown',route:['Christie AI','Christie AI']}), null);
});

test('server agent-event route requires session, CSRF and leadership audit permission', () => {
  assert.match(server, /app\.post\("\/api\/agent-events",requireSession,requireCsrf,requirePermission\("audit","read"\)/);
  assert.match(server, /normalizeAgentEvent\(req\.body\)/);
  assert.match(server, /action:"agent_orchestration"/);
  assert.match(server, /resourceType:"agent_orchestration"/);
});

test('server agent-event audit metadata excludes arbitrary prompt and generated output', () => {
  const route = server.slice(server.indexOf('app.post("/api/agent-events"'), server.indexOf('app.post("/api/audit/export"'));
  assert.match(route, /category=\$\{event\.category\};route=/);
  assert.doesNotMatch(route, /req\.body\.question|req\.body\.prompt|req\.body\.detail/);
});

test('connected services shows operational notices only to staff and leaders', () => {
  assert.match(bridge, /function operationalNotices\(role\)/);
  assert.match(bridge, /Overdue intervention follow-ups/);
  assert.match(bridge, /High-priority intervention cases/);
  assert.match(bridge, /Access requests awaiting review/);
  assert.match(bridge, /Denied actions recorded/);
  assert.match(bridge, /if\(!\["superintendent","principal","teacher"\]\.includes\(role\)\)return/);
});

test('agent orchestration distinguishes local-only runs from server-recorded runs', () => {
  assert.match(html, /auditStatus:"Local only"/);
  assert.match(html, /window\.EduOSApi\.logAgentRun\(run\)/);
  assert.match(html, /run\.auditStatus="Server recorded"/);
  assert.match(html, /run\.auditStatus="Not recorded"/);
});

test('audit workspace separates bounded agent trace metadata from general audit rows', () => {
  assert.match(bridge, /Server-recorded agent orchestration/);
  assert.match(bridge, /resource_type==="agent_orchestration"/);
  assert.match(bridge, /Original questions and generated output are not stored/);
});
