import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const orchestration = html.slice(html.indexOf('function classifyDistrictQuestion'), html.indexOf('const districtProfiles'));
test('Christie coordinates bounded topic-specific specialist routing', () => {
  assert.match(orchestration, /function classifyDistrictQuestion/);
  assert.match(orchestration, /attendance.*specialists:\[3\]/s);
  assert.match(orchestration, /infrastructure.*specialists:\[1\]/s);
  assert.match(orchestration, /platform-operations.*specialists:\[2,3\]/s);
  assert.match(orchestration, /district-overview.*specialists:\[\]/s);
});
test('orchestration records intake, specialist handoffs and Christie synthesis', () => {
  assert.match(orchestration, /stage:"intake"/);
  assert.match(orchestration, /stage:"specialist-analysis"/);
  assert.match(orchestration, /stage:"synthesis"/);
  assert.match(orchestration, /data\.agentRuns\.unshift\(run\)/);
});
test('orchestration audit stores category and route but not the raw user prompt', () => {
  assert.match(orchestration, /Store routing events, not the user's raw prompt/);
  assert.match(orchestration, /category:route\.category/);
  assert.doesNotMatch(orchestration, /question\s*:\s*question/);
});
test('orchestration uses existing deterministic agent briefs and discloses local-only execution', () => {
  assert.match(orchestration, /agentBrief\(index\)/);
  assert.match(orchestration, /local synthetic school directory/);
  assert.match(orchestration, /no live district systems or external AI inference/);
});
test('command center displays handoff traces and recent orchestration runs', () => {
  const command = html.slice(html.indexOf('function command()'), html.indexOf('function classifyDistrictQuestion'));
  assert.match(command, /Recent orchestration runs/);
  assert.match(command, /Handoff sequence/);
  assert.match(command, /not an authenticated agent runtime/);
  assert.match(command, /server-side permissions at every handoff/);
});
test('question input is bounded and blank questions are rejected', () => {
  assert.match(html, /maxlength="240"/i);
  assert.match(orchestration, /if\(!q\)/);
  assert.match(orchestration, /q\.length>240/);
});
