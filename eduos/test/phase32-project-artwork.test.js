import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".");
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

test("project architecture, deployment and service-flow artwork is shipped", () => {
  for (const file of [
    "eduos-architecture-overview.png",
    "eduos-deployment-options.png",
    "eduos-core-services-flow.png",
    "eduos-five-persona-workspaces.svg"
  ]) {
    const asset = path.join(root, "public/assets", file);
    assert.ok(fs.existsSync(asset), `missing artwork asset: ${file}`);
    assert.ok(fs.statSync(asset).size > 500, `artwork asset is unexpectedly small: ${file}`);
  }
});

test("artwork is attached to the relevant existing workspaces", () => {
  assert.match(html, /function overview\([\s\S]*?projectArtwork\("eduos-architecture-overview\.png"/);
  assert.match(html, /function planner\([\s\S]*?projectArtwork\("eduos-deployment-options\.png"/);
  assert.match(html, /function agents\([\s\S]*?projectArtwork\("eduos-core-services-flow\.png"/);
  assert.match(html, /function roleHomePage\([\s\S]*?personaArtwork\(role\)/);
});

test("artwork has alt text and the persona view preserves its security boundary", () => {
  assert.match(html, /alt="\$\{esc\(caption\)\}"/);
  assert.match(html, /Five EduOS workspaces: Superintendent, Principal, Teacher, Parent or Guardian, and Pupil/);
  assert.match(html, /Switching personas does not authenticate a user or grant server permissions/);
});
