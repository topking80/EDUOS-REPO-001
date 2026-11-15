import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = (readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')+readFileSync(new URL('../public/legacy-app.js', import.meta.url), 'utf8'));

test('workspace navigation includes an accessible search with Escape to clear', () => {
  assert.match(html, /id="workspaceSearch" type="search"/);
  assert.match(html, /function applyWorkspaceSearch\(\)/);
  assert.match(html, /if\(e\.key==="Escape"\)/);
  assert.match(html, /role="status"/);
});

test('keyboard users can skip navigation and focus workspace content', () => {
  assert.match(html, /class="skip-link" href="#content"/);
  assert.match(html, /id="content" tabindex="-1"/);
  assert.match(html, /content\.focus\(\{preventScroll:true\}\)/);
  assert.match(html, /button:focus-visible/);
});

test('navigation exposes the active page to assistive technology', () => {
  assert.match(html, /aria-current=page/);
  assert.match(html, /b\.setAttribute\("aria-current","page"\)/);
});

test('demo and authenticated API data boundaries remain explicit in the shell', () => {
  assert.match(html, /Local demo data · API services require sign-in/);
  assert.match(html, /DEMO MODE/);
});
