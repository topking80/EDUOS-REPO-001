import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '../mobile/flutter/lib/branding/eduos_mascot.dart'), 'utf8');

test('mascot honors operating-system reduced-motion preference', () => {
  assert.match(source, /MediaQuery\.disableAnimationsOf\(context\)/);
  assert.match(source, /if \(_reduceMotion\)\s*\{\s*return Semantics/s);
  assert.match(source, /_artboard\?\.pause\(\)/);
});

test('mascot exposes one accessible label and hides duplicate Rive semantics', () => {
  assert.match(source, /label: 'EduOS student helper mascot'/);
  assert.match(source, /ExcludeSemantics\(child: Rive/);
});

test('animation resumes only when app is foregrounded and motion is allowed', () => {
  assert.match(source, /final shouldAnimate = _foreground && !_reduceMotion/);
  assert.match(source, /_foreground = state == AppLifecycleState\.resumed/);
});
