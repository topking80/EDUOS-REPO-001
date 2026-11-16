// Every `npm run <script>` in the documentation names a script that exists in
// package.json (audit: docs told operators to run a script that didn't exist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const scripts = Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts || {});
const docs = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.name === "node_modules" || d.name.startsWith(".") ? [] : d.isDirectory() ? docs(join(dir, d.name)) : d.name.endsWith(".md") ? [join(dir, d.name)] : []);

test("documented npm scripts exist", () => {
  const files = docs(root);
  assert.ok(files.length > 3);
  let checked = 0;
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/npm run ([a-z0-9:_-]+)/gi)) {
    checked++;
    assert.ok(scripts.includes(m[1]), `${f.slice(root.length)}: "npm run ${m[1]}" isn't a script (have: ${scripts.join(", ")})`);
  }
  assert.ok(checked > 0);
});
