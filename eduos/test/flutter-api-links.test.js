// Every server path the Flutter app calls must exist on the server: the app's
// '/api/...' and '/auth/...' strings (with Dart interpolations as
// parameters) are matched against the Express routes in src/.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const walk = (dir, ext) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(dir, e.name), ext) : e.name.endsWith(ext) ? [path.join(dir, e.name)] : []);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Dart string literals, keeping ${...} interpolations whole (they may contain quotes).
function dartStrings(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (src.startsWith("//", i)) { const n = src.indexOf("\n", i); i = n < 0 ? src.length : n; continue; }
    const q = src[i];
    if (q !== "'" && q !== '"') continue;
    let j = i + 1, buf = "";
    while (j < src.length && src[j] !== q && src[j] !== "\n") {
      if (src[j] === "\\") { buf += src.slice(j, j + 2); j += 2; continue; }
      if (src[j] === "$" && src[j + 1] === "{") {
        let d = 1, k = j + 2;
        while (k < src.length && d) { if (src[k] === "{") d++; else if (src[k] === "}") d--; k++; }
        buf += "${" + src.slice(j + 2, k - 1) + "}"; j = k; continue;
      }
      buf += src[j++];
    }
    out.push(buf); i = j;
  }
  return out;
}

function clientPaths() {
  const found = new Map();
  for (const f of walk(path.join(ROOT, "mobile/flutter/lib"), ".dart")) {
    const src = fs.readFileSync(f, "utf8");
    // String getters and constants used as path prefixes (e.g. `String get _base => '/api/...'`).
    const vars = Object.fromEntries([...src.matchAll(/String get (_?\w+)\s*=>\s*'([^']*)'/g), ...src.matchAll(/(?:const|final) (?:String )?(_?\w+)\s*=\s*'(\/[^']*)'/g)].map(m => [m[1], m[2]]));
    for (let s of dartStrings(src)) {
      for (const [k, v] of Object.entries(vars)) s = s.split("${" + k + "}").join(v).replace(new RegExp("\\$" + k + "(?![\\w])", "g"), v);
      if (!/^\/(api|auth)\//.test(s)) continue;
      const p = s.split("?")[0].replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*/g, ":p");
      if (/:p$/.test(p) && Object.values(vars).some(v => p === v.replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*/g, ":p"))) continue; // a getter's own definition
      if (!found.has(p)) found.set(p, path.relative(ROOT, f));
    }
  }
  return found;
}

function serverRoutes() {
  const pats = [];
  for (const f of walk(path.join(ROOT, "src"), ".js")) {
    const src = fs.readFileSync(f, "utf8");
    const bases = [...new Set([...src.matchAll(/['"`](\/(?:api|auth)[A-Za-z0-9/_\-:]*)['"`]/g)].map(m => m[1]))];
    const loops = {};
    for (const m of src.matchAll(/for \(const \[(\w+)[^\]]*\] of \[([\s\S]*?)\]\)/g)) loops[m[1]] = [...m[2].matchAll(/\[\s*"([^"]+)"/g)].map(x => x[1]);
    for (const m of src.matchAll(/for \(const (\w+) of \[([^\]]*)\]\)/g)) loops[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map(x => x[1]);
    const add = r => pats.push(new RegExp("^" + esc(r).replace(/:[A-Za-z_]+(?:\\\([^)]*\\\))?/g, "[^/]+") + "$"));
    for (const m of src.matchAll(/\b(?:app|router)\.(?:get|post|put|patch|delete|all)\(\s*(['"`])(.*?)\1/g)) {
      let cands = [m[2]];
      for (let guard = 0; cands.some(c => c.includes("${")) && guard < 4; guard++)
        cands = cands.flatMap(c => { const v = /\$\{(\w+)\}/.exec(c); if (!v) return [];
          return (loops[v[1]] || bases).map(b => c.slice(0, v.index) + b + c.slice(v.index + v[0].length)); });
      cands.filter(c => !c.includes("${")).forEach(add);
    }
    // Helpers that register `${prefix}/${name}` routes, e.g. the safety lead transitions.
    for (const m of src.matchAll(/const (\w+) = \(path, handler\) => app\.\w+\(`([^`]*)\$\{path\}`/g))
      for (const n of src.matchAll(new RegExp(`\\b${m[1]}\\("([\\w-]+)"`, "g"))) add(m[2] + n[1]);
  }
  return pats;
}

// Paths whose last segment is chosen at run time, with the values the app uses.
const RUNTIME_SEGMENTS = {
  "/api/school-operations/:p/:p/:p": ["status", "escalate"], // operations_screen.dart: _item(it, 'status' | 'escalate', ...)
};

test("every server path the Flutter app calls exists", () => {
  const client = clientPaths(), routes = serverRoutes();
  assert.ok(client.size > 100, `found ${client.size} client paths`);
  assert.ok(!routes.some(r => r.test("/api/no-such-thing/X")), "the matcher isn't a wildcard");
  const variants = p => RUNTIME_SEGMENTS[p] ? RUNTIME_SEGMENTS[p].map(last => p.replace(/:p$/, last)) : [p];
  const missing = [...client].filter(([p]) => !variants(p).every(v => routes.some(r => r.test(v.replaceAll(":p", "X1"))))).map(([p, f]) => `${p} (${f})`);
  assert.deepEqual(missing, []);
});
