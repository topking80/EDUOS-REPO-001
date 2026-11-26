import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const routes = readFileSync("src/weather-routes.js", "utf8");

test("vice principals can read weather settings using the safety read permission", () => {
  assert.match(routes, /const LEADS\s*=\s*\["principal",\s*"vice_principal",\s*"superintendent"\]/);
  assert.match(routes, /app\.get\(["']\/api\/safety\/weather["'],\s*requireSession,\s*requirePermission\(["']safety["'],\s*["']read["']\),\s*lead/);
});

test("weather settings remain scoped to the vice principal's own school", () => {
  assert.match(routes, /const scopeOf\s*=\s*a\s*=>\s*a\.role\s*===\s*"superintendent"\s*\?\s*null\s*:\s*a\.schoolId/);
  assert.match(routes, /WHERE s\.status='active' AND \(\$1::uuid IS NULL OR s\.id=\$1\)/);
  assert.match(routes, /WHERE \(\$1::uuid IS NULL OR school_id=\$1\)/);
  assert.match(routes, /WHERE a\.ended_at IS NULL AND \(a\.expires IS NULL OR a\.expires > now\(\)\) AND \(\$1::uuid IS NULL OR a\.school_id=\$1\)/);
});

test("vice-principal weather pass-on writes stay restricted to their own school", () => {
  assert.match(routes, /app\.put\(["']\/api\/safety\/weather\/share["'][\s\S]*?\["principal",\s*"vice_principal",\s*"superintendent"\]/);
  assert.match(routes, /if \(a\.role !== "superintendent" && schoolId !== a\.schoolId\) throw new HttpError\(404, "school_not_found"\)/);
});
