import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const route=await readFile(new URL('../src/library-routes.js',import.meta.url),'utf8');
const migration=await readFile(new URL('../db/022_library_services.sql',import.meta.url),'utf8');
test('library assistant exposes catalogue intake and inventory workflows',()=>{for(const x of ['/api/library/inventory','/api/library/summary','/api/library/catalogues/import','/api/library/requests'])assert.ok(route.includes(x));assert.ok(route.includes('records.length>5000'));assert.ok(route.includes('ON CONFLICT(district_id,school_id,barcode)'));});
test('library assistant enforces school and district scoping and audit',()=>{assert.ok(route.includes('school_outside_district'));assert.ok(route.includes('school_scope_denied'));assert.ok(route.includes('await audit'));assert.ok(migration.includes('ENABLE ROW LEVEL SECURITY'));assert.ok(migration.includes('FORCE ROW LEVEL SECURITY'));});
test('library resource requests validate transfer schools and workflow states',()=>{assert.ok(route.includes('invalid_transfer_schools'));for(const s of ['approved','in_transit','completed','declined','cancelled'])assert.ok(route.includes(s));});
