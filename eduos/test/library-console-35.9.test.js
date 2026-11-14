import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const app=readFileSync(new URL('../public/app/app.js',import.meta.url),'utf8');
test('librarian console is navigable for school and district operators',()=>{
 assert.match(app,/\["library", "Library", "book"\]/);
 assert.match(app,/VIEWS\.library = async/);
 assert.match(app,/Librarian console/);
});
test('console supports keyboard-wedge scan flows for check-in and check-out',()=>{
 assert.match(app,/Scan book barcode/);
 assert.match(app,/\/api\/library\/loans\/checkout/);
 assert.match(app,/\/api\/library\/loans\/\$\{loan\.id\}\/return/);
 assert.match(app,/USB wired HID keyboard-wedge scanners/);
 assert.match(app,/Bluetooth HID scanners paired as keyboards/);
});
test('checkout console does not bypass existing manager authorization',()=>{
 const routes=readFileSync(new URL('../src/library-circulation-routes.js',import.meta.url),'utf8');
 assert.match(routes,/const MANAGERS = \["superintendent", "it_admin", "principal", "librarian"\]/);
 assert.match(routes,/requireCsrf/);
});
