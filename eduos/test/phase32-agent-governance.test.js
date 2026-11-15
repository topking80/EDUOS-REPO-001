import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = (readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')+readFileSync(new URL('../public/legacy-app.js', import.meta.url), 'utf8'));
const agents = html.slice(html.indexOf('function agentContract'), html.indexOf('function reports'));
const runner = html.slice(html.indexOf('function runAgent'), html.indexOf('function exportData'));
test('four agents have distinct, bounded operational contracts', () => {
  for (const name of ['Christie AI','Helios','Vulcan','Aurora']) assert.ok(html.includes(name));
  for (const phrase of ['Authorized demo scope','Inputs','Output','Boundary','No external AI inference']) assert.ok(agents.includes(phrase));
  assert.match(agents, /Cannot make student-level decisions/);
  assert.match(agents, /Cannot inspect live networks/);
  assert.match(agents, /Cannot deploy code/);
  assert.match(agents, /Cannot monitor production telemetry/);
});
test('agent results are derived from local synthetic school data and disclose their basis', () => {
  assert.match(agents, /function agentBrief/);
  assert.match(agents, /data\.schools/);
  assert.match(agents, /synthetic school-level attendance/);
  assert.match(agents, /not a live alert/);
});
test('running an agent logs a local analysis and explicitly disclaims external execution', () => {
  assert.match(runner, /agentBrief\(i\)/);
  assert.match(runner, /Synthetic district dataset/);
  assert.match(runner, /No external AI inference, live telemetry, or system changes occurred/);
});
