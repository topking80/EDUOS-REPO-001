import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
test("campus explorer is registered as a first-class workspace", () => {
  assert.match(html, /campus:campusExplorerPage/);
  assert.match(html, /campus:"Interactive campus"/);
});
test("all five personas can navigate to the campus explorer", () => {
  const roleMenus = html.slice(html.indexOf("const roleMenus="), html.indexOf("const personaConfig="));
  assert.equal((roleMenus.match(/"campus"/g) || []).length, 5);
});
test("campus explorer reuses project artwork and offers six workspace zones", () => {
  assert.match(html, /eduos-school-building-cutaway\.svg/);
  assert.match(html, /eduos-district-learning-loop\.svg/);
  assert.match(html, /const campusZones=\{/);
  assert.match(html, /data-campus-zone=/);
  assert.match(html, /function updateCampusZone/);
});
test("campus explorer uses local school records and labels the map conceptual", () => {
  assert.match(html, /Array\.isArray\(data\.schools\)/);
  assert.match(html, /conceptual campus map/);
  assert.match(html, /not verified room inventories/);
});
