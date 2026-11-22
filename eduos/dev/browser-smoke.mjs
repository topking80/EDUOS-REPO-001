#!/usr/bin/env node
// EduOS 32.3.0 browser smoke test (development only). 32.3.0 adds the school
// branding designer, previews, the WCAG AA publish gate and branded views.
//
// Drives the real UI in headless Chrome against a running dev stack
// (`make up`), signing in through the dev identity provider exactly as a
// person would, and saves screenshots of the key screens. 32.2.0 adds a home
// screen per role (desktop and 390px mobile), the app mesh (catalog, launch,
// requests) and an axe-core WCAG 2.1 A/AA scan of every role's main screens.
//
//   EDUOS_AXE_PATH        axe.min.js (default: <playwright dir>/node_modules/axe-core/axe.min.js);
//                         the scan is skipped with a warning if it is missing
//   EDUOS_BASE            default https://localhost:8443
//   EDUOS_SCREENSHOT_DIR  default ./artifacts/screens
//   CHROME_PATH           Chrome/Chromium binary (auto-detected)
//   EDUOS_PLAYWRIGHT_DIR  directory containing node_modules/playwright-core,
//                         if it is not resolvable from this repo (it is not a
//                         project dependency on purpose)
//
// The local Caddy CA is not in Chrome's trust store, so certificate errors are
// ignored for this origin only (ignoreHTTPSErrors on the test context).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

if (process.env.NODE_ENV === "production") { console.error("browser-smoke is a development tool"); process.exit(2); }
const BASE = (process.env.EDUOS_BASE || "https://localhost:8443").replace(/\/$/, "");
const OUT = path.resolve(process.env.EDUOS_SCREENSHOT_DIR || "artifacts/screens");
const RUN = crypto.randomBytes(3).toString("hex");
fs.mkdirSync(OUT, { recursive: true });

function loadPlaywright() {
  const bases = [import.meta.url, process.env.EDUOS_PLAYWRIGHT_DIR && path.join(process.env.EDUOS_PLAYWRIGHT_DIR, "/"), path.join(process.env.HOME || "/", "tools/pw/")].filter(Boolean);
  for (const base of bases) { try { return createRequire(base)("playwright-core"); } catch {} }
  console.error("playwright-core not found. Install it outside the repo, e.g.\n  mkdir -p ~/tools/pw && npm --prefix ~/tools/pw i playwright-core\nthen set EDUOS_PLAYWRIGHT_DIR=~/tools/pw");
  process.exit(2);
}
function findChrome() {
  const c = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  const found = c.find(p => fs.existsSync(p));
  if (!found) { console.error("No Chrome/Chromium found; set CHROME_PATH."); process.exit(2); }
  return found;
}

const { chromium } = loadPlaywright();
function findAxe() {
  const c = [process.env.EDUOS_AXE_PATH, process.env.EDUOS_PLAYWRIGHT_DIR && path.join(process.env.EDUOS_PLAYWRIGHT_DIR, "node_modules/axe-core/axe.min.js"),
    path.join(process.env.HOME || "/", "tools/pw/node_modules/axe-core/axe.min.js")].filter(Boolean);
  return c.find(p => fs.existsSync(p)) || null;
}
const AXE = findAxe();
if (!AXE && process.env.EDUOS_REQUIRE_AXE === "1") { console.error("EDUOS_REQUIRE_AXE=1 but axe-core was not found (set EDUOS_AXE_PATH)"); process.exit(2); }
if (!AXE) console.warn("axe-core not found: skipping the accessibility scan");

