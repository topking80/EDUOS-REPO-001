import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src=readFileSync(new URL("../src/safety-routes.js",import.meta.url),"utf8");
test("35.6 SRO assignment routes are registered",()=>{ assert.match(src,/sro-assignment-response/); assert.match(src,/sro-assignment/); });
test("assignment requires active school-scoped SRO membership",()=>{ assert.match(src,/role='sro' AND status='active'/); assert.match(src,/sro_not_authorized_for_school/); });
test("only assigned SRO may acknowledge or decline",()=>{ assert.match(src,/sro_not_assigned_to_incident/); assert.match(src,/\["acknowledged","declined"\]/); });
test("assignment checks district school policy",()=>{ assert.match(src,/school_not_allowed_by_district_policy/); });
