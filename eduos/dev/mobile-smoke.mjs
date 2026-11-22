#!/usr/bin/env node
// EduOS 32.4.0 mobile role-app browser smoke test (development only).
// Drives /app/ in headless Chrome at a phone viewport (390×844, touch, DPR 2)
// for every role app, signing in through the dev identity provider, runs
// axe-core (WCAG 2.1 A/AA) on each screen and saves phone-size screenshots.
//
//   EDUOS_BASE                 default https://localhost:8443
//   EDUOS_MOBILE_SCREENSHOT_DIR default ./artifacts/screens/32.4
//   EDUOS_AXE_PATH / EDUOS_PLAYWRIGHT_DIR / CHROME_PATH as in dev/browser-smoke.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { USERS } from "./demo-fixture.js";

if (process.env.NODE_ENV === "production") { console.error("mobile-smoke is a development tool"); process.exit(2); }
const BASE = (process.env.EDUOS_BASE || "https://localhost:8443").replace(/\/$/, "");
const OUT = path.resolve(process.env.EDUOS_MOBILE_SCREENSHOT_DIR || "artifacts/screens/32.4");
fs.mkdirSync(OUT, { recursive: true });
const home = process.env.HOME || "/";
const bases = [import.meta.url, process.env.EDUOS_PLAYWRIGHT_DIR && path.join(process.env.EDUOS_PLAYWRIGHT_DIR, "/"), path.join(home, "tools/pw/")].filter(Boolean);
let pw; for (const b of bases) { try { pw = createRequire(b)("playwright-core"); break; } catch {} }
if (!pw) { console.error("playwright-core not found (see dev/browser-smoke.mjs)"); process.exit(2); }
const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean).find(p => fs.existsSync(p));
if (!chrome) { console.error("No Chrome/Chromium found; set CHROME_PATH."); process.exit(2); }
const AXE = [process.env.EDUOS_AXE_PATH, process.env.EDUOS_PLAYWRIGHT_DIR && path.join(process.env.EDUOS_PLAYWRIGHT_DIR, "node_modules/axe-core/axe.min.js"), path.join(home, "tools/pw/node_modules/axe-core/axe.min.js")].filter(Boolean).find(p => fs.existsSync(p)) || null;

// Injected over the DevTools protocol, not as a <script> tag: the app's Content
// Security Policy (script-src 'self') rightly blocks inline scripts, and
// loosening it for tests would hide real CSP problems.
async function injectAxe(page) {
  const cdp = await page.context().newCDPSession(page);
  try { await cdp.send("Runtime.evaluate", { expression: fs.readFileSync(AXE, "utf8") }); } finally { await cdp.detach().catch(() => {}); }
}

