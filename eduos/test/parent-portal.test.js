import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const root = process.cwd();
const html = (readFileSync(join(root, "public/index.html"), "utf8")+readFileSync(join(root, "public/legacy-app.js"), "utf8"));
test("parent portal is registered as a distinct page", () => {
  assert.match(html, /parentportal:parentPortalPage/);
  assert.match(html, /parentportal:"Parent & Guardian Portal"/);
});
test("parent workspace navigation exposes the portal", () => {
  assert.match(html, /label:"Parent \/ Guardian",initials:"PG"[\s\S]*?pages:\["home","parentportal","mywork","reports"\]/);
});
test("family message drafts are explicitly local and not sent", () => {
  assert.match(html, /Draft saved in this browser/);
  assert.match(html, /It was not sent/);
});
test("family export labels its contents as synthetic demonstration data", () => {
  assert.match(html, /Synthetic demonstration data; not an official student record/);
  assert.match(html, /parentPortalExport/);
});
