#!/usr/bin/env node
// EduOS 32.5.0 SafetyOS + car pick-up phone smoke test (development only).
// Walks a full lockdown DRILL across the phone role apps (teacher starts it
// with the two-step confirm; student, driver and family see the full-screen
// state; teacher roll call; principal accountability board; reunification
// with pick-up verification; all clear; debrief) and the everyday car pick-up
// flow (family pass with QR, staff verify + photo-ID check, do-not-release
// block, approvals). axe-core on every screen. It always ends with all clear.
//
//   EDUOS_BASE                 default https://localhost:8443
//   EDUOS_SAFETY_SCREENSHOT_DIR default ./artifacts/screens/32.5
//   EDUOS_AXE_PATH / EDUOS_PLAYWRIGHT_DIR / CHROME_PATH as in dev/browser-smoke.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { USERS } from "./demo-fixture.js";

if (process.env.NODE_ENV === "production") { console.error("safety-smoke is a development tool"); process.exit(2); }
const BASE = (process.env.EDUOS_BASE || "https://localhost:8443").replace(/\/$/, "");
const OUT = path.resolve(process.env.EDUOS_SAFETY_SCREENSHOT_DIR || "artifacts/screens/32.5");
fs.mkdirSync(OUT, { recursive: true });
const home = process.env.HOME || "/";
const bases = [import.meta.url, process.env.EDUOS_PLAYWRIGHT_DIR && path.join(process.env.EDUOS_PLAYWRIGHT_DIR, "/"), path.join(home, "tools/pw/")].filter(Boolean);
let pw; for (const b of bases) { try { pw = createRequire(b)("playwright-core"); break; } catch {} }
if (!pw) { console.error("playwright-core not found (see dev/browser-smoke.mjs)"); process.exit(2); }
const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean).find(p => fs.existsSync(p));
if (!chrome) { console.error("No Chrome/Chromium found; set CHROME_PATH."); process.exit(2); }
const AXE = [process.env.EDUOS_AXE_PATH, process.env.EDUOS_PLAYWRIGHT_DIR && path.join(process.env.EDUOS_PLAYWRIGHT_DIR, "node_modules/axe-core/axe.min.js"), path.join(home, "tools/pw/node_modules/axe-core/axe.min.js")].filter(Boolean).find(p => fs.existsSync(p)) || null;

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
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ path: AXE });
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
const loaded = p => p.locator("main .empty", { hasText: "Loading" }).waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
async function reload(page) { await page.reload(); await page.locator(".top h1").waitFor({ timeout: 15000 }); await loaded(page); await page.waitForTimeout(250); }
const banner = p => p.locator(".sos-banner").first();
const dialog = p => p.locator("dialog[open]");
async function allClearIfLive(page) {
  await reload(page);
  if (!(await banner(page).count())) return false;
  await page.getByRole("button", { name: "All clear", exact: true }).click();
  await dialog(page).getByRole("button", { name: "Yes, all clear" }).click();
  await page.locator(".sos-banner").waitFor({ state: "detached", timeout: 15000 });
  return true;
}

console.log(`EduOS 32.5.0 SafetyOS + pick-up phone smoke against ${BASE}; screenshots in ${OUT}`);
const parent = await phone(), principal = await phone(), teacher = await phone(), student = await phone(), driver = await phone();
let familyCode = null;

await step("sign in: family, school leader, teacher, student and driver phones", async () => {
  await signIn(parent, USERS.parent.sub); await signIn(principal, USERS.principal.sub); await signIn(teacher, USERS.teacher.sub);
  await signIn(student, USERS.pupil.sub); await signIn(driver, USERS.driver.sub);
  if (await allClearIfLive(principal)) console.log("      (cleared an alert left by an interrupted run)");
  check(await teacher.locator(".iconbtn.sos").count() === 1, "staff have the safety button");
  check(await student.locator(".iconbtn.sos").count() === 0 && await parent.locator(".iconbtn.sos").count() === 0, "students and families do not");
  check(!(await parent.locator(".top").textContent()).includes("null"), "no stray text in the header");
});

