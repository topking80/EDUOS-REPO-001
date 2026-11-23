// 37.7.3 broken connections: Express matches routes in registration order, so a
// parameter route such as GET /api/school-operations/:domain registered before
// GET /api/school-operations/command-center answers the fixed path itself (the
// command center returned 403 to every principal). This reads server.js's
// register order and each route file in source order and fails if any fixed
// path is preceded by a parameter route of the same method that matches it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = p => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

export function orderedRoutes() {
  const server = src("server.js");
  const fileOf = new Map();
  for (const m of server.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/([^"]+)"/g))
    for (const name of m[1].split(",").map(s => s.trim()).filter(Boolean)) fileOf.set(name, m[2]);
  const routes = [];
  const collect = (text, file) => {
    const consts = {};
    for (const c of text.matchAll(/const\s+([A-Za-z_]+)\s*=\s*["'`](\/[^"'`$]*)["'`]/g)) consts[c[1]] = c[2];
    for (const m of text.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*(?:(["'`])([^"'`]+)\2|([A-Za-z_]+)\s*,)/g)) {
      const raw = m[3] ?? consts[m[4]];
      if (!raw) continue;
      const path = raw.replace(/\$\{([A-Za-z_]+)\}/g, (_, n) => consts[n] ?? ":tpl").replace(/\$\{[^}]*\}/g, ":tpl");
      routes.push({ method: m[1].toUpperCase(), path, where: `${file}:${text.slice(0, m.index).split("\n").length}` });
    }
  };
  // Routes declared in server.js itself before the register calls, then each
  // register call in order (its file's routes in source order).
  const firstRegister = server.search(/^register[A-Za-z]+\(app/m);
  collect(server.slice(0, firstRegister), "server.js");
  for (const m of server.slice(firstRegister).matchAll(/^(register[A-Za-z]+)\(app/gm)) {
    const file = fileOf.get(m[1]);
    if (file) collect(src(file), file);
  }
  return routes;
}

const pattern = p => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\*]/g, "\\$&").replace(/:[A-Za-z_]+/g, "[^/]+") + "$");

test("no parameter route is registered ahead of a fixed path it would swallow", () => {
  const routes = orderedRoutes();
  assert.ok(routes.length > 400, `found only ${routes.length} routes; the scan is broken`);
  const shadowed = [];
  routes.forEach((fixed, i) => {
    if (fixed.path.includes(":")) return;
    for (const earlier of routes.slice(0, i))
      if (earlier.method === fixed.method && earlier.path.includes(":") && pattern(earlier.path).test(fixed.path))
        shadowed.push(`${fixed.method} ${fixed.path} (${fixed.where}) is answered by ${earlier.path} (${earlier.where})`);
  });
  assert.deepEqual(shadowed, []);
});

test("the school operations command center, schedules and reminder settings are reachable", () => {
  const routes = orderedRoutes();
  const at = (method, path) => routes.findIndex(r => r.method === method && r.path === path);
  const catchAll = at("GET", "/api/school-operations/:domain");
  assert.ok(catchAll >= 0);
  for (const p of ["/api/school-operations/command-center", "/api/school-operations/schedules", "/api/school-operations/notification-preferences"])
    assert.ok(at("GET", p) >= 0 && at("GET", p) < catchAll, p);
  assert.ok(at("POST", "/api/school-operations/schedules") < at("POST", "/api/school-operations/:domain"));
});
