#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const errors = [];
const warn = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

check(lock.lockfileVersion === 3, `Expected package-lock v3; found ${lock.lockfileVersion}`);
check(lock.name === pkg.name, 'package-lock name does not match package.json');
check(lock.version === pkg.version, 'package-lock version does not match package.json');
check(lock.packages?.['']?.name === pkg.name, 'lockfile root package name mismatch');
check(lock.packages?.['']?.version === pkg.version, 'lockfile root package version mismatch');
check(JSON.stringify(lock.packages?.['']?.dependencies || {}) === JSON.stringify(pkg.dependencies || {}),
  'lockfile root dependencies do not exactly match package.json dependencies');
check(JSON.stringify(lock.packages?.['']?.devDependencies || {}) === JSON.stringify(pkg.devDependencies || {}),
  'lockfile root devDependencies do not exactly match package.json devDependencies');

const npmrc = fs.readFileSync(path.join(root, '.npmrc'), 'utf8');
check(/^registry=https:\/\/registry\.npmjs\.org\/$/m.test(npmrc), 'registry must be the official HTTPS npm registry');
check(/^strict-ssl=true$/m.test(npmrc), 'strict-ssl must remain enabled');

const installed = Object.entries(lock.packages || {}).filter(([key]) => key && !key.startsWith('node_modules/.'));
for (const [name, entry] of installed) {
  if (entry.link) {
    errors.push(`${name}: workspace/link dependency is not permitted in this release lockfile`);
    continue;
  }
  if (entry.resolved) {
    try {
      const url = new URL(entry.resolved);
      if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org') {
        errors.push(`${name}: unexpected package source ${url.origin}`);
      }
    } catch {
      errors.push(`${name}: invalid resolved URL`);
    }
  } else if (!entry.dev && !entry.optional && !entry.peer) {
    warn.push(`${name}: no resolved URL (verify if this is an intentional bundled/platform package)`);
  }
  if (entry.resolved && !entry.integrity) errors.push(`${name}: missing integrity hash`);
  if (entry.hasInstallScript) warn.push(`${name}: package declares an install script; review before approving updates`);
}

if (errors.length) {
  console.error('Dependency registry verification FAILED:');
  for (const item of errors) console.error(`- ${item}`);
  process.exitCode = 1;
} else {
  console.log(`Dependency registry verification passed (${installed.length} locked package entries).`);
}
if (warn.length) {
  console.warn('Review notices:');
  for (const item of warn) console.warn(`- ${item}`);
}
