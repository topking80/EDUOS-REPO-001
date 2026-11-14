import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../mobile/flutter/lib/branding/', import.meta.url);
const widget = await readFile(new URL('eduos_mascot.dart', root), 'utf8');
const signals = await readFile(new URL('eduos_mascot_events.dart', root), 'utf8');

test('mascot accepts a stream of semantic outcome signals', () => {
  assert.match(widget, /Stream<EduOsMascotSignal>\? events/);
  assert.match(widget, /_eventSubscription = widget\.events\?\.listen\(_handleSignal\)/);
});
test('successful operational outcomes map to celebration without payload details', () => {
  for (const signal of ['attendanceRecorded', 'riderArrivalConfirmed', 'staffHandoffConfirmed', 'taskCompleted']) {
    assert.match(widget, new RegExp(`EduOsMascotSignal\\.${signal}`));
  }
  assert.match(widget, /_runtimeAction = EduMascotAction\.celebrate/);
});
test('safety and workflow exceptions map to help state', () => {
  assert.match(widget, /EduOsMascotSignal\.safetyAttentionRequired/);
  assert.match(widget, /EduOsMascotSignal\.workflowNeedsHelp/);
  assert.match(widget, /_runtimeAction = EduMascotAction\.help/);
});
test('event bridge contract forbids personal information in event stream', () => {
  assert.match(signals, /never put student identifiers, names, notes, or API payloads/);
  assert.doesNotMatch(signals, /studentId|studentName|payload\s*:/);
});
test('event subscription is cancelled on widget disposal', () => {
  assert.match(widget, /_eventSubscription\?\.cancel\(\)/);
});
