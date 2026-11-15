import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertReleaseMetadataAligned } from './helpers/release.js';
const root=path.resolve(import.meta.dirname,'..');
const html=(fs.readFileSync(path.join(root,'public/index.html'),'utf8')+fs.readFileSync(path.join(root,'public/legacy-app.js'),'utf8'));
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
test('32.0.52 exposes arrival workflow to principal, teacher and bus driver workspaces',()=>{
 assertReleaseMetadataAligned();
 assert.ok(html.includes('arrival:"Arrival & Transportation Handoff"'));
 assert.ok(html.includes('busdriver:{label:"Bus Driver"'));
 for(const role of ['principal','teacher','busdriver']) assert.ok(html.includes(role+':{label:'));
});
test('principal can assign teachers and record car-rider arrival',()=>{
 assert.ok(html.includes('function assignArrivalTeacher'));
 assert.ok(html.includes('function arrivalCheckIn'));
 assert.ok(html.includes('Car Rider'));
});
test('bus driver workflow checks in bus riders then records handoff',()=>{
 assert.ok(html.includes('row.method!=="Bus"'));
 assert.ok(html.includes('function arrivalHandoff'));
 assert.ok(html.includes('Bus-to-school staff handoff'));
});
test('teacher records first attendance only after arrival or handoff',()=>{
 assert.ok(html.includes('function teacherFirstAttendance'));
 assert.ok(html.includes('row.status!=="Handed off"&&row.status!=="Arrived"'));
 assert.ok(html.includes('First attendance: '));
});
test('legacy browser demo remains clearly labeled and safeguards remain visible',()=>{
 assert.match(html,/DEMO ONLY — NOT AN AUTHORITATIVE STUDENT RECORD/);
 assert.match(html,/student release procedures/i);
});
