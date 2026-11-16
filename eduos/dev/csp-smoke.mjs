#!/usr/bin/env node
// Live Content Security Policy check through the edge (development only).
//
// The unit test test/csp-caddy-matches-app.test.js compares the Caddyfile with
// src/csp.js as text. This script checks what a browser really gets from the
// running stack (`make up`): the header on pages Caddy serves itself and on
// responses the Node app produces must be the same policy, with no inline
// script; then headless Chrome opens every page and every role's tabs in the
// desktop interface and the mobile app and fails on anything the policy
// blocks.
//
//   EDUOS_BASE            default https://localhost:8443
//   CHROME_PATH           Chrome/Chromium binary (auto-detected)
//   EDUOS_PLAYWRIGHT_DIR  directory containing node_modules/playwright-core
//   NODE_EXTRA_CA_CERTS   the edge's local CA (scripts/smoke.sh sets it)
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { USERS } from "./demo-fixture.js";

if (process.env.NODE_ENV === "production") { console.error("csp-smoke is a development tool"); process.exit(2); }
const BASE = (process.env.EDUOS_BASE || "https://localhost:8443").replace(/\/$/, "");
const home = process.env.HOME || "/";
const bases = [import.meta.url, process.env.EDUOS_PLAYWRIGHT_DIR && path.join(process.env.EDUOS_PLAYWRIGHT_DIR, "/"), path.join(home, "tools/pw/")].filter(Boolean);
let pw; for (const b of bases) { try { pw = createRequire(b)("playwright-core"); break; } catch {} }
if (!pw) { console.error("playwright-core not found (see dev/browser-smoke.mjs)"); process.exit(2); }
const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean).find(p => fs.existsSync(p));
if (!chrome) { console.error("No Chrome/Chromium found; set CHROME_PATH."); process.exit(2); }

