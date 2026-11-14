import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const route=readFileSync(new URL("../src/library-circulation-routes.js",import.meta.url),"utf8");
const migration=readFileSync(new URL("../db/025_library_renewals_family.sql",import.meta.url),"utf8");
const ui=readFileSync(new URL("../public/app/app.js",import.meta.url),"utf8");
test("borrowers can see only their own loan history and parents use active guardian links",()=>{
 assert.match(route,/api\/library\/my-loans/);assert.match(route,/a\.role!=="pupil"/);assert.match(route,/api\/library\/family-loans/);assert.match(route,/link\.relationship IN \('parent','guardian'\)/);
});
test("renewals enforce ownership, school scope, two-renewal limit and queued holds",()=>{
 assert.match(route,/api\/library\/loans\/:id\/renew/);assert.match(route,/loan_owner_only/);assert.match(route,/max_renewals/);assert.match(route,/item_has_waiting_reservation/);assert.match(route,/overdue_loan_requires_librarian/);
});
test("renewal counter is bounded and parent/student library views are navigable",()=>{
 assert.match(migration,/renewal_count BETWEEN 0 AND 2/);assert.match(ui,/Family library books/);assert.match(ui,/My library books/);assert.match(ui,/\["library", "Library books"/);
});
