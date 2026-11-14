import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('mobile/flutter/lib/branding/eduos_mascot.dart', 'utf8');

test('mascot SVG fallback has a lifecycle-managed animation controller', () => {
  assert.match(source, /AnimationController\([\s\S]*duration: const Duration\(milliseconds: 2400\)/);
  assert.match(source, /WidgetsBindingObserver, SingleTickerProviderStateMixin/);
  assert.match(source, /_fallbackMotion\.dispose\(\)/);
  assert.match(source, /_fallbackMotion\.stop\(\)/);
});

test('fallback maps semantic actions to distinct motion cues', () => {
  assert.match(source, /final wave = _runtimeAction == EduMascotAction\.greet/);
  assert.match(source, /final celebrate = _runtimeAction == EduMascotAction\.celebrate/);
  assert.match(source, /final help = _runtimeAction == EduMascotAction\.help/);
  assert.match(source, /Transform\.rotate/);
  assert.match(source, /Transform\.translate/);
});

test('fallback uses mood as a restrained brand accent blend', () => {
  assert.match(source, /Color\.lerp\(brand\.primary, brand\.accent/);
});
