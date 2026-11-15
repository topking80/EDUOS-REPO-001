import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// app.js is a module: a top-level reference to an undefined name throws while the
// module evaluates, so boot() never runs and the whole web app shows "Loading…".
// 37.4.0 shipped exactly that (VIEWS.operations = specializedOpsView, never defined).
const ui = fs.readFileSync(new URL("../public/app/app.js", import.meta.url), "utf8");

test("every view assigned by name is defined in app.js", () => {
  const assigned = [...ui.matchAll(/^VIEWS\.\w+\s*=\s*([A-Za-z_$][\w$]*)\s*;/gm)].map(m => m[1]);
  assert.ok(assigned.includes("specializedOpsView"), "the operations consoles are wired by name");
  for (const name of new Set(assigned)) {
    const defined = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(|^(?:const|let|var)\\s+${name}\\s*=`, "m").test(ui);
    assert.ok(defined, `VIEWS uses ${name}, which app.js never defines`);
  }
});

test("every role tab has a view", () => {
  const tabs = new Set([...ui.slice(ui.indexOf("const ROLE_TABS"), ui.indexOf("};", ui.indexOf("const ROLE_TABS"))).matchAll(/\["(\w+)", "/g)].map(m => m[1]));
  const views = new Set([...ui.matchAll(/^VIEWS\.(\w+)\s*=/gm)].map(m => m[1]));
  for (const t of tabs) assert.ok(views.has(t), `tab ${t} has no VIEWS.${t}`);
});

test("operations consoles never send details for health or counseling work", () => {
  assert.match(ui, /const OPS_SENSITIVE = \["counseling", "health_office"\]/);
  assert.match(ui, /OPS_SENSITIVE\.includes\(d\) \|\| !details\.value\.trim\(\) \? \{\} : \{ details: details\.value \}/);
});

test("no view is assigned twice (a later assignment silently replaces the first)", () => {
  const names = [...ui.matchAll(/^VIEWS\.(\w+)\s*=/gm)].map(m => m[1]);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dupes, [], `VIEWS assigned more than once: ${dupes.join(", ")}`);
});
