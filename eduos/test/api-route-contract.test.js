import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 32.2.0: the browser also calls the mesh/home API from eduos-mesh.js.
const bridge=readFileSync("public/api-bridge.js","utf8")+"\n"+readFileSync("public/eduos-mesh.js","utf8")+"\n"+readFileSync("public/eduos-branding.js","utf8");
// Routes live in src/server.js, src/admin-routes.js (32.1.0), src/mesh-routes.js and src/home-routes.js (32.2.0).
const server=["src/server.js","src/admin-routes.js","src/mesh-routes.js","src/home-routes.js","src/branding-routes.js","src/arrival-routes.js","src/transport-routes.js","src/comms-routes.js","src/arrival-exception-routes.js"].map(f=>readFileSync(f,"utf8")).join("\n");
function normalize(path){
  return path.replace(/\$\{[^}]+\}/g,"PARAM").replace(/:\w+/g,"PARAM").split("?")[0];
}
test("every literal API endpoint used by the browser bridge has a server route",()=>{
  const clientPaths=[...new Set([...bridge.matchAll(/["'`]((?:\/api\/)[^"'` ]+)["'`]/g)].map(m=>normalize(m[1])))];
  const serverPaths=new Set([...server.matchAll(/app\.(?:get|post|put|patch|delete)\(\s*["']([^"']+)["']/g)].map(m=>normalize(m[1])));
  const missing=clientPaths.filter(path=>!serverPaths.has(path));
  assert.deepEqual(missing,[]);
  assert.ok(clientPaths.length>=30,`Expected broad API coverage; found ${clientPaths.length}`);
});
test("API bridge uses same-origin credentials and CSRF on state-changing requests",()=>{
  assert.match(bridge,/credentials:\s*["']same-origin["']/);
  assert.match(bridge,/X-CSRF-Token/);
  assert.match(bridge,/!?\[\s*["']GET["']\s*,\s*["']HEAD["']\s*\]/);
  assert.match(server,/requireCsrf/);
});
test("critical API routes retain session and permission middleware",()=>{
  for(const route of [
    /app\.get\(["']\/api\/students["'],requireSession,requirePermission/,
    /app\.get\(["']\/api\/family\/children["'],requireSession,requireGuardian,requirePermission/,
    /app\.post\(["']\/api\/webhooks\/:webhookId\/test["'],webhookAdminLimiter,requireSession,requireCsrf,requirePermission/
  ]) assert.match(server,route);
});
