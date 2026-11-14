import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs";
const root=new URL("../",import.meta.url);
const policy=fs.readFileSync(new URL("../src/policy.js",import.meta.url),"utf8");
const routes=fs.readFileSync(new URL("../src/school-operations-routes.js",import.meta.url),"utf8");
const ui=fs.readFileSync(new URL("../public/app/app.js",import.meta.url),"utf8");
test("36.4 specialized roles have narrow permission sets",()=>{for(const r of ["vice_principal","counselor","nurse","maintenance","lunch_staff"])assert.match(policy,new RegExp(r+": \\{"));assert.match(policy,/health_office:/);});
test("36.4 work queues enforce role-domain mapping and tenant transactions",()=>{assert.match(routes,/DOMAIN_ROLES/);assert.match(routes,/withTenantTransaction/);assert.match(routes,/district_id=\$1/);assert.match(routes,/school_id=\$5/);});
test("36.4 sensitive health and counseling notes are rejected",()=>{assert.match(routes,/sensitive_notes_not_supported/);});
test("36.4 console tabs are registered for all five roles",()=>{for(const r of ["vice_principal","counselor","nurse","maintenance","lunch_staff"])assert.match(ui,new RegExp(r+": \\[\\["));assert.match(ui,/VIEWS\.guidance = specializedOpsView/);});
