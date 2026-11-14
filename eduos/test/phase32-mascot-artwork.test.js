import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

test('EduOS mascot SVG is bundled, layered, and has accessible metadata', async () => {
  const svg = await read('mobile/flutter/assets/branding/eduos_mascot.svg');
  for (const marker of ['<svg', 'aria-labelledby=', '<title', '<desc', 'id="Root"', 'id="Head"', 'id="Torso"', 'id="Arm_L"', 'id="Arm_R"', 'id="Leg_L"', 'id="Leg_R"', 'id="Accessories"']) assert.ok(svg.includes(marker), `missing ${marker}`);
});

test('rig specification matches Flutter state-machine input contract', async () => {
  const spec = JSON.parse(await read('mobile/flutter/assets/branding/eduos_mascot.rig.json'));
  assert.equal(spec.artboard, 'EduOS_Mascot');
  assert.equal(spec.stateMachine, 'Character_Controller');
  for (const input of ['onGreet', 'onSuccess', 'onError', 'mood', 'lookX', 'lookY']) assert.ok(input in spec.inputs);
  assert.deepEqual(spec.layers.Eye_Blink.randomExitSeconds, [3, 5]);
  assert.equal(spec.inputs.mood.blendSeconds, 0.2);
});

test('Flutter fallback renders the bundled SVG rather than an icon-only placeholder', async () => {
  const dart = await read('mobile/flutter/lib/branding/eduos_mascot.dart');
  const pubspec = await read('mobile/flutter/pubspec.yaml');
  assert.ok(dart.includes("import 'package:flutter_svg/flutter_svg.dart';"));
  assert.ok(dart.includes("assets/branding/eduos_mascot.svg"));
  assert.ok(pubspec.includes('flutter_svg: ^2.0.17'));
});
