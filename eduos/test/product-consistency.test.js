import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assertReleaseMetadataAligned } from "./helpers/release.js";
const root=process.cwd();
const html=(readFileSync(join(root,"public/index.html"),"utf8")+readFileSync(join(root,"public/legacy-app.js"),"utf8"));
const bridge=readFileSync(join(root,"public/api-bridge.js"),"utf8");
test("parent portal is available only in the parent workspace navigation",()=>{
 const start=html.indexOf("const roleMenus="),end=html.indexOf("const personaConfig",start),nav=html.slice(start,end);
 const teacher=nav.slice(nav.indexOf("teacher:{"),nav.indexOf("parent:{"));
 const parent=nav.slice(nav.indexOf("parent:{"),nav.indexOf("pupil:{"));
 assert.doesNotMatch(teacher,/parentportal/);
 assert.match(parent,/parentportal/);
});
test("authenticated parent portal renders server-backed family records",()=>{
 assert.match(html,/parentPortalAuthenticatedPage/);
 assert.match(html,/parentPortalLoadServerData/);
 assert.match(html,/familyChildSummary/);
 assert.match(html,/familyChildren/);
});
test("family artwork is integrated into parent portal demo and authenticated views",()=>{
 assert.match(html,/eduos-family-portal-flow\.svg/);
 assert.ok(existsSync(join(root,"public/assets/eduos-family-portal-flow.svg")));
});
test("API bridge exposes guardian endpoints only to authenticated parent role",()=>{
 assert.match(bridge,/async familyChildren\(\)\s*\{\s*if\(API\.actor\?\.role!=="parent"\)/);
 assert.match(bridge,/async familyChildSummary\(studentId\)/);
});
test("application title and package version use the same release",()=>{
 const pkg=JSON.parse(readFileSync(join(root,"package.json"),"utf8"));
 const lock=JSON.parse(readFileSync(join(root,"package-lock.json"),"utf8"));
 assert.equal(lock.version,pkg.version);
 assert.equal(lock.packages[""].version,pkg.version);
 assertReleaseMetadataAligned();
});
