import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("all five persona navigation entries resolve to registered workspaces", () => {
  const menu = html.match(/const roleMenus=\{([\s\S]*?)\n\};\nconst personaConfig/);
  const registry = html.match(/const renderers=\{([^}]+)\}/);
  assert.ok(menu, "persona menu registry exists");
  assert.ok(registry, "workspace renderer registry exists");
  const menuPages = [...menu[1].matchAll(/pages:\[([^\]]+)\]/g)]
    .flatMap(match => [...match[1].matchAll(/["']([a-zA-Z0-9_-]+)["']/g)].map(x => x[1]));
  const rendererPages = new Set(registry[1].split(",").map(entry => entry.trim().split(":")[0].trim()));
  assert.equal(menuPages.length > 0, true);
  for (const page of menuPages) assert.ok(rendererPages.has(page), `missing renderer for ${page}`);
  assert.equal((menu[1].match(/^[ \t]*(?:superintendent|principal|teacher|parent|pupil):\{/gm) || []).length, 5,
    "all five personas are represented");
});

test("persona home quick-access and workspace-tree buttons are delegated to navigation", () => {
  assert.match(html, /#content button\[data-page\]/,
    "content-area page buttons must be handled, not only sidebar buttons");
  assert.match(html, /b\.closest\("\[data-act\]"\)/,
    "buttons with a dedicated action handler must not navigate twice");
  assert.match(html, /roleInfo\.tiles\.map\(.*data-page=/s,
    "quick-access tiles expose their destination");
});

test("navigation error messages are escaped before entering the DOM", () => {
  assert.match(html, /role='alert'><h2>That section could not open<\/h2><p>"\+esc\(err\.message/);
});

test("workspace route guard rejects pages outside the selected persona", () => {
  assert.match(html, /!personaConfig\[activePersona\]\.pages\.includes\(p\)/);
  assert.match(html, /if\(p==="audit"&&!\["superintendent","principal"\]\.includes\(activePersona\)\)/);
});
