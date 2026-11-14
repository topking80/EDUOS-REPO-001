import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const html = await readFile(new URL("public/index.html", root), "utf8");
const bridge = await readFile(new URL("public/api-bridge.js", root), "utf8");
const server = await readFile(new URL("src/server.js", root), "utf8");

test("Phase 32.0.16 district workspace is the integrated primary UI", () => {
  assert.match(html, /EduOS District Edition 34\.7\.0 \| Transportation-to-Arrival Reconciliation/);
  assert.match(html, /Access Requests/i);
  assert.match(html, /Request access/i);
  assert.match(html, /Intervention case register/i);
});

test("authenticated API bridge is loaded once at the end of the document", () => {
  assert.equal((html.match(/api-bridge\.js/g) || []).length, 1);
  assert.ok(html.lastIndexOf('<script src="/api-bridge.js"></script>') < html.toLowerCase().lastIndexOf("</body>"));
  assert.match(bridge, /\/auth\/login/);
  assert.match(bridge, /\/api\/me/);
});

test("browser demo grants are explicitly not wired as server authorization", () => {
  assert.match(html, /localStorage/i);
  assert.match(bridge, /legacy persona selector below is a synthetic demo/i);
  assert.doesNotMatch(server, /localStorage|policyCheck.*grant/i);
});

test("server retains its independent policy and CSRF boundaries", () => {
  assert.match(server, /requireCsrf|csrf/i);
  assert.match(server, /requirePermission|authorize/i);
});
