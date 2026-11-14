import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const bridge = await readFile(new URL("../public/api-bridge.js", import.meta.url), "utf8");

test("Connected Services UI includes distinct authenticated and demo states", () => {
  assert.match(bridge, /state\("Authenticated",true\)/);
  assert.match(bridge, /Demo mode · not signed in/);
  assert.match(bridge, /Local demonstration workspace/);
});

test("Connected Services UI communicates record loading", () => {
  assert.match(bridge, /state\("Loading records…",true\)/);
});

test("Connected Services UI has visible keyboard focus styling", () => {
  assert.match(bridge, /:focus-visible/);
  assert.match(bridge, /outline-offset:2px/);
});

test("Connected Services UI has responsive table and header styling", () => {
  assert.match(bridge, /@media\(max-width:700px\)/);
  assert.match(bridge, /overflow:auto/);
  assert.match(bridge, /position:sticky/);
});

test("Connected Services UI preserves the existing server API contracts", () => {
  for (const route of [
    "/api/me", "/api/schools", "/api/students", "/api/assignments",
    "/api/attendance", "/api/cases", "/api/audit"
  ]) {
    assert.ok(bridge.includes(route), `missing API route ${route}`);
  }
  assert.match(bridge, /const esc=v=>/);
});