const results = [];
async function step(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  ✔ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✖ ${name}\n      ${String(e.message || e).split("\n")[0]}`); }
}
const check = (c, m) => { if (!c) throw new Error(m); };
const parse = h => Object.fromEntries(String(h || "").split(";").map(d => d.trim()).filter(Boolean).map(d => { const [n, ...v] = d.split(/\s+/); return [n.toLowerCase(), v.sort().join(" ")]; }));

console.log(`EduOS CSP smoke against ${BASE}`);

// ---- 1. Headers on the wire ----
// Served by Caddy from disk (never reach Node) and produced by the app.
const STATIC = ["/", "/index.html", "/eduos-vision.html", "/legacy-app.js", "/legacy-events.js", "/app/", "/app/route", "/app/app.js", "/app/sw.js", "/app/manifest.webmanifest"];
const DYNAMIC = ["/health", "/api/me", "/auth/login"];
let appPolicy;
await step("the app's own responses carry the strict policy", async () => {
  for (const p of DYNAMIC) {
    const r = await fetch(BASE + p, { redirect: "manual" });
    const csp = r.headers.get("content-security-policy");
    check(csp, `${p}: no Content-Security-Policy`);
    check(!csp.includes(","), `${p}: more than one policy (${csp})`);
    const pol = parse(csp);
    appPolicy ??= pol;
    check(JSON.stringify(pol) === JSON.stringify(appPolicy), `${p}: differs from /health`);
  }
  check(appPolicy["script-src"] === "'self'", `script-src is ${appPolicy["script-src"]}`);
  check(appPolicy["script-src-attr"] === "'none'", `script-src-attr is ${appPolicy["script-src-attr"]}`);
});
await step("every page and script the edge serves itself carries the same policy", async () => {
  for (const p of STATIC) {
    const r = await fetch(BASE + p);
    check(r.ok, `${p}: HTTP ${r.status}`);
    const csp = r.headers.get("content-security-policy");
    check(csp, `${p}: no Content-Security-Policy`);
    check(!csp.includes(","), `${p}: more than one policy (${csp})`);
    const pol = parse(csp);
    for (const k of new Set([...Object.keys(pol), ...Object.keys(appPolicy)])) check(pol[k] === appPolicy[k], `${p}: ${k} is "${pol[k]}", app sends "${appPolicy[k]}"`);
  }
});
await step("no page the edge serves contains inline script or inline event handlers", async () => {
  for (const p of STATIC.filter(p => p.endsWith("/") || p.endsWith(".html") || p === "/app/route")) {
    const html = await (await fetch(BASE + p)).text();
    check(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), `${p}: inline <script>`);
    check(!/\son[a-z]+\s*=/i.test(html), `${p}: inline event handler attribute`);
    check(!/javascript:/i.test(html), `${p}: javascript: URL`);
  }
});

// ---- 2. In a browser: nothing blocked on any page or role screen ----
const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const blocked = [];
async function newPage(label, opts = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...opts });
  // Report what the policy blocks from the page itself (the listener is
  // installed by the test harness, outside the page's CSP).
  await ctx.addInitScript(() => document.addEventListener("securitypolicyviolation", e => console.error(`CSP-VIOLATION ${e.violatedDirective} ${e.blockedURI || "inline"} at ${e.sourceFile || location.pathname}:${e.lineNumber}`)));
  const page = await ctx.newPage();
  page.label = label;
  page.on("console", m => { const t = m.text(); if (/CSP-VIOLATION|Content Security Policy/i.test(t)) blocked.push(`${page.label} ${page.url().replace(BASE, "")}: ${t.slice(0, 200)}`); });
  page.on("pageerror", e => blocked.push(`${page.label} ${page.url().replace(BASE, "")}: page error ${e.message.slice(0, 160)}`));
  return page;
}
const settle = page => page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

await step("signed-out pages load with nothing blocked", async () => {
  const p = await newPage("signed-out");
  for (const u of ["/", "/eduos-vision.html", "/app/"]) { await p.goto(BASE + u); await settle(p); }
  await p.context().close();
});

const ROLES = ["superintendent", "principal", "teacher", "parent", "pupil", "driver", "itAdmin"];
for (const key of ROLES) {
  const u = USERS[key];
  await step(`desktop interface, ${u.role}: every tab loads with nothing blocked`, async () => {
    const p = await newPage(`desktop ${u.role}`, { viewport: { width: 1366, height: 900 } });
    await p.goto(BASE + "/");
    await p.click("#eduos-api-connect");
    await p.waitForURL(/\/authorize/);
    await p.click(`button[data-sub="${u.sub}"]`);
    await p.waitForURL(x => x.href.startsWith(BASE));
    await settle(p);
    const tabs = await p.locator("#eduos-api-content [data-tab]").evaluateAll(els => [...new Set(els.map(e => e.dataset.tab))]);
    for (const t of tabs) { await p.click(`#eduos-api-content [data-tab="${t}"]`).catch(() => {}); await settle(p); }
    await p.context().close();
  });
  await step(`mobile app, ${u.role}: every tab loads with nothing blocked`, async () => {
    const p = await newPage(`mobile ${u.role}`, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await p.goto(`${BASE}/app/`);
    await p.getByRole("link", { name: /Sign in/ }).click();
    await p.waitForURL(/\/authorize/);
    await p.click(`button[data-sub="${u.sub}"]`);
    await p.waitForURL(x => x.href.startsWith(`${BASE}/app/`));
    await p.locator(".top h1").waitFor({ timeout: 15000 });
    // The tab bar is drawn once the role's home has loaded.
    await p.locator("#tabs a").first().waitFor({ timeout: 15000 });
    const tabs = await p.locator("#tabs a").evaluateAll(els => els.map(e => e.getAttribute("href")));
    check(tabs.length > 0, "no tabs");
    for (const h of tabs) { await p.goto(`${BASE}/app/${h}`); await settle(p); }
    await p.context().close();
  });
}
await step("nothing was blocked by the Content Security Policy", async () => { check(blocked.length === 0, `${blocked.length} blocked: ${blocked.slice(0, 5).join(" | ")}`); });

await browser.close();
const failed = results.filter(r => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} CSP checks passed`);
process.exit(failed.length ? 1 : 0);
