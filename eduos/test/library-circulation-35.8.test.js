import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const route=readFileSync(new URL("../src/library-circulation-routes.js",import.meta.url),"utf8");
const migration=readFileSync(new URL("../db/023_library_circulation.sql",import.meta.url),"utf8");
const grants=readFileSync(new URL("../db/runtime_grants.template.sql",import.meta.url),"utf8");
test("circulation routes require authenticated sessions and CSRF on mutations",()=>{
 assert.match(route,/\/api\/library\/loans\/checkout",requireSession,requireCsrf/);
 assert.match(route,/\/api\/library\/loans\/:id\/return",requireSession,requireCsrf/);
 assert.match(route,/\/api\/library\/reservations",requireSession,requireCsrf/);
});
test("checkout is limited to managers and tenant/school-scoped active memberships",()=>{
 assert.match(route,/const MANAGERS = \["superintendent", "it_admin", "principal", "librarian"\]/);
 assert.match(route,/m\.district_id=\$2 AND m\.status='active' AND u\.status='active'/);
 assert.match(route,/school_scope_denied/);
 assert.match(route,/no_available_copies/);
});
test("returns are idempotency guarded and only good returns restore availability",()=>{
 assert.match(route,/loan_already_returned/);
 assert.match(route,/disposition===\"returned\"/);
 assert.match(route,/available_count=LEAST\(copy_count,available_count\+1\)/);
});
test("circulation tables enforce district RLS and have bounded query indexes",()=>{
 assert.match(migration,/FORCE ROW LEVEL SECURITY/);
 assert.match(migration,/library_loan_scope/);
 assert.match(migration,/library_reservation_scope/);
 assert.match(migration,/library_loans_due_idx/);
 assert.match(grants,/ON library_loans, library_reservations TO eduos_app/);
});
