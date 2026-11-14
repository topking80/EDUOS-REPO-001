import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Flutter starter pins the Rive legacy input contract', () => {
  const pubspec = read('mobile/flutter/pubspec.yaml');
  const mascot = read('mobile/flutter/lib/branding/eduos_mascot.dart');
  assert.match(pubspec, /rive:\s*\^0\.13\.20/);
  for (const input of ['onGreet', 'onSuccess', 'onError', 'mood', 'lookX', 'lookY']) {
    assert.ok(mascot.includes(`'${input}'`), `missing Rive input ${input}`);
  }
  assert.match(mascot, /RiveFile\.asset\(eduOsMascotAsset\)/);
  assert.match(mascot, /actionSequence/);
  assert.match(mascot, /EduMascotAction\.help/);
  assert.match(mascot, /_artboard\?\.pause\(\)/);
  assert.match(mascot, /_artboard\?\.play\(\)/);
});

test('Flutter starter has a no-asset fallback and explicit rigging contract', () => {
  const mascot = read('mobile/flutter/lib/branding/eduos_mascot.dart');
  const guide = read('mobile/flutter/README.md');
  assert.match(mascot, /_MascotFallback/);
  for (const token of ['Root', 'Hip', 'Look_Target', 'Base_Body', 'Face_Expressions', 'Eye_Blink', 'Eye_Tracking']) {
    assert.ok(guide.includes(token), `missing rigging contract ${token}`);
  }
  assert.equal(existsSync(new URL('../mobile/flutter/assets/branding/eduos_mascot.riv', import.meta.url)), false);
});
