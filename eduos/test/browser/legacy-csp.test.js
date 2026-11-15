// The district interface at / (public/index.html + legacy-app.js) under the
// production Content Security Policy, which allows no inline script: it must
// load, its data-on-* handlers must work through legacy-events.js, nothing may
// be blocked by the policy, and a handler that isn't on the list does nothing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { cspDirectives } from "../../src/csp.js";
import { CHROME, startChrome, Page, sleep } from "./cdp.js";

const PUBLIC = new URL("../../public/", import.meta.url);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg" };
const kebab = (k) => k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
const CSP = Object.entries(cspDirectives).map(([k, v]) => `${kebab(k)} ${v.join(" ")}`).join("; ");

function startServer() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://x");
    if (pathname === "/api/app-config") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ demoMode: true })); }
    if (pathname.startsWith("/api/")) { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"error":"session_required"}'); }
    const file = new URL(pathname === "/" ? "index.html" : pathname.slice(1), PUBLIC);
    if (!file.href.startsWith(PUBLIC.href) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file.pathname)] || "application/octet-stream", "content-security-policy": CSP });
    fs.createReadStream(file).pipe(res);
  });
  server.unref();
  return new Promise(r => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

const required = process.env.EDUOS_REQUIRE_BROWSER === "1";
test("district interface works under a CSP with no inline script", { skip: !CHROME && !required && "Chrome not installed (set EDUOS_REQUIRE_BROWSER=1 to require it)", timeout: 90000 }, async (t) => {
  assert.ok(CHROME, "EDUOS_REQUIRE_BROWSER=1 but no Chrome found (set CHROME_PATH)");
  assert.doesNotMatch(CSP, /script-src[^;]*unsafe-inline/);
  const { server, port } = await startServer();
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const chrome = await startChrome(t);
  const page = await Page.open(chrome.port);
  t.after(() => page.close());
  // Record policy violations from the very start of the page.
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+(e.blockedURI||'')+' '+(e.sample||'')))" });
  await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  const waitFor = async (expr, what) => { for (let i = 0; i < 100; i++) { if (await page.eval(expr)) return; await sleep(100); } assert.fail(`timed out: ${what}`); };
  await waitFor(`document.documentElement.dataset.eduosMode === "demo" && typeof go === "function" && !!window.EduosLegacyEvents`, "the interface to load in demo mode");

  // Render the schools page (as the nav would), then use it only through clicks and typing.
  await page.eval(`go("schools")`);
  await waitFor(`!!document.querySelector('[data-on-input="filterSchools()"]')`, "the schools page");
  const rows = () => page.eval(`[...document.querySelectorAll("#content tbody tr")].filter(r => r.style.display !== "none").length`);
  const before = await rows();
  await page.eval(`(() => { const i = document.getElementById("schoolSearch"); i.value = "zzzz-no-such-school"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  assert.ok((await rows()) < before, `typing filters the list (data-on-input): ${before} rows before`);
  // A school's page: pick another school (data-on-change with this.value), then go back (data-on-click with an argument).
  await page.eval(`go("schooldetail")`);
  await waitFor(`!!document.querySelector('[data-on-change="openSchoolDetail(this.value)"]')`, "a school's page");
  const second = await page.eval(`(() => { const s = document.querySelector('[data-on-change="openSchoolDetail(this.value)"]'); const o = s.options[1]; s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); return o.value; })()`);
  await waitFor(`currentSchool === ${JSON.stringify(second)} && document.querySelector('[data-on-change="openSchoolDetail(this.value)"]').value === ${JSON.stringify(second)}`, "the other school to open");
  await page.eval(`document.querySelector('[data-on-click="go(\\'schools\\')"]').click()`);
  await waitFor(`!!document.querySelector('[data-on-input="filterSchools()"]')`, "back to all schools");

  // Not on the list: nothing runs.
  const refused = await page.eval(`(() => { window.__ran = false; window.sneaky = () => { window.__ran = true; };
    const b = document.createElement("button"); b.setAttribute("data-on-click", "sneaky()"); document.body.append(b); b.click(); return window.__ran; })()`);
  assert.equal(refused, false, "a handler that isn't listed doesn't run");

  assert.deepEqual(await page.eval("window.__csp"), [], "the policy blocked something");
  assert.deepEqual(page.errors, [], "uncaught errors");
});
