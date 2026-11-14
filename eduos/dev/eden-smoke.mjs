#!/usr/bin/env node
// EduOS 32.7.0 EDEN simulation scenario (development only), run by
// scripts/eden-sim.sh after the dev stack (`make up`) is the district hub and
// eden-db is up. Drives real phone-size browsers against the hub and the two
// simulated school nodes, runs axe on every screen and saves screenshots.
// Docker is used for the infrastructure events only: starting nodes,
// `docker network disconnect` (uplink partition), `docker stop` (node failure).
//
//   EDUOS_BASE              hub, default https://localhost:8443
//   EDEN_SCREENSHOT_DIR     default ./artifacts/screens/32.7
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { USERS, SCHOOLS } from "./demo-fixture.js";

if (process.env.NODE_ENV === "production") { console.error("eden-smoke is a development tool"); process.exit(2); }
const HUB = (process.env.EDUOS_BASE || "https://localhost:8443").replace(/\/$/, "");
const NODE = { a: "http://localhost:8501", b: "http://localhost:8502" };
const OUT = path.resolve(process.env.EDEN_SCREENSHOT_DIR || "artifacts/screens/32.7");
const ENV_FILE = process.env.EDUOS_ENV_FILE || ".env.dev";
fs.mkdirSync(OUT, { recursive: true });
const home = process.env.HOME || "/";
const bases = [import.meta.url, process.env.EDUOS_PLAYWRIGHT_DIR && path.join(process.env.EDUOS_PLAYWRIGHT_DIR, "/"), path.join(home, "tools/pw/")].filter(Boolean);
let pw; for (const b of bases) { try { pw = createRequire(b)("playwright-core"); break; } catch {} }
if (!pw) { console.error("playwright-core not found (see dev/browser-smoke.mjs)"); process.exit(2); }
const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean).find(p => fs.existsSync(p));
if (!chrome) { console.error("No Chrome/Chromium found; set CHROME_PATH."); process.exit(2); }
const AXE = [process.env.EDUOS_AXE_PATH, path.join(home, "tools/pw/node_modules/axe-core/axe.min.js")].filter(Boolean).find(p => fs.existsSync(p)) || null;

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, EDUOS_ENV_FILE: ENV_FILE } }).trim();
const eden = (...args) => docker("compose", "--env-file", ENV_FILE, "-f", "docker-compose.eden.yml", ...args);
const WAN = "eduos-eden_eden_wan";
const container = svc => eden("ps", "-aq", svc);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitHealth(base, ok = true, tries = 60) {
  for (let i = 0; i < tries; i++) { const up = await fetch(`${base}/health`).then(r => r.ok).catch(() => false); if (up === ok) return; await sleep(1000); }
  throw new Error(`${base} health did not become ${ok ? "ok" : "down"}`);
}

