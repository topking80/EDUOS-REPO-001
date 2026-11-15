import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const html = (fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')+fs.readFileSync(path.join(root, 'public/legacy-app.js'), 'utf8'));
const vision = fs.readFileSync(path.join(root, 'public/eduos-vision.js'), 'utf8');
test('Device & Edge Operations is registered as a role-scoped workspace', () => {
  assert.match(html, /deviceops:deviceOpsPage/);
  assert.match(html, /deviceops:"Device & Edge Operations"/);
  assert.match(html, /"deviceops"/);
  assert.match(html, /pages:\["campus","schools","schooldetail","map","attendance","arrival","operations","deviceops"\]/);
});
test('Device & Edge Operations covers edge, enrollment, telemetry and update workflows', () => {
  for (const phrase of ['Role profiles','Edge & offline','Enrollment','Health & updates','Build readiness','Air-gapped mode','Prototype server is not production-safe','Update execution is simulated']) {
    assert.ok(html.includes(phrase), `Missing device operations content: ${phrase}`);
  }
});
test('device fleet metrics are labeled synthetic and checklist is local browser state', () => {
  assert.match(html, /Illustrative inventory only/);
  assert.match(html, /localStorage\.setItem\(key/);
  assert.match(html, /no device agent connected/);
});
test('Vision Studio deployment concepts link to Device & Edge Operations', () => {
  assert.match(vision, /"School technology"\s*:\s*"deviceops"/);
  assert.match(vision, /"Deployment pathways"\s*:\s*"deviceops"/);
});
// 32.0.54: the un-hardened reference copy was removed and tombstoned; the
// security review and the hardened tree (edge-platform/eduos) are retained.
test('deprecated edge reference bundle is tombstoned; security review is retained', () => {
  assert.ok(fs.existsSync(path.join(root, 'platform/edge-runtime-reference/DEPRECATED.md')));
  assert.ok(!fs.existsSync(path.join(root, 'platform/edge-runtime-reference/butane')));
  assert.ok(!fs.existsSync(path.join(root, 'platform/edge-runtime-reference/ignition')));
  assert.ok(fs.existsSync(path.join(root, 'edge-platform/eduos/scripts/eduos-enrollment.sh')));
  assert.ok(fs.existsSync(path.join(root, 'EDGE-RUNTIME-SECURITY-REVIEW-32.0.39.md')));
});
