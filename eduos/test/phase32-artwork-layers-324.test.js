import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const assets=new URL("../public/assets/",import.meta.url);
test("new layered campus, learning and platform artwork assets exist",()=>{for(const f of ["eduos-campus-systems-cutaway.svg","eduos-learning-evidence-flow.svg","eduos-platform-layer-stack.svg"])assert.ok(fs.existsSync(new URL(f,assets)),f)});
test("layered artwork suite is wired into persona workspaces",()=>{assert.match(html,/classroomPlanningSuite\(\)\+personaArtwork\(role\)\+commandCenterArtwork\(\)\+eduosLayeredArtSuite\(\)/);assert.match(html,/function eduosLayeredArtSuite\(\)/)});
test("artwork suite includes accessible labels and conceptual-data caveat",()=>{assert.match(html,/aria-label="EduOS expanded visual systems"/);assert.match(html,/not represent live telemetry/)});
test("responsive layout and reduced motion-safe static artwork remain available",()=>{assert.match(html,/eduos-layered-art-grid/);assert.match(html,/max-width:560px/)});
