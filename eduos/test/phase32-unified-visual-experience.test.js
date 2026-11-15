import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const root=process.cwd(),html=(fs.readFileSync(path.join(root,"public/index.html"),"utf8")+fs.readFileSync(path.join(root,"public/legacy-app.js"),"utf8")),assets=path.join(root,"public/assets");
const names=["eduos-command-center-orbit.svg","eduos-school-building-cutaway.svg","eduos-classroom-learning-scene.svg"];
test("32.0.17 adds three original EduOS visual layers",()=>{for(const n of names){const s=fs.readFileSync(path.join(assets,n),"utf8");assert.match(s,/<svg[\s\S]*<title/);assert.match(s,/<desc\b/);assert.match(s,/Conceptual/);assert.ok(html.includes(n));}});
test("command center and expanded artwork appear in executive and persona workspaces",()=>{assert.match(html,/commandCenterArtwork\(\)/);assert.match(html,/expandedVisualGallery\(\)/);assert.match(html,/classroomPlanningSuite\(\)\+personaArtwork\(role\)\+commandCenterArtwork\(\)\+eduosLayeredArtSuite\(\)\+operatingVisualLayers\(\)\+expandedVisualGallery\(\)/);assert.match(html,/projectArtwork\("eduos-architecture-overview\.png"/);});
test("duplicate visual-layer renderer is removed and motion respects accessibility",()=>{assert.equal((html.match(/function operatingVisualLayers\(/g)||[]).length,1);assert.match(html,/prefers-reduced-motion:reduce/);assert.match(html,/@media\(max-width:850px\)/);});
