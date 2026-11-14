import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const root=process.cwd();
const html=fs.readFileSync(path.join(root,"public/index.html"),"utf8");
test("project-derived layered operating model artwork is present",()=>{
 const svg=fs.readFileSync(path.join(root,"public/assets/eduos-operating-model-agent-map.svg"),"utf8");
 for(const term of ["STATE EDUCATION","DISTRICT CONTROL PLANE","SCHOOL / BUILDING EDGE","CHRISTIE AI","HELIOS","VULCAN","AURORA"]) assert.ok(svg.includes(term),`missing ${term}`);
 assert.match(svg,/not a live topology|not.*live/i);
});
test("AI agents page includes project map and original artwork gallery",()=>{
 assert.match(html,/agentSystemArtwork\(\)/); assert.match(html,/projectVisualGallery\(\)/);
 for(const file of ["eduos-architecture-overview.png","eduos-core-services-flow.png","eduos-deployment-options.png"]) assert.ok(html.includes(file));
});
test("artwork expansion remains accessible and responsive",()=>{
 assert.match(html,/prefers-reduced-motion:reduce/); assert.match(html,/@media\(max-width:850px\)/);
 assert.match(html,/alt=\"Conceptual EduOS operating model/);
});