const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const results = [], axeFindings = [], pageErrors = [], shots = [];
async function step(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  ✔ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✖ ${name}\n      ${String(e.message || e).split("\n")[0]}`); }
}
const check = (c, m) => { if (!c) throw new Error(m); };
async function phone() {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark",
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36" });
  const page = await ctx.newPage();
  page.on("pageerror", e => pageErrors.push(e.message));
  return page;
}
async function axe(page, label) {
  if (!AXE) return;
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ path: AXE });
  const r = await page.evaluate(() => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] }));
  for (const v of r.violations) axeFindings.push({ screen: label, id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map(n => ({ target: n.target.join(" "), summary: n.failureSummary })) });
  console.log(`      axe ${label}: ${r.violations.length ? r.violations.map(v => `${v.id}(${v.nodes.length})`).join(", ") : "no violations"}`);
}
async function shot(page, name, { full = true } = {}) {
  await page.evaluate(() => document.getElementById("toast")?.classList.remove("show"));
  await page.waitForTimeout(300);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  shots.push(file);
}
const settle = page => page.locator("main .empty", { hasText: "Loading" }).waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
async function signIn(page, base, sub) {
  await page.goto(`${base}/app/`);
  await page.getByRole("link", { name: /Sign in/ }).click();
  await page.waitForURL(/\/authorize/);
  await page.click(`button[data-sub="${sub}"]`);
  await page.waitForURL(u => u.href.startsWith(`${base}/app/`));
  await page.locator(".top h1").waitFor({ timeout: 15000 });
  await settle(page);
}
async function open(page, base, view) { await page.goto(`${base}/app/#/${view}`); await page.locator(".top h1").waitFor({ timeout: 15000 }); await settle(page); await page.waitForTimeout(300); }
const apiJson = (page, method, p, body) => page.evaluate(async ([method, p, body]) => {
  const csrf = method === "GET" ? null : (await (await fetch("/api/csrf")).json()).csrfToken;
  const r = await fetch(p, { method, headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, p, body]);
const syncNow = async page => { const r = await apiJson(page, "POST", "/api/node/sync-now", {}); check(r.status === 200, `sync-now ${r.status} ${JSON.stringify(r.body)}`); return r.body.data; };
const overview = async page => (await apiJson(page, "GET", "/api/eden/admin/overview")).body.data;

console.log(`EduOS 32.7.0 EDEN simulation: hub ${HUB}, nodes ${NODE.a} ${NODE.b}; screenshots in ${OUT}`);
const supt = await phone();
let ov;
await step("district hub: superintendent opens Nodes and creates one-time enrollment tokens", async () => {
  await signIn(supt, HUB, USERS.superintendent.sub);
  await open(supt, HUB, "nodes");
  if (!(await supt.locator("#es").count())) { await supt.waitForTimeout(3000); await open(supt, HUB, "nodes"); } // hub just (re)started
  await supt.locator("#es").waitFor({ timeout: 30000 });
  ov = await overview(supt);
  check(ov?.hub?.enabled, `hub enabled: ${JSON.stringify(ov?.hub)}`);
  const env = {};
  for (const [k, school] of [["A", SCHOOLS.elementary], ["B", SCHOOLS.middle]]) {
    if (ov.nodes.some(n => n.school_id === school.id && n.status !== "revoked")) continue; // already enrolled (identity volume kept)
    await supt.selectOption("#es", school.id);
    await supt.getByRole("button", { name: "Create enrollment token" }).click();
    const t = supt.locator("code.token"); await t.waitFor();
    const used = Object.values(env);
    for (let i = 0; i < 50 && used.includes((await t.textContent()).trim()); i++) await supt.waitForTimeout(100);
    env[`EDEN_TOKEN_${k}`] = (await t.textContent()).trim();
    check(!used.includes(env[`EDEN_TOKEN_${k}`]), "a fresh token per school");
  }
  if (Object.keys(env).length) { await shot(supt, "01-hub-enrollment-token", { full: false }); await axe(supt, "hub enrollment"); }
  Object.assign(process.env, env);
  console.log("      starting node-a and node-b containers…");
  eden("up", "-d", "--wait", "node-a", "node-b");
  await waitHealth(NODE.a); await waitHealth(NODE.b);
});

const pa = await phone(), pb = await phone();
await step("both school nodes enrolled under the pinned root and sent gated aggregates only", async () => {
  await signIn(pa, NODE.a, USERS.principal.sub);
  await signIn(pb, NODE.b, USERS.principalMiddle.sub);
  const a = await syncNow(pa), b = await syncNow(pb);
  check(a.uplink === "online" && b.uplink === "online", `uplinks ${a.uplink} ${b.uplink}`);
  ov = await overview(supt);
  check(ov.nodes.filter(n => n.online).length >= 2, "two nodes online at the hub");
  const agg = (await apiJson(supt, "GET", "/api/eden/admin/aggregates?kind=enrollment_by_grade")).body.data;
  const cells = agg.flatMap(x => x.payload.cells);
  check(cells.every(c => c.count === null || c.count === 0 || c.count >= 5), "no published cell under 5");
  check(cells.some(c => c.count === null), "some cells suppressed");
  check(!JSON.stringify(agg).match(/Ava|Morgan|RES-1001|SYN-0/), "no names or student numbers in aggregates");
  await open(supt, HUB, "nodes");
  await shot(supt, "02-hub-nodes-online");
  await axe(supt, "hub nodes");
});
await step("school node screen: connected, sync, egress log (what left the school)", async () => {
  await open(pa, NODE.a, "overview");
  await pa.getByText("School node connected").waitFor();
  await open(pa, NODE.a, "node");
  await pa.getByText("Connected to the district").waitFor();
  await shot(pa, "03-node-a-connected");
  await axe(pa, "node A status");
});

const driver = await phone();
await step("phone loses signal: bus check-in is saved encrypted on the phone and sent when back", async () => {
  await signIn(driver, NODE.a, USERS.driver.sub);
  await open(driver, NODE.a, "route");
  const start = driver.getByRole("button", { name: "Start run" });
  await start.or(driver.locator("button.onboard").first()).first().waitFor({ timeout: 15000 });
  if (await start.count()) { await start.click(); await driver.locator("button.onboard").first().waitFor({ timeout: 10000 }); }
  const btn = driver.locator("button.onboard").first();
  await btn.waitFor({ timeout: 10000 });
  await driver.context().setOffline(true);
  await btn.click();
  await driver.locator("#netbar").getByText(/saved on this phone/).waitFor({ timeout: 10000 });
  const stored = await driver.evaluate(() => new Promise(res => { const r = indexedDB.open("eduos-offline-queue"); r.onsuccess = () => { const t = r.result.transaction("queue").objectStore("queue").getAll(); t.onsuccess = () => res(t.result.map(x => ({ hasPlainPath: JSON.stringify(x).includes("/api/"), dataBytes: x.data.byteLength }))); }; }));
  check(stored.length === 1 && !stored[0].hasPlainPath, `queued entry is ciphertext: ${JSON.stringify(stored)}`);
  await driver.evaluate(() => window.scrollTo(0, 0));
  await shot(driver, "04-phone-offline-queue", { full: false });
  await axe(driver, "driver offline");
  await driver.context().setOffline(false);
  await driver.evaluate(() => window.dispatchEvent(new Event("online")));
  await driver.getByText(/Sent 1 saved change/).waitFor({ timeout: 15000 });
});

await step("uplink partition (docker network disconnect): node A keeps working locally and queues for the district", async () => {
  docker("network", "disconnect", WAN, container("node-a"));
  const r = await syncNow(pa);
  check(r.uplink === "offline", `uplink ${r.uplink}`);
  // Local writes still work: attendance for a learner.
  const att = await apiJson(pa, "POST", "/api/attendance", { studentId: "00000000-0000-4000-8000-000000050001", eventDate: new Date().toISOString().slice(0, 10), status: "tardy" });
  check(att.status === 201, `local attendance ${att.status}`);
  await syncNow(pa); // queues fresh aggregates in the outbox
  await open(pa, NODE.a, "node");
  await pa.getByText("District link is down").waitFor();
  const st = (await apiJson(pa, "GET", "/api/node/status")).body.data;
  check(st.outbox.pending > 0, "outbox has pending updates");
  await shot(pa, "05-node-a-partitioned");
  await axe(pa, "node A partitioned");
});
await step("heal: reconnect, outbox drains, hub has the new aggregates", async () => {
  docker("network", "connect", WAN, container("node-a"));
  let r;
  for (let i = 0; i < 10; i++) { await sleep(2000); r = await syncNow(pa); if (r.uplink === "online") break; } // DNS/route settle after reconnect
  check(r.uplink === "online", `uplink ${r.uplink}`);
  const st = (await apiJson(pa, "GET", "/api/node/status")).body.data;
  check(st.outbox.pending === 0, `outbox pending ${st.outbox.pending}`);
});

let failover;
await step("partners: each school covers the other; sealed continuity packages reach the hub (ciphertext only)", async () => {
  ov = await overview(supt);
  const A = ov.nodes.find(n => n.school_id === SCHOOLS.elementary.id), B = ov.nodes.find(n => n.school_id === SCHOOLS.middle.id);
  await open(supt, HUB, "nodes");
  await supt.selectOption("#pn", A.id); await supt.selectOption("#pp", B.id); await supt.getByRole("button", { name: "Save partner" }).click(); await supt.getByText("Partner saved").waitFor();
  await settle(supt);
  await supt.selectOption("#pn", B.id); await supt.selectOption("#pp", A.id); await supt.getByRole("button", { name: "Save partner" }).click(); await supt.getByText("Partner saved").waitFor();
  await sleep(500);
  await syncNow(pa); await syncNow(pb); await syncNow(pa);
  ov = await overview(supt);
  check(ov.nodes.every(n => n.continuity_at), "both continuity packages at the hub");
});
await step("node A fails (docker stop); hub sees it offline; superintendent authorizes a time-limited failover", async () => {
  docker("stop", container("node-a"));
  await waitHealth(NODE.a, false, 20);
  for (let i = 0; i < 40; i++) { ov = await overview(supt); if (!ov.nodes.find(n => n.school_id === SCHOOLS.elementary.id).online) break; await sleep(1000); }
  await open(supt, HUB, "nodes");
  await supt.getByRole("button", { name: "Authorize failover" }).waitFor();
  await supt.fill("#fr", "Power outage at Riverside Elementary (simulation)");
  await supt.fill("#fh", "4");
  await supt.getByRole("button", { name: "Authorize failover" }).click();
  await supt.locator("dialog").getByRole("button", { name: "Authorize" }).click();
  await supt.getByText("Failover authorized").waitFor();
  await syncNow(pb);
  await open(supt, HUB, "nodes");
  await supt.getByText("Failover in progress").waitFor();
  ov = await overview(supt);
  failover = ov.failovers[0];
  check(failover.status === "active", `failover ${failover.status}`);
  await shot(supt, "06-hub-failover-active");
  await axe(supt, "hub failover");
});
const hostedP = await phone();
await step("partner node B hosts Riverside: its principal signs in there for SafetyOS, pick-up, buses and attendance only", async () => {
  await open(pb, NODE.b, "node");
  await pb.getByText("Covering for another school").waitFor();
  await shot(pb, "07-node-b-covering");
  await axe(pb, "node B covering");
  await signIn(hostedP, NODE.b, USERS.principal.sub);
  await open(hostedP, NODE.b, "overview");
  await hostedP.getByText("Covering from a partner school").waitFor();
  const att = await apiJson(hostedP, "POST", "/api/attendance", { studentId: "00000000-0000-4000-8000-000000000301", eventDate: new Date().toISOString().slice(0, 10), status: "present" });
  check(att.status === 201, `hosted attendance ${att.status}`);
  const blocked = await apiJson(hostedP, "GET", "/api/learning/courses");
  check(blocked.status === 403 && blocked.body.error === "not_available_during_failover", `blocked ${blocked.status}`);
  await shot(hostedP, "08-hosted-principal-on-partner");
  await axe(hostedP, "hosted principal");
});
await step("node A returns: automatic handback, partner returns records and purges its copy, A imports, hub closes", async () => {
  docker("start", container("node-a"));
  await waitHealth(NODE.a);
  await syncNow(pa);
  await syncNow(pb);
  await sleep(500);
  await syncNow(pa);
  ov = await overview(supt);
  const f = ov.failovers.find(x => x.id === failover.id);
  check(f.status === "closed", `failover ${f.status}`);
  check(f.purge_counts?.remaining_students === 0, `partner purge ${JSON.stringify(f.purge_counts)}`);
  const gone = await apiJson(hostedP, "GET", "/api/me");
  check(gone.status === 401, `hosted session ended: ${gone.status}`);
  await open(supt, HUB, "nodes");
  await shot(supt, "09-hub-after-handback");
  await open(pa, NODE.a, "node");
  await shot(pa, "10-node-a-after-handback");
  await axe(pa, "node A after");
});

let stats = "";
try { stats = docker("stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}"); fs.writeFileSync(path.join(OUT, "docker-stats.txt"), `${stats}\n`); } catch {}
await browser.close();
const failed = results.filter(r => !r[0]);
fs.writeFileSync(path.join(OUT, "eden-smoke-results.json"), JSON.stringify({ at: new Date().toISOString(), results, axe: axeFindings, pageErrors, shots: shots.map(s => path.basename(s)) }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} steps passed · axe violations: ${axeFindings.length} · page errors: ${pageErrors.length}`);
if (stats) console.log(`\nMemory (docker stats):\n${stats}`);
process.exit(failed.length || axeFindings.length || pageErrors.length ? 1 : 0);