// Injected over the DevTools protocol, not as a <script> tag: the app's Content
// Security Policy (script-src 'self') rightly blocks inline scripts, and
// loosening it for tests would hide real CSP problems.
async function injectAxe(page) {
  const cdp = await page.context().newCDPSession(page);
  try { await cdp.send("Runtime.evaluate", { expression: fs.readFileSync(AXE, "utf8") }); } finally { await cdp.detach().catch(() => {}); }
}
const axeFindings = [];
// WCAG 2.0/2.1/2.2 level A and AA rules only (CMP-02).
async function axe(page, label) {
  if (!AXE) return;
  await page.evaluate(() => document.querySelectorAll("[data-eduos-toast]").forEach(x => x.remove()));
  if (!(await page.evaluate(() => Boolean(window.axe)))) await injectAxe(page);
  const r = await page.evaluate(() => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] }, resultTypes: ["violations"] }));
  for (const v of r.violations) axeFindings.push({ screen: label, id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map(n => ({ target: n.target.join(" "), summary: n.failureSummary })) });
  console.log(`      axe ${label}: ${r.violations.length ? r.violations.map(v => `${v.id}(${v.nodes.length})`).join(", ") : "no violations"}`);
}
async function mobile(page, name) {
  const vp = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  await shot(page, name, true);
  await axe(page, `${name} (390px)`);
  await page.setViewportSize(vp);
}
const browser = await chromium.launch({ executablePath: findChrome(), args: ["--no-sandbox"] });
const results = []; const shots = [];
const pageErrors = [];
const cspViolations = []; // the CSP allows no inline script; anything it blocks is a bug

