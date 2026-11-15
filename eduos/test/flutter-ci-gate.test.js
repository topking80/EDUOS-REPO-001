import test from 'node:test';
import assert from 'node:assert/strict';
import { readCiWorkflow } from './helpers/ci-workflow.js';

test('CI runs Flutter analysis, tests, and Android compilation', async () => {
  const workflow = readCiWorkflow();
  assert.match(workflow, /flutter-mobile:/);
  assert.match(workflow, /flutter pub get/);
  assert.match(workflow, /flutter analyze --fatal-infos/);
  assert.match(workflow, /flutter test --reporter expanded/);
  assert.match(workflow, /flutter build apk --debug/);
  assert.match(workflow, /flutter-version: '3\.24\.5'/);
});