// ---------------- everyday car pick-up ----------------
await step("family: pick-up tab lists who can collect, with approval status", async () => {
  await tabTo(parent, "Pick-up");
  await waitText(parent, "Who can pick up");
  await waitText(parent, "Ruth Morgan"); await waitText(parent, "Waiting for school");
  await shot(parent, "20-family-pickup");
  await axe(parent, "family pick-up");
});
await step("family: 'Show my pick-up pass' makes a QR + code shown once", async () => {
  await parent.getByRole("button", { name: /Show my pick-up pass|New pass for me/ }).first().click();
  await parent.locator(".card.pass .qr svg").waitFor({ timeout: 15000 });
  familyCode = (await parent.locator(".card.pass .code").textContent()).trim();
  check(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(familyCode), `code format ${familyCode}`);
  await shot(parent, "21-family-pass");
  await axe(parent, "family pass");
});
await step("school leader: pick-up approvals, early dismissals and restrictions", async () => {
  await tabTo(principal, "Pick-up");
  await principal.locator(".seg button", { hasText: "Approvals" }).click(); await loaded(principal);
  await waitText(principal, "Adults to approve"); await waitText(principal, "Sam Rivera"); await waitText(principal, "Dentist appointment");
  await waitText(principal, "do not release to Pat Brooks");
  await shot(principal, "22-admin-pickup-approvals");
  await axe(principal, "pick-up approvals");
});
await step("teacher on pick-up duty: pass + photo-ID check releases the learner", async () => {
  await teacher.getByRole("button", { name: /Pick-up duty/ }).click(); await loaded(teacher);
  await teacher.fill("#pass-code", "rthm2 ava4k");
  await teacher.getByRole("button", { name: "Check pass" }).click();
  await teacher.locator(".verify.ok").waitFor({ timeout: 10000 });
  await waitText(teacher, "Ruth Morgan");
  await teacher.getByRole("button", { name: "Release" }).click();
  await waitText(teacher, "Check the photo ID first.");
  await teacher.check("#id-ok");
  await shot(teacher, "23-staff-verify");
  await axe(teacher, "staff verify");
  await teacher.getByRole("button", { name: "Release" }).click();
  await loaded(teacher);
  await teacher.locator("main li", { hasText: "Ava Morgan → Ruth Morgan" }).first().waitFor({ timeout: 10000 });
  await shot(teacher, "24-staff-released");
});
await step("teacher: a do-not-release pass is blocked and the office is alerted", async () => {
  await teacher.fill("#pass-code", "PATB7-N0AH5");
  await teacher.getByRole("button", { name: "Check pass" }).click();
  await teacher.locator(".verify.bad", { hasText: "DO NOT RELEASE" }).waitFor({ timeout: 10000 });
  check(await teacher.getByRole("button", { name: "Release" }).count() === 0, "no release button");
  check(!(await teacher.locator("main").textContent()).includes("Protective order"), "the line sees a flag, not the file");
  await shot(teacher, "25-staff-blocked");
  await axe(teacher, "staff blocked");
});

