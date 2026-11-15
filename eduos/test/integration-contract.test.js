import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const client = await readFile(new URL("../public/api-bridge.js", import.meta.url), "utf8");
const html = (await readFile(new URL("../public/index.html", import.meta.url), "utf8")+await readFile(new URL("../public/legacy-app.js", import.meta.url), "utf8"));
const schema = await readFile(new URL("../db/001_initial.sql", import.meta.url), "utf8");

test("same-origin static app and API bridge are served",()=>{
  assert.match(server,/express\.static\(publicDir/);
  assert.match(html,/<script src="\/api-bridge\.js"><\/script>/);
});
test("client authenticates through server endpoints, not local persona identity",()=>{
  assert.match(client,/location\.assign\("\/auth\/login"\)/);
  assert.match(client,/\/api\/me/);
  assert.match(client,/\/api\/schools/);
  assert.match(client,/\/api\/students/);
  assert.match(client,/X-CSRF-Token/);
});
test("family/student list is backed by relationship table",()=>{
  assert.match(schema,/CREATE TABLE student_user_links/);
  assert.match(server,/FROM student_user_links/);
  assert.doesNotMatch(server,/FROM family_student_links/);
});
test("legacy workspace is explicitly labeled as local demo",()=>{
  assert.match(client,/legacy persona selector below is a synthetic demo/);
});
