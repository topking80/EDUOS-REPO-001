import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const route=fs.readFileSync(new URL("../src/library-intelligence-routes.js",import.meta.url),"utf8");
const server=fs.readFileSync(new URL("../src/server.js",import.meta.url),"utf8");
test("36.3 intelligence routes are registered and authenticated",()=>{assert.match(server,/registerLibraryIntelligenceRoutes\(app\)/);assert.match(route,/requireSession/);assert.match(route,/\/api\/library\/intelligence\/overview/);assert.match(route,/\/api\/library\/intelligence\/recommendations/);});
test("36.3 analytics are district or school scoped and audited",()=>{assert.match(route,/district_id=\$1 AND \$\{scope\}/);assert.match(route,/await audit\(c,req,"read","library_intelligence"/);assert.match(route,/Cache-Control","no-store"/);});
test("36.3 transfer and purchase suggestions never execute transactions",()=>{assert.match(route,/Review cross-school transfer/);assert.match(route,/Review replacement or additional purchase/);assert.doesNotMatch(route,/INSERT INTO library_loans|UPDATE library_items SET school_id/);});
test("36.3 ISBN matching excludes missing identifiers and requires available stock",()=>{assert.match(route,/a\.isbn IS NOT NULL/);assert.match(route,/a\.available_count>0/);assert.match(route,/b\.available_count=0/);});
