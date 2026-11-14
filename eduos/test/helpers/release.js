// Shared release-metadata checks. Tests compare release markers against the
// current package version instead of hardcoding a release number, so a version
// bump never needs test edits but any drift between artifacts still fails.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const pkg = JSON.parse(read('package.json'));
export const RELEASE = pkg.version;
export const RELEASE_RE = escape(RELEASE);

/** Package, lockfile, app title, sidebar label and service-worker cache all name one release. */
export function assertReleaseMetadataAligned() {
  assert.match(RELEASE, /^\d+\.\d+\.\d+$/, 'package.json version must be MAJOR.MINOR.PATCH');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, RELEASE, 'package-lock.json version');
  assert.equal(lock.packages[''].version, RELEASE, 'package-lock.json root package version');
  const html = read('public/index.html');
  assert.match(html, new RegExp(`<title>EduOS District Edition ${RELEASE_RE}\\b`), 'index.html <title>');
  assert.match(html, new RegExp(`District Edition · ${RELEASE_RE}\\b`), 'index.html sidebar release label');
  const sw = read('public/app/sw.js');
  assert.match(sw, new RegExp(`const SHELL = "eduos-app-shell-${RELEASE_RE}"`), 'service worker cache name');
}