// ---------------- SafetyOS lockdown drill ----------------
await step("teacher starts a lockdown DRILL: step 1 of 2, nothing sent yet", async () => {
  await teacher.locator(".iconbtn.sos").click(); await loaded(teacher);
  await waitText(teacher, "Start an alert");
  await teacher.locator(".kind.lockdown").click(); await loaded(teacher);
  check(await teacher.locator('.kind.lockdown[aria-pressed="true"]').count() === 1, "lockdown selected");
  check(await teacher.locator('.seg button[aria-pressed="true"]', { hasText: "Drill" }).count() === 1, "drill is the default");
  await shot(teacher, "26-teacher-sos-start");
  await axe(teacher, "sos start");
  await teacher.getByRole("button", { name: "Continue" }).click();
  await dialog(teacher).waitFor({ timeout: 10000 });
  await waitText(teacher, "Confirm within 2 minutes");
  await reload(student);
  check(await banner(student).count() === 0, "a pending alert is not broadcast");
  await shot(teacher, "27-teacher-sos-confirm");
  await axe(teacher, "sos confirm dialog");
});
await step("teacher confirms: the full-screen LOCKDOWN state with the drill ribbon", async () => {
  await dialog(teacher).getByRole("button", { name: "Yes, start drill" }).click();
  await banner(teacher).waitFor({ timeout: 15000 });
  await waitText(teacher, "Roll call · my class");
  check(await teacher.evaluate(() => document.body.classList.contains("sos-mode") && getComputedStyle(document.getElementById("tabs")).display === "none"), "tabs hidden in sos-mode");
  await waitText(teacher, "DRILL · THIS IS A DRILL");
});
await step("student, driver and family phones switch to the full-screen state", async () => {
  for (const [page, name, text] of [[student, "28-student-lockdown", "Stay with your teacher"], [driver, "29-driver-lockdown", "LOCKDOWN"], [parent, "30-family-lockdown", "Students are with school staff"]]) {
    await reload(page);
    await banner(page).waitFor({ timeout: 15000 });
    await waitText(page, text);
    check(await page.locator(".sos-banner .drill").count() === 1, `${name} drill ribbon`);
    const body = await page.locator("main").textContent();
    check(!/missing|injured|Noah|Liam|Sofia/i.test(body), `${name}: no other learners or roll-call data`);
    await page.evaluate(() => { location.hash = "#/messages"; });
    await page.waitForTimeout(600);
    check(await banner(page).count() === 1, `${name}: other tabs wait for the all clear`);
    await shot(page, name);
    await axe(page, name.replace(/^\d+-/, ""));
  }
});
await step("teacher roll call: present / missing, plus an extra learner from another class", async () => {
  const card = teacher.locator('section[aria-label="Roll call"]');
  for (const name of ["Ava Morgan", "Liam Patel", "Sofia Garcia"]) await card.locator(`[aria-label="${name}: status"] button.present`).click();
  await card.locator('[aria-label="Noah Brooks: status"] button.missing').click();
  await teacher.fill("#extra-q", "Mia");
  await card.getByRole("button", { name: "Add", exact: true }).click();
  await waitText(teacher, "Also in my room");
  await shot(teacher, "31-teacher-rollcall", { full: true });
  await axe(teacher, "teacher roll call");
  await card.getByRole("button", { name: "Send roll call" }).click();
  await waitText(teacher, "Roll call sent: 3 present, 1 missing, 0 injured");
});
await step("school leader: live accountability board", async () => {
  await reload(principal);
  await banner(principal).waitFor({ timeout: 15000 });
  await waitText(principal, "Accountability");
  await principal.locator('section[aria-label="Missing and injured"]', { hasText: "Noah Brooks" }).waitFor({ timeout: 10000 });
  await waitText(principal, "Jordan Lee · 4 learners");
  await shot(principal, "32-admin-board");
  await shot(principal, "32b-admin-board-full", { full: true });
  await axe(principal, "accountability board");
});
await step("school leader logs responders and starts reunification (in-app dialog)", async () => {
  await principal.getByRole("button", { name: "First responders" }).click();
  await dialog(principal).getByRole("button", { name: "Log it" }).click();
  await principal.locator(".timeline", { hasText: "First responders" }).waitFor({ timeout: 10000 });
  await principal.getByRole("button", { name: "Start reunification" }).click();
  await dialog(principal).locator("textarea").fill("Gym, east doors");
  await axe(principal, "reunification dialog");
  await dialog(principal).getByRole("button", { name: "Start reunification" }).click();
  await principal.locator(".sos-banner.reunify").waitFor({ timeout: 15000 });
  await waitText(principal, "Gym, east doors");
  await shot(principal, "33-admin-reunification");
  await axe(principal, "reunification board");
});
await step("family: reunification notice with only their own child, and a fresh pass", async () => {
  await reload(parent);
  await parent.locator(".sos-banner.reunify").waitFor({ timeout: 15000 });
  await waitText(parent, "Ava Morgan"); await waitText(parent, "With staff");
  await shot(parent, "34-family-reunification");
  await axe(parent, "family reunification");
  await parent.getByRole("button", { name: "Show my pick-up pass" }).click(); await loaded(parent);
  await parent.getByRole("button", { name: /New pass for me|Show my pick-up pass/ }).first().click();
  await parent.locator(".card.pass .qr svg").waitFor({ timeout: 15000 });
  familyCode = (await parent.locator(".card.pass .code").textContent()).trim();
});
await step("teacher releases Ava to her guardian through pick-up verification", async () => {
  await reload(teacher);
  await teacher.getByRole("button", { name: /Pick-up line/ }).click(); await loaded(teacher);
  await waitText(teacher, "Reunification in progress");
  await teacher.fill("#pass-code", familyCode);
  await teacher.getByRole("button", { name: "Check pass" }).click();
  await teacher.locator(".verify.ok", { hasText: "Reunification release" }).waitFor({ timeout: 10000 });
  await teacher.check("#id-ok");
  await shot(teacher, "35-staff-reunification-verify");
  await axe(teacher, "reunification verify");
  await teacher.getByRole("button", { name: "Release" }).click();
  await teacher.locator("main li", { hasText: "Ava Morgan → Alex Morgan" }).first().waitFor({ timeout: 10000 });
});
await step("family sees the release; the board counts it", async () => {
  await reload(parent);
  await waitText(parent, "Released to Alex Morgan");
  await shot(parent, "36-family-released");
  await reload(principal);
  await principal.locator(".stat", { hasText: "released to family" }).filter({ hasText: "1" }).first().waitFor({ timeout: 10000 });
});
await step("all clear (two-step): every phone returns to normal", async () => {
  await principal.getByRole("button", { name: "All clear", exact: true }).click();
  await dialog(principal).waitFor();
  await shot(principal, "37-admin-all-clear-confirm");
  await axe(principal, "all clear dialog");
  await dialog(principal).getByRole("button", { name: "Yes, all clear" }).click();
  await principal.locator(".sos-banner").waitFor({ state: "detached", timeout: 15000 });
  for (const p of [student, driver, parent, teacher]) {
    await reload(p);
    check(await banner(p).count() === 0, "banner gone");
    check(await p.evaluate(() => !document.body.classList.contains("sos-mode")), "tabs back");
  }
  await waitText(student, "Practice with Christie");
});
await step("school leader: incident history and debrief", async () => {
  await principal.locator(".iconbtn.sos").click(); await loaded(principal);
  await waitText(principal, "Recent incidents and drills");
  await principal.getByRole("button", { name: "Debrief" }).first().click();
  await dialog(principal).locator("textarea").fill("Drill debrief (smoke): roll call in under 5 minutes; Noah was found in the library.");
  await dialog(principal).getByRole("button", { name: "Save debrief" }).click();
  await waitText(principal, "Debrief saved");
  await principal.locator('section[aria-label="Recent incidents"]').scrollIntoViewIfNeeded();
  await shot(principal, "38-admin-incident-history");
  await axe(principal, "incident history");
});
await step("alerts: the family got generic in-app notices only", async () => {
  await reload(parent);
  await parent.locator(".top .iconbtn").first().click(); await loaded(parent);
  await waitText(parent, "Lockdown in effect (drill)");
  const body = await parent.locator("main").textContent();
  check(!/Noah|missing|injured/i.test(body), "no other learners or roll call in family alerts");
  await shot(parent, "39-family-alerts");
  await axe(parent, "family alerts");
});

for (const p of [parent, principal, teacher, student, driver]) await p.context().close().catch(() => {});
await step("no uncaught page errors", async () => { check(pageErrors.length === 0, pageErrors.join("; ")); });
await step("axe-core: no WCAG 2.1 A/AA violations on any SafetyOS / pick-up screen", async () => {
  if (!AXE) { console.log("      (skipped: axe-core not found)"); return; }
  fs.writeFileSync(path.join(OUT, "axe-report.json"), JSON.stringify(axeFindings, null, 2));
  check(axeFindings.length === 0, `${axeFindings.length} violation group(s): ${axeFindings.map(f => `${f.screen}:${f.id}`).join(", ")}`);
});
await browser.close();
const failed = results.filter(r => !r[0]).length;
console.log(`\n${results.length - failed}/${results.length} SafetyOS phone steps passed; ${shots.length} screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
