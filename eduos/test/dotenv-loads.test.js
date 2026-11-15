import test from "node:test";
import assert from "node:assert/strict";

// src/config.js loads dotenv with `import("dotenv/config")` and quietly skips it
// when the module is missing, so production can inject variables directly. That
// means a dotenv upgrade that moved or dropped the "./config" export would stop
// loading .env files in development without any error. Pin the export here.
test("dotenv/config resolves, so .env files are loaded in development", () => {
  assert.match(import.meta.resolve("dotenv/config"), /node_modules\/dotenv\//);
});