async function newPage() {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("pageerror", e => pageErrors.push(e.message));
  page.on("console", m => { if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text().slice(0, 200)); });
  page.dialogAnswers = [];
  page.on("dialog", d => { const a = page.dialogAnswers.shift(); a === false ? d.dismiss() : d.accept(a === true || a === undefined ? undefined : a); });
  return page;
}
async function shot(page, name, fullPage = false, { top = true } = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.evaluate(top => { document.querySelectorAll("[data-eduos-toast]").forEach(x => x.remove()); if (top) window.scrollTo(0, 0); }, top);
  await page.waitForTimeout(250);
  await page.screenshot({ path: file, fullPage });
  shots.push(file);
}
async function step(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  ✔ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✖ ${name}\n      ${String(e.message || e).split("\n")[0]}`); }
}
function check(cond, msg) { if (!cond) throw new Error(msg); }

async function signIn(page, sub, custom) {
  if (!/\/authorize/.test(page.url())) {
    if (!page.url().startsWith(BASE)) await page.goto(BASE + "/");
    await page.click("#eduos-api-connect");
  }
  await page.waitForURL(/\/authorize/);
  if (custom) {
    await page.fill('fieldset.custom input[name="sub"]', sub);
    if (custom.name) await page.fill('fieldset.custom input[name="name"]', custom.name);
    if (custom.email) await page.fill('fieldset.custom input[name="email"]', custom.email);
    await page.click('fieldset.custom button[type="submit"]');
  } else {
    await page.click(`button[data-sub="${sub}"]`);
  }
  await page.waitForURL(u => u.href.startsWith(BASE));
  await page.waitForFunction(() => /Server records loaded/.test(document.getElementById("eduos-api-state")?.textContent || ""), null, { timeout: 15000 });
}
// Option labels carry extra context ("Liam Patel · 4"), so match by prefix.
async function selectByText(select, text) {
  const value = await select.evaluate((s, t) => [...s.options].find(o => o.textContent.trim().startsWith(t))?.value, text);
  if (!value) throw new Error(`no option starting with ${text}`);
  await select.selectOption(value);
}
const tab = (page, name) => page.click(`#eduos-api-content [data-tab="${name}"]`);
const content = page => page.locator("#eduos-api-content");
const waitText = (page, text, timeout = 10000) => content(page).getByText(text, { exact: false }).first().waitFor({ timeout });

console.log(`EduOS browser smoke against ${BASE} (run ${RUN})`);
const sup = await newPage();

await step("landing page offers district sign-in and no demo persona UI", async () => {
  await sup.goto(BASE + "/");
  await sup.waitForSelector("#eduos-api-connect:not([hidden])");
  check(await sup.locator("body > .app").isHidden(), "legacy demo UI is visible outside demo mode");
  await waitText(sup, "Welcome to EduOS");
  await shot(sup, "01-landing");
});
await step("dev identity provider shows the demo account picker", async () => {
  await sup.click("#eduos-api-connect");
  await sup.waitForSelector('button[data-sub="demo-superintendent"]');
  await shot(sup, "02-dev-identity-provider", true);
});
await step("superintendent signs in to the district home", async () => {
  await signIn(sup, "demo-superintendent");
  await waitText(sup, "Apps in the district catalog");
  check(/superintendent/i.test(await sup.locator("#eduos-api-actor").textContent()), "actor label");
  check(await sup.locator('#eduos-api-content nav [aria-current="page"]').textContent() === "Home", "Home is the current tab");
  await shot(sup, "03-superintendent-home");
  await axe(sup, "superintendent home");
  await mobile(sup, "03m-superintendent-home-mobile");
});
await step("superintendent student directory with search", async () => {
  await tab(sup, "students");
  await waitText(sup, "Student directory");
  const f = sup.locator('form[data-form="student-search"]');
  await f.locator("[name=q]").fill("Noah");
  await f.locator("button[type=submit]").click();
  await sup.waitForFunction(() => { const t = document.querySelector("#eduos-api-content")?.textContent || ""; return t.includes("Noah Brooks") && !t.includes("Ava Morgan"); }, null, { timeout: 10000 });
  await shot(sup, "03b-superintendent-student-directory");
  await axe(sup, "superintendent students");
});
await step("student 360 profile with FERPA export", async () => {
  await sup.locator('#eduos-api-content tr', { hasText: "Noah Brooks" }).locator('[data-action="profile"]').click();
  await sup.waitForSelector("#api-profile [data-action=records-export]");
  const dl = sup.waitForEvent("download");
  await sup.click("#api-profile [data-action=records-export]");
  const file = await (await dl).path();
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  check(record.student?.display_name === "Noah Brooks", "export contains the student");
  await sup.evaluate(() => { const p = document.getElementById("api-profile"); window.scrollTo(0, p.getBoundingClientRect().top + window.scrollY - 60); });
  await shot(sup, "04-student-360-profile", false, { top: false });
  await sup.click("#api-profile [data-action=close-profile]");
  // Clearing the search returns to the paged directory (the first 100 by name).
  await sup.click('[data-action="student-search-clear"]');
  await sup.waitForFunction(() => !document.querySelector('[data-action="student-search-clear"]'));
});
const teacherSub = `browser-teacher-${RUN}`;
await step("administration: provision a teacher through the form", async () => {
  await tab(sup, "admin");
  await waitText(sup, "District people");
  const f = sup.locator('form[data-form="user-create"]');
  await f.locator('[name=displayName]').fill(`Casey Browser ${RUN}`);
  await f.locator('[name=email]').fill(`casey.${RUN}@riverside-usd.example`);
  await f.locator('[name=oidcSubject]').fill(teacherSub);
  await f.locator('[name=role]').selectOption("teacher");
  await selectByText(f.locator('[name=schoolId]'), "Riverside Elementary");
  await f.locator("button").click();
  await waitText(sup, teacherSub);
  await shot(sup, "05-administration", true);
});
await step("SIS CSV import from file upload", async () => {
  await tab(sup, "sis");
  const f = sup.locator('form[data-form="sis-import"]');
  await selectByText(f.locator('[name=schoolId]'), "Riverside Elementary");
  await f.locator('[name=sourceBatchId]').fill(`browser-${RUN}`);
  await f.locator('[name=studentsFile]').setInputFiles({ name: "students.csv", mimeType: "text/csv",
    buffer: Buffer.from(`local_student_number,display_name,grade_level\r\nBR-${RUN},"Diaz, Rowan",5\r\n`) });
  await f.locator("button").click();
  await waitText(sup, `browser-${RUN}`);
  await shot(sup, "06-sis-import");
});
await step("webhooks: create, show secret once, send a test delivery", async () => {
  await tab(sup, "webhooks");
  const f = sup.locator('form[data-form="webhook-create"]');
  await f.locator('[name=url]').fill(`http://127.0.0.1:9999/hooks/browser-${RUN}`);
  await f.locator("button").click();
  await sup.waitForSelector("#api-webhook-secret");
  check((await sup.inputValue("#api-webhook-secret")).length >= 32, "secret shown");
  const row = sup.locator("#eduos-api-content tr", { hasText: `browser-${RUN}` });
  await row.locator('[data-action="webhook-test"]').click();
  await sup.locator("#eduos-api-content tr", { hasText: `browser-${RUN}` }).getByText("delivered").waitFor();
  await sup.locator("#eduos-api-content tr", { hasText: `browser-${RUN}` }).locator('[data-action="webhook-deliveries"]').click();
  await waitText(sup, "Recent deliveries");
  await shot(sup, "07-webhooks", true);
});
await step("audit log", async () => {
  await tab(sup, "audit");
  await sup.waitForSelector("#eduos-api-content table");
  await shot(sup, "08-audit");
  await axe(sup, "superintendent audit");
});
await step("district app catalog: privacy badges, licenses, sharing and usage", async () => {
  await tab(sup, "apps");
  await waitText(sup, "Lincoln Lab Notebook");
  await shot(sup, "16-superintendent-apps", true);
  await axe(sup, "superintendent apps");
  await sup.locator("#eduos-api-content tr", { hasText: "MathQuest" }).locator('[data-action="app-manage"]').click();
  await waitText(sup, "seats used");
  await shot(sup, "17-superintendent-app-manage", true);
  await axe(sup, "superintendent app manage");
});
await step("district reviews app requests and settings (no limits by default)", async () => {
  await tab(sup, "app_requests");
  await waitText(sup, "Phonics Plus");
  await shot(sup, "18-superintendent-app-requests");
  await axe(sup, "superintendent app requests");
  await tab(sup, "district");
  await sup.waitForSelector('form[data-form="district-settings"]');
  await shot(sup, "19-district-settings");
  await axe(sup, "district settings");
});

// Teacher: draft -> publish, then the student sees only the published work.
const teacher = await newPage();
const draftTitle = `Browser draft ${RUN}`;
await step("teacher creates a draft assignment and publishes it", async () => {
  await signIn(teacher, "demo-teacher");
  await waitText(teacher, "Students on your roster");
  await shot(teacher, "09a-teacher-home");
  await axe(teacher, "teacher home");
  await mobile(teacher, "09m-teacher-home-mobile");
  await tab(teacher, "assignments");
  const f = teacher.locator('form[data-form="assignment"]');
  await f.locator('[name=title]').fill(draftTitle);
  await f.locator('[name=status]').selectOption("draft");
  await f.locator("button").click();
  const row = teacher.locator("#eduos-api-content tr", { hasText: draftTitle });
  await row.getByText("draft", { exact: true }).waitFor();
  await shot(teacher, "09-teacher-assignments", true);
  await axe(teacher, "teacher assignments");
});
await step("teacher opens a district app from the launcher in a new tab", async () => {
  await tab(teacher, "home");
  // The vendor URL is a reserved .example name: answer it locally.
  await teacher.context().route("https://reading-room.example/**", r => r.fulfill({ contentType: "text/html", body: "<title>Reading Room</title><h1>Reading Room (stub)</h1>" }));
  const popup = teacher.context().waitForEvent("page");
  await teacher.locator('#eduos-api-content [data-action="app-launch"][data-name="Riverside Reading Room"]').click();
  const p = await popup;
  await p.waitForURL(u => u.href.startsWith("https://reading-room.example/"), { timeout: 10000 });
  check(await p.evaluate(() => window.opener === null), "launched app has no opener");
  await p.close();
});
const pupil = await newPage();
await step("student does not see the draft, sees published work with Submit", async () => {
  await signIn(pupil, "demo-student");
  await waitText(pupil, "Due in the next 7 days");
  await shot(pupil, "10a-student-home");
  await axe(pupil, "student home");
  await mobile(pupil, "10m-student-home-mobile");
  await tab(pupil, "assignments");
  await waitText(pupil, "Fractions practice set");
  check(await pupil.locator("#eduos-api-content", { hasText: draftTitle }).count() === 0, "draft visible to pupil");
  check(await pupil.locator('[data-action="submit"]').count() > 0, "pupil has Submit work");
  await shot(pupil, "10-student-assignments");
  await axe(pupil, "student assignments");
});
await step("grade-1 learner gets the simplified home with big buttons", async () => {
  const young = await newPage();
  await signIn(young, "demo-student-young");
  await young.locator("#eduos-api-content .api-young").waitFor();
  await waitText(young, "Hi, Leo!");
  check(await young.locator("#eduos-api-content .api-launcher.young .api-tile").count() >= 1, "young launcher tiles");
  await shot(young, "10y-young-student-home");
  await axe(young, "young student home");
  await mobile(young, "10ym-young-student-home-mobile");
  await young.context().close();
});
await step("published draft becomes visible to the student", async () => {
  await tab(teacher, "assignments");
  await teacher.locator("#eduos-api-content tr", { hasText: draftTitle }).locator('[data-action="assignment-status"]').click();
  await teacher.locator("#eduos-api-content tr", { hasText: draftTitle }).getByText("published", { exact: true }).waitFor();
  await pupil.click("#eduos-api-refresh");
  await pupil.waitForFunction(() => /Server records loaded/.test(document.getElementById("eduos-api-state")?.textContent || ""));
  await tab(pupil, "assignments");
  await waitText(pupil, draftTitle);
});

// Principal: rosters and a guardian invitation for a brand-new parent account.
const principal = await newPage();
const parentSub = `browser-parent-${RUN}`, parentEmail = `parent.${RUN}@family.example`;
let inviteUrl = "";
await step("principal manages rosters", async () => {
  await signIn(principal, "demo-principal");
  await waitText(principal, "Apps available to your school");
  await shot(principal, "11a-principal-home");
  await axe(principal, "principal home");
  await mobile(principal, "11m-principal-home-mobile");
  await tab(principal, "rosters");
  await principal.locator("#eduos-api-content .api-card b", { hasText: "Jordan Lee" }).waitFor();
  await shot(principal, "11-rosters");
  await axe(principal, "principal rosters");
});
await step("principal sees school apps and requests a new one from the district", async () => {
  await tab(principal, "apps");
  await waitText(principal, "MathQuest");
  await shot(principal, "11b-principal-apps", true);
  await axe(principal, "principal apps");
  await tab(principal, "app_requests");
  const f = principal.locator('form[data-form="app-request"]');
  await f.locator("[name=name]").fill(`Story Builder ${RUN}`);
  await f.locator("[name=reason]").fill("Grade 3 writing workshop");
  await f.locator("button[type=submit]").click();
  await waitText(principal, `Story Builder ${RUN}`);
  await shot(principal, "11c-principal-app-requests");
  await axe(principal, "principal app requests");
});
await step("principal adds a parent account and creates a guardian invitation", async () => {
  await tab(principal, "admin");
  const f = principal.locator('form[data-form="user-create"]');
  await f.locator('[name=displayName]').fill(`Robin Family ${RUN}`);
  await f.locator('[name=email]').fill(parentEmail);
  await f.locator('[name=oidcSubject]').fill(parentSub);
  await f.locator('[name=role]').selectOption("parent");
  await f.locator("button").click();
  await principal.locator("#eduos-api-content td", { hasText: parentEmail }).first().waitFor();
  await tab(principal, "guardians");
  const g = principal.locator('form[data-form="invite-create"]');
  await selectByText(g.locator('[name=studentId]'), "Liam Patel");
  await g.locator('[name=email]').fill(parentEmail);
  await g.locator("button").click();
  await principal.waitForSelector("#api-invite-url");
  inviteUrl = await principal.inputValue("#api-invite-url");
  check(inviteUrl.startsWith(BASE + "/#guardianInvite="), "invitation link");
  await shot(principal, "12-guardian-invitation");
});
const family = await newPage();
await step("parent opens the invitation link, signs in and accepts", async () => {
  await family.goto(inviteUrl);
  await waitText(family, "Guardian invitation detected");
  check(!family.url().includes("guardianInvite"), "token removed from the address bar");
  await signIn(family, parentSub, { name: `Robin Family ${RUN}`, email: parentEmail });
  await family.waitForSelector('form[data-form="invite-accept"]');
  check((await family.inputValue('form[data-form="invite-accept"] [name=token]')).length >= 40, "token prefilled");
  await shot(family, "13-guardian-accept");
  await family.click('form[data-form="invite-accept"] button');
  await family.locator("#eduos-api-content :is(td,.api-child h3)", { hasText: "Liam Patel" }).first().waitFor({ timeout: 15000 });
  await shot(family, "14-parent-linked-child");
});
const parent = await newPage();
await step("demo parent sees their child's work without Submit buttons", async () => {
  await signIn(parent, "demo-parent");
  await parent.locator("#eduos-api-content .api-child", { hasText: "Ava Morgan" }).first().waitFor();
  await shot(parent, "15a-parent-home");
  await axe(parent, "parent home");
  await mobile(parent, "15m-parent-home-mobile");
  await tab(parent, "assignments");
  await waitText(parent, "Fractions practice set");
  check(await parent.locator('[data-action="submit"]').count() === 0, "parent offered Submit work");
  await shot(parent, "15-parent-assignments");
  await axe(parent, "parent assignments");
});
await step("IT admin home: integrations, accounts and apps without student data", async () => {
  const it = await newPage();
  await signIn(it, "demo-it-admin");
  await waitText(it, "Integrations");
  check(await it.locator('#eduos-api-content nav [data-tab="students"]').count() === 0, "no Students tab for IT");
  await shot(it, "20-it-admin-home");
  await axe(it, "IT admin home");
  await mobile(it, "20m-it-admin-home-mobile");
  await tab(it, "apps");
  await it.locator('#eduos-api-content details:has(form[data-form="app-create"]) > summary').click();
  const f = it.locator('form[data-form="app-create"]');
  await f.locator("[name=name]").fill(`Browser App ${RUN}`);
  await f.locator("[name=vendor]").fill("Example Vendor");
  await f.locator("[name=launchUrl]").fill("https://browser-app.example/start");
  await f.locator("button[type=submit]").click();
  await waitText(it, `Browser App ${RUN}`);
  await shot(it, "21-it-admin-apps", true);
  await axe(it, "IT admin apps");
  await tab(it, "admin");
  await waitText(it, "District people");
  check(await it.locator('form[data-form="user-create"] [name=role] option[value="superintendent"]').count() === 0, "IT cannot create superintendents");
  await shot(it, "22-it-admin-people", true);
  await axe(it, "IT admin people");
  await it.context().close();
});
// ---- 32.3.0 school branding: design, preview, AA gate, publish, every audience ----
const RIVERSIDE = "00000000-0000-4000-8000-000000000101", DISTRICT_ID = "00000000-0000-4000-8000-000000000001";
const brandMotto = `Browser run ${RUN}`;
let brander;
await step("principal opens the branding designer for their school", async () => {
  brander = await newPage();
  await signIn(brander, "demo-principal");
  await tab(brander, "branding");
  await brander.locator("[data-brand-designer]").waitFor();
  const opts = await brander.locator("#eb-scope option").allTextContents();
  check(opts.length === 1 && opts[0].startsWith("Riverside Elementary"), `a principal can only pick their own school (${opts.join(", ")})`);
  await shot(brander, "30-branding-designer", true);
  await axe(brander, "branding designer");
});
await step("presets and live previews for teacher, student, young student and parent", async () => {
  await brander.click('[data-action="brand-preset"][data-preset="bold"]');
  await brander.locator('[data-action="brand-preset"][data-preset="bold"][aria-pressed="true"]').waitFor();
  for (const [role, name] of [["teacher", "teacher"], ["pupil", "student"], ["young", "young-student"], ["parent", "parent"]]) {
    await brander.click(`[data-action="brand-preview"][data-role="${role}"]`);
    await brander.locator(`[data-action="brand-preview"][data-role="${role}"][aria-pressed="true"]`).waitFor();
    if (role === "young") check(await brander.locator("#eb-preview .eb-pv.young").count() === 1, "young preview");
    await brander.locator("#eb-preview").screenshot({ path: path.join(OUT, `31-preview-${name}.png`) }); shots.push(path.join(OUT, `31-preview-${name}.png`));
  }
});
await step("a low-contrast design is flagged live, with suggested shades, and publishing is blocked", async () => {
  await brander.selectOption("#eb-tile-pick", "");
  await brander.selectOption('[data-eb-tile="bg"]', "accent");
  await brander.selectOption('[data-eb-tile="labelColor"]', "custom");
  const hexBox = brander.locator('[data-eb-tile-hex="labelColor"]');
  await hexBox.fill("#ffffff");
  await brander.locator("#eb-contrast.fail").waitFor();
  check(await brander.locator('#eb-contrast li.error').count() >= 1, "contrast errors listed");
  check(await brander.locator('#eb-contrast [data-action="brand-fix"]').count() >= 1, "suggested shade offered");
  // axe agrees with our math: the intentionally failing preview has color-contrast violations.
  if (AXE && !(await brander.evaluate(() => Boolean(window.axe)))) await injectAxe(brander);
  const pv = !AXE ? 1 : await brander.evaluate(async () => (await window.axe.run(document.querySelector("#eb-preview"), { runOnly: { type: "rule", values: ["color-contrast"] } })).violations.length);
  check(pv >= 1, "axe should see the low-contrast preview");
  await brander.locator("#eb-contrast").scrollIntoViewIfNeeded();
  await shot(brander, "32-contrast-warning", false, { top: false });
  // The rest of the designer stays accessible while showing the warning.
  if (AXE) { const r = await brander.evaluate(async () => (await window.axe.run({ exclude: [["#eb-preview"]] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations); for (const v of r) axeFindings.push({ screen: "designer with contrast warning", id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map(n => ({ target: n.target.join(" ") })) }); console.log(`      axe designer with contrast warning (preview excluded): ${r.length ? r.map(v => v.id).join(", ") : "no violations"}`); }
  const respP = brander.waitForResponse(r => /\/api\/branding\/[^/]+\/publish$/.test(r.url()));
  await brander.click('[data-action="brand-publish"]');
  check((await respP).status() === 422, "server refuses to publish");
  await brander.locator("#eb-contrast [role=alert]").waitFor();
  await shot(brander, "33-publish-blocked", false, { top: false });
});
await step("apply suggested shades, then publish", async () => {
  for (let i = 0; i < 12 && await brander.locator('#eb-contrast li.error [data-action="brand-fix"]').count(); i++) {
    await brander.locator('#eb-contrast li.error [data-action="brand-fix"]').first().click();
    await brander.waitForTimeout(100);
  }
  check(await brander.locator("#eb-contrast.fail").count() === 0, "all text pairs pass after the suggestions");
  await brander.fill("#eb-motto", brandMotto);
  const respP = brander.waitForResponse(r => /\/api\/branding\/[^/]+\/publish$/.test(r.url()));
  await brander.click('[data-action="brand-publish"]');
  check((await respP).status() === 200, "published");
  await brander.locator("#eb-status").getByText("is live").waitFor();
  await shot(brander, "34-published-designer", true);
  await axe(brander, "branding designer after publish");
});
for (const [sub, name, sel] of [["demo-teacher", "teacher", ".eb-banner"], ["demo-student", "student", ".eb-banner"], ["demo-student-young", "young-student", ".api-young .eb-banner.young"], ["demo-parent", "parent", ".eb-banner"]]) {
  await step(`published branding as ${name}: header, home banner, tiles`, async () => {
    const p = await newPage();
    await signIn(p, sub);
    await p.locator(`#eduos-api-content ${sel}`).waitFor();
    if (name !== "young-student") await waitText(p, brandMotto);
    check(await p.locator("#eduos-brand-chip").getByText("Riverside Elementary").count() === 1, "header shows the school");
    check(await p.locator("#eduos-api-content .eb-branded").count() >= 1, "branded tiles");
    check(await p.evaluate(() => /icon-32\.png/.test(document.querySelector('link[rel="icon"][data-eduos-brand]')?.href || "")), "per-school favicon");
    check(await p.evaluate(() => /manifest\.webmanifest/.test(document.querySelector('link[rel="manifest"][data-eduos-brand]')?.href || "")), "per-school manifest");
    await shot(p, `35-published-${name}-home`, true);
    await axe(p, `published branding ${name} home`);
    if (name === "student") {
      await p.click("#eduos-api-contrast");
      await p.locator('#eduos-api-contrast[aria-pressed="true"]').waitFor();
      check(await p.evaluate(() => document.documentElement.dataset.eduosTheme) === "high_contrast", "high-contrast theme");
      await shot(p, "36-student-high-contrast", true);
      await axe(p, "student high contrast");
      await p.reload(); await p.locator('#eduos-api-contrast[aria-pressed="true"]').waitFor({ timeout: 15000 });
      await p.click("#eduos-api-contrast"); await p.locator('#eduos-api-contrast[aria-pressed="false"]').waitFor();
    }
    if (name === "young-student") await mobile(p, "35m-published-young-student-home-mobile");
    await p.context().close();
  });
}
await step("sign-in landing shows the school's public branding", async () => {
  const p = await newPage();
  await p.goto(`${BASE}/?school=${DISTRICT_ID}.${RIVERSIDE}`);
  await p.locator("#eduos-brand-landing").getByText("Riverside Elementary").waitFor({ timeout: 15000 });
  check(await p.evaluate(() => /icon-32\.png/.test(document.querySelector('link[rel="icon"][data-eduos-brand]')?.href || "")), "landing favicon");
  await shot(p, "37-signin-landing-branded");
  await axe(p, "branded sign-in landing");
  await p.context().close();
});
await step("restore the seeded design from history and publish it", async () => {
  await brander.reload(); await brander.waitForFunction(() => /Server records loaded/.test(document.getElementById("eduos-api-state")?.textContent || ""), null, { timeout: 15000 });
  await tab(brander, "branding"); await brander.locator("[data-brand-designer]").waitFor();
  await brander.click('[data-action="brand-restore"][data-version="1"]');
  await brander.locator("#eb-status").getByText("from version 1").waitFor();
  await shot(brander, "38-restore-into-draft", true);
  const respP = brander.waitForResponse(r => /\/api\/branding\/[^/]+\/publish$/.test(r.url()));
  await brander.click('[data-action="brand-publish"]');
  check((await respP).status() === 200, "restored version published");
  await brander.context().close();
});
await step("no uncaught page errors", async () => { check(pageErrors.length === 0, pageErrors.join("; ")); });
await step("nothing blocked by the Content Security Policy", async () => { check(cspViolations.length === 0, cspViolations.join("; ")); });
await step("axe-core: no WCAG 2.2 A/AA violations on any scanned screen", async () => {
  if (!AXE) { console.log("      (skipped: axe-core not found; npm --prefix ~/tools/pw i axe-core)"); return; }
  fs.writeFileSync(path.join(OUT, "axe-report.json"), JSON.stringify(axeFindings, null, 2));
  check(axeFindings.length === 0, `${axeFindings.length} violation group(s): ${axeFindings.map(f => `${f.screen}:${f.id}`).join(", ")}`);
});

await browser.close();
const failed = results.filter(r => !r[0]).length;
console.log(`\n${results.length - failed}/${results.length} browser steps passed; screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
