// Every API and sign-in route sits behind a per-credential and a per-address
// rate limit, mounted before any route is registered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
test("the API ceiling is mounted before the first route", () => {
  const mount = server.indexOf('app.use(["/api","/auth"],apiAddressLimiter,apiLimiter);');
  assert.ok(mount > 0, "mounted");
  const firstRoute = server.search(/app\.(get|post|put|patch|delete)\(/);
  assert.ok(mount < firstRoute, "before any route");
  assert.match(server, /limit:config\.apiRateLimitPerMinute\*10/);
  assert.match(server, /createHash\("sha256"\)\.update\(c\)/, "credentials are hashed, never used as keys");
});
