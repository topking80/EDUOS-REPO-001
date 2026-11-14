import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const root=process.cwd(),html=fs.readFileSync(path.join(root,"public/index.html"),"utf8");
const names=["eduos-district-learning-loop.svg","eduos-governance-layers.svg","eduos-school-edge-stack.svg"];
test("three additional project-aligned SVG visual layers are integrated",()=>{for(const n of names){const s=fs.readFileSync(path.join(root,"public/assets",n),"utf8");assert.match(s,/<svg[\s\S]*<title/);assert.match(s,/conceptual/i);assert.ok(html.includes(n));}});
test("visual layers appear in superintendent overview and persona home workspaces",()=>{assert.match(html,/operatingVisualLayers\(\)/);assert.match(html,/classroomPlanningSuite\(\)\+personaArtwork\(role\)\+commandCenterArtwork\(\)\+eduosLayeredArtSuite\(\)\+operatingVisualLayers\(\)\+expandedVisualGallery\(\)/);assert.match(html,/projectArtwork\([\s\S]*?operatingVisualLayers\(\)/);});
test("visual layers are responsive and respect reduced motion",()=>{assert.match(html,/eduos-layer-card/);assert.match(html,/prefers-reduced-motion:reduce/);assert.match(html,/@media\(max-width:850px\)/);});
