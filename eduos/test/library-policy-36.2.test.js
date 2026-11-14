import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const route=readFileSync(new URL('../src/library-circulation-routes.js',import.meta.url),'utf8');
const migration=readFileSync(new URL('../db/026_library_policy_and_notice_ledger.sql',import.meta.url),'utf8');
const runner=readFileSync(new URL('../src/migrate.js',import.meta.url),'utf8');
test('district borrowing policies are school scoped and bounded',()=>{
 assert.match(route,/api\/library\/policy/);assert.match(route,/school_scope_denied/);assert.match(route,/loanDays/);assert.match(route,/maxRenewals/);assert.match(migration,/loan_days BETWEEN 1 AND 120/);assert.match(migration,/max_renewals BETWEEN 0 AND 10/);assert.match(migration,/FORCE ROW LEVEL SECURITY/);
});
test('renewals use school policy values with safe defaults',()=>{assert.match(route,/policy\?\.max_renewals\?\?2/);assert.match(route,/policy\?\.renewal_days\?\?14/);});
test('overdue notice preparation is deduplicated and does not send external messages',()=>{assert.match(route,/api\/library\/notices\/prepare-overdue/);assert.match(route,/ON CONFLICT\(loan_id,notice_type,notice_date,channel\) DO NOTHING/);assert.match(route,/externalDeliveryEnabled:false/);assert.match(migration,/UNIQUE\(loan_id,notice_type,notice_date,channel\)/);});
test('migration 026 is registered',()=>assert.match(runner,/026_library_policy_and_notice_ledger\.sql/));