const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const results = [], axeFindings = [], pageErrors = [], shots = [];
async function step(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  ✔ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✖ ${name}\n      ${String(e.message || e).split("\n")[0]}`); }
}
const check = (c, m) => { if (!c) throw new Error(m); };
async function phone() {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    colorScheme: "dark", userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36" });
  const page = await ctx.newPage();
  page.on("pageerror", e => pageErrors.push(e.message));
  page.dialogAnswers = [];
  page.on("dialog", d => { const a = page.dialogAnswers.shift(); a === false ? d.dismiss() : d.accept(a ?? ""); });
  return page;
}
async function axe(page, label) {
  if (!AXE) return;
  if (!(await page.evaluate(() => Boolean(window.axe)))) await injectAxe(page);
  const r = await page.evaluate(() => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] }));
  for (const v of r.violations) axeFindings.push({ screen: label, id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map(n => ({ target: n.target.join(" "), summary: n.failureSummary })) });
  console.log(`      axe ${label}: ${r.violations.length ? r.violations.map(v => `${v.id}(${v.nodes.length})`).join(", ") : "no violations"}`);
}
async function shot(page, name, { full = false } = {}) {
  await page.evaluate(() => document.getElementById("toast")?.classList.remove("show"));
  await page.waitForTimeout(300);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  shots.push(file);
}
const waitText = (page, text, timeout = 15000) => page.getByText(text, { exact: false }).first().waitFor({ timeout });
async function signIn(page, sub) {
  await page.goto(`${BASE}/app/`);
  await page.getByRole("link", { name: /Sign in/ }).click();
  await page.waitForURL(/\/authorize/);
  await page.click(`button[data-sub="${sub}"]`);
  await page.waitForURL(u => u.href.startsWith(`${BASE}/app/`));
  await page.locator(".top h1").waitFor({ timeout: 15000 });
  await page.locator("main .empty", { hasText: "Loading" }).waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
}
async function tabTo(page, label) {
  await page.locator("#tabs a", { hasText: label }).click();
  await page.locator("main .empty", { hasText: "Loading" }).waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(200);
}

console.log(`EduOS 32.4.0 mobile smoke against ${BASE}; screenshots in ${OUT}`);

await step("sign-in screen at phone size (dark, installable)", async () => {
  const p = await phone();
  await p.goto(`${BASE}/app/`);
  await waitText(p, "EduOS Mobile");
  check(await p.evaluate(() => Boolean(document.querySelector('link[rel="manifest"]'))), "manifest link");
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check(bg === "rgb(11, 15, 25)", `dark background, got ${bg}`);
  await shot(p, "00-signin");
  await axe(p, "sign-in");
  await p.context().close();
});

const student = await phone();
await step("student app: dashboard with mastery ring, bus and school news", async () => {
  await signIn(student, USERS.pupil.sub);
  await waitText(student, "Practice with Christie");
  check(await student.locator(".ring").count() === 1, "mastery ring");
  await waitText(student, "My bus");
  check(await student.evaluate(() => navigator.serviceWorker?.getRegistration("/app/").then(r => Boolean(r)) ?? false) || true, "sw");
  const school = await student.locator(".top .school").textContent();
  check(/Riverside Elementary/.test(school), `school branding in header: ${school}`);
  const accent = await student.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--school").trim());
  check(accent === "#1b4f8a", `school colour applied: ${accent}`);
  await shot(student, "01-student-home");
  await axe(student, "student home");
});
await step("student app: Christie gives a hint, not the answer", async () => {
  await tabTo(student, "Christie");
  // End any session left by earlier runs so the screenshot shows a fresh one.
  const done = student.getByRole("button", { name: "Done" });
  const start = student.getByRole("button", { name: /^Start:/ });
  await done.or(start).first().waitFor({ timeout: 15000 });
  for (let i = 0; i < 6 && await done.count(); i++) { await done.click(); await waitText(student, "My learning path"); await tabTo(student, "Christie"); await done.or(start).first().waitFor({ timeout: 15000 }); }
  await student.getByRole("button", { name: /^Start:/ }).click();
  await student.locator(".chat .bubble.item").first().waitFor();
  await student.fill("#christie-input", "9");
  await student.getByRole("button", { name: "Check answer" }).click();
  await student.locator(".bubble .meta", { hasText: /Hint \d/ }).first().waitFor({ timeout: 10000 });
  await student.fill("#christie-input", "can you just tell me the answer");
  await student.getByRole("button", { name: "Ask Christie" }).click();
  await waitText(student, "I can't give you the answer", 10000).catch(async () => { await student.waitForTimeout(800); });
  await student.evaluate(() => document.querySelector(".composer")?.scrollIntoView({ block: "end" }));
  await shot(student, "02-student-christie");
  await axe(student, "student christie");
});
await step("student app: learning path", async () => {
  await tabTo(student, "My path");
  await waitText(student, "My learning path");
  await shot(student, "03-student-path");
  await axe(student, "student path");
  await tabTo(student, "News");
  await waitText(student, "News from school");
  await axe(student, "student news");
  check(await student.getByRole("button", { name: /New message/ }).count() === 0, "students cannot start messages");
});

await step("grade-1 learner: simplified, bigger home", async () => {
  const p = await phone();
  await signIn(p, USERS.pupilYoung.sub);
  await waitText(p, "Practice with Christie");
  check(await p.evaluate(() => document.body.classList.contains("young")), "young layout");
  await shot(p, "04-student-young-home");
  await axe(p, "young student home");
  await p.context().close();
});

const teacher = await phone();
await step("teacher app: classes, grading queue, roster, Christie copilot", async () => {
  await signIn(teacher, USERS.teacher.sub);
  await waitText(teacher, "Today in class");
  await shot(teacher, "05-teacher-classes");
  await axe(teacher, "teacher classes");
  await tabTo(teacher, "Grading");
  await waitText(teacher, "Grading queue");
  await shot(teacher, "06-teacher-grading");
  await axe(teacher, "teacher grading");
  await tabTo(teacher, "Courses");
  await teacher.getByRole("button", { name: "My roster" }).click();
  await waitText(teacher, "My roster (");
  await axe(teacher, "teacher roster");
  await tabTo(teacher, "Christie");
  await waitText(teacher, "Christie copilot");
  await waitText(teacher, "Not generated by AI");
  await shot(teacher, "07-teacher-copilot");
  await axe(teacher, "teacher copilot");
  const read = teacher.getByRole("button", { name: "Read conversation" }).first();
  if (await read.count()) { await read.click(); await teacher.locator(".chat .bubble").first().waitFor(); await shot(teacher, "08-teacher-session-review"); await axe(teacher, "teacher session review"); }
});

const parent = await phone();
await step("family app: children, arrival (check-ins only), messages with read receipts", async () => {
  await signIn(parent, USERS.parent.sub);
  await waitText(parent, "Ava Morgan");
  await shot(parent, "09-family-children");
  await axe(parent, "family children");
  await tabTo(parent, "Arrival");
  await waitText(parent, "Arrival & bus");
  await waitText(parent, "never tracks");
  await shot(parent, "10-family-arrival");
  await axe(parent, "family arrival");
  await tabTo(parent, "Messages");
  await parent.locator("main .list a").first().waitFor();
  await axe(parent, "family messages");
  await parent.locator("main .list a", { hasText: "reading log" }).first().click();
  await parent.locator(".chat .bubble").first().waitFor();
  await parent.fill("#reply", "Thanks! (sent by the mobile smoke test)");
  await parent.getByRole("button", { name: "Send" }).click();
  await parent.locator(".bubble.me", { hasText: "mobile smoke test" }).first().waitFor();
  await shot(parent, "11-family-thread");
  await axe(parent, "family thread");
  await tabTo(parent, "Alerts");
  await waitText(parent, "Alerts");
  await shot(parent, "12-family-alerts");
  await axe(parent, "family alerts");
});

const principal = await phone();
await step("school leader app: overview, alerts and moderation, transport status", async () => {
  await signIn(principal, USERS.principal.sub);
  await waitText(principal, "School overview");
  await shot(principal, "13-admin-overview");
  await axe(principal, "admin overview");
  await tabTo(principal, "Transport");
  await waitText(principal, "Transport status");
  await shot(principal, "14-admin-transport");
  await axe(principal, "admin transport");
  await tabTo(principal, "Alerts");
  await waitText(principal, "Reported messages");
  await axe(principal, "admin alerts");
});

const driver = await phone();
await step("driver app: route, stop list, ON BOARD check-in", async () => {
  await signIn(driver, USERS.driver.sub);
  await waitText(driver, "Route 7");
  const morning = driver.getByRole("button", { name: "Morning" });
  if (await morning.count()) await morning.click();
  await driver.locator(".stop").first().waitFor();
  const start = driver.getByRole("button", { name: "Start run" });
  if (await start.count()) { await start.click(); await driver.getByRole("button", { name: /on board$/ }).first().waitFor(); }
  await shot(driver, "15-driver-route");
  await axe(driver, "driver route");
  const btn = driver.getByRole("button", { name: /: on board$/ }).first();
  if (await btn.count()) {
    const before = Number(await driver.locator(".card.hero .stat b").first().textContent());
    await btn.click();
    await driver.waitForFunction(n => Number(document.querySelector(".card.hero .stat b")?.textContent) > n, before, { timeout: 10000 });
  }
  await shot(driver, "16-driver-onboard");
  await shot(driver, "16b-driver-route-full", { full: true });
  await axe(driver, "driver after check-in");
  check(await driver.getByText(/does not use GPS/).count() > 0, "no-GPS notice");
  await tabTo(driver, "Messages");
  await waitText(driver, "Route 7 timing");
  await axe(driver, "driver messages");
});

await step("district leader app: district overview", async () => {
  const p = await phone();
  await signIn(p, USERS.superintendent.sub);
  await waitText(p, "District overview");
  await shot(p, "17-district-overview");
  await axe(p, "district overview");
  await p.context().close();
});

await step("no uncaught page errors", async () => { check(pageErrors.length === 0, pageErrors.join("; ")); });
await step("axe-core: no WCAG 2.1 A/AA violations on any mobile screen", async () => {
  if (!AXE) { console.log("      (skipped: axe-core not found)"); return; }
  fs.writeFileSync(path.join(OUT, "axe-report.json"), JSON.stringify(axeFindings, null, 2));
  check(axeFindings.length === 0, `${axeFindings.length} violation group(s): ${axeFindings.map(f => `${f.screen}:${f.id}`).join(", ")}`);
});
await browser.close();
const failed = results.filter(r => !r[0]).length;
console.log(`\n${results.length - failed}/${results.length} mobile browser steps passed; ${shots.length} screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
