#!/usr/bin/env node
// EduOS 32.6.0 learning core + EDAL phone smoke test (development only).
// Student: courses, standards, explainable mastery, a lesson with real
// public-domain primary sources, a timed quiz with extra time and on-device
// read-aloud, results. Teacher: courses, gradebook, quiz review and rubric
// grading. Family: Grades & progress, mastery "why", the EDAL record check.
// Leaders: approvals, the records ledger verify and a checkpoint.
// axe-core on every screen.
//
//   EDUOS_BASE                    default https://localhost:8443
//   EDUOS_LEARNING_SCREENSHOT_DIR default ./artifacts/screens/32.6
//   EDUOS_AXE_PATH / EDUOS_PLAYWRIGHT_DIR / CHROME_PATH as in dev/browser-smoke.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { USERS } from "./demo-fixture.js";

if (process.env.NODE_ENV === "production") { console.error("learning-smoke is a development tool"); process.exit(2); }
const BASE = (process.env.EDUOS_BASE || "https://localhost:8443").replace(/\/$/, "");
const OUT = path.resolve(process.env.EDUOS_LEARNING_SCREENSHOT_DIR || "artifacts/screens/32.6");
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
const dialog = p => p.locator("dialog[open]");
const section = (p, label) => p.locator(`section[aria-label="${label}"]`).first();
async function click(page, role, name, opts = {}) { await page.getByRole(role, { name, ...opts }).first().click(); await loaded(page); await page.waitForTimeout(250); }

// ---------- student ----------
const student = await phone();
await step("student: home courses card and Courses tab", async () => {
  await signIn(student, USERS.pupil.sub);
  await waitText(student, "My courses");
  await tabTo(student, "Courses");
  await waitText(student, "Grade 4 Math: Fractions");
  await waitText(student, "standards mastered");
  check(!(await student.getByText("Grade 3 Math", { exact: true }).count()), "archived course hidden");
  await shot(student, "01-student-courses");
  await axe(student, "student courses");
});
await step("student: course with standards, units and quizzes", async () => {
  await click(student, "button", "Open course", { exact: true });
  await waitText(student, "4.NF.A.1");
  await waitText(student, "Assignments & quizzes");
  await shot(student, "02-student-course");
  await axe(student, "student course");
});
await step("student: explainable mastery", async () => {
  await click(student, "button", /How is this calculated\? \(4\.NF\.A\.1\)/);
  await waitText(student, "How it's calculated");
  await waitText(student, "newer work counting more");
  await waitText(student, "no predictions or rankings");
  await shot(student, "03-student-mastery", { full: true });
  await axe(student, "student mastery");
});
await step("student: lesson with Library of Congress primary sources", async () => {
  await tabTo(student, "Courses");
  await student.locator('section[aria-label="Grade 4 Reading: Primary Sources"]').getByRole("button", { name: "Open course" }).click(); await loaded(student);
  await click(student, "button", /Open lesson: The first flight/);
  await waitText(student, "Primary sources");
  const links = await student.locator("article.source a").evaluateAll(as => as.map(a => a.href));
  check(links.length === 2 && links.every(h => /^https:\/\/www\.loc\.gov\//.test(h)), `LoC links: ${links.join(",")}`);
  await waitText(student, "Public domain");
  await waitText(student, "Think about it");
  await shot(student, "04-student-lesson-sources");
  await student.locator("article.source").first().scrollIntoViewIfNeeded();
  await shot(student, "05-student-primary-source");
  await axe(student, "student lesson");
});
await step("student: National Archives source on the Declaration lesson", async () => {
  await click(student, "button", "‹ Grade 4 Reading: Primary Sources");
  await click(student, "button", /Open lesson: Words that started a country/);
  const href = await student.locator("article.source a").first().getAttribute("href");
  check(href === "https://www.archives.gov/founding-docs/declaration-transcript", href);
  await axe(student, "student lesson archives");
});
await step("student: quiz with extra time, read-aloud, save and submit", async () => {
  await tabTo(student, "Courses");
  await click(student, "button", "Open course", { exact: true });
  await click(student, "button", "Open quiz: Quiz: Comparing fractions");
  await waitText(student, "Before you start");
  await waitText(student, "extra time");
  await shot(student, "06-student-quiz-start");
  await axe(student, "student quiz start");
  const start = student.getByRole("button", { name: /Start quiz|Resume quiz/ });
  if (await start.count()) {
    await start.click(); await loaded(student);
    await student.getByRole("timer").waitFor();
    check(/left \(\+25% time\)/.test(await student.getByRole("timer").textContent()), "timer shows the extra time");
    check(await student.getByRole("button", { name: /Read aloud: question 1/ }).count() === 1, "read-aloud button");
    check(!(await student.locator("main").textContent()).includes("Answer:"), "no answer keys while taking the quiz");
    await shot(student, "07-student-quiz-taking");
    await axe(student, "student quiz taking");
    await section(student, "Question 1").getByLabel("1/2", { exact: true }).check();
    await section(student, "Question 2").getByLabel("<", { exact: true }).check();
    await section(student, "Question 3").getByLabel(/Your answer/).fill("4");
    await section(student, "Question 4").getByLabel(/Your answer/).fill("1/2");
    await student.waitForTimeout(300);
    await student.getByRole("button", { name: "Submit quiz" }).click();
    await dialog(student).getByRole("button", { name: "Submit" }).click();
    await loaded(student); await student.waitForTimeout(400);
  } else {
    await click(student, "button", /See results of attempt 1/);
  }
  await waitText(student, "Score: 4 / 4");
  await waitText(student, "Answer:"); // single-attempt quiz: keys shown after the last attempt
  await shot(student, "08-student-quiz-result");
  await axe(student, "student quiz result");
});

// ---------- teacher ----------
const teacher = await phone();
await step("teacher: courses with review counts, roster reachable", async () => {
  await signIn(teacher, USERS.teacher.sub);
  await tabTo(teacher, "Courses");
  await waitText(teacher, "Grade 4 Math: Fractions");
  check(await teacher.getByRole("button", { name: "My roster" }).count() === 1, "roster button");
  await shot(teacher, "09-teacher-courses");
  await axe(teacher, "teacher courses");
});
await step("teacher: gradebook (scrollable table, missing work flagged)", async () => {
  await teacher.locator('section[aria-label="Grade 4 Math: Fractions"]').getByRole("button", { name: "Gradebook" }).click(); await loaded(teacher);
  await waitText(teacher, "Gradebook · Grade 4 Math: Fractions");
  await teacher.getByRole("region", { name: "Gradebook table" }).waitFor();
  await waitText(teacher, "ungraded work never counts as zero");
  await shot(teacher, "10-teacher-gradebook");
  await axe(teacher, "teacher gradebook");
});
await step("teacher: course accommodations", async () => {
  await click(teacher, "button", "‹ Courses");
  await teacher.locator('section[aria-label="Grade 4 Math: Fractions"]').getByRole("button", { name: "Open course" }).click(); await loaded(teacher);
  await waitText(teacher, "Accommodations");
  check(await teacher.getByLabel(/Extra time for Noah/).inputValue() === "50", "Noah +50%");
  await section(teacher, "Accommodations").scrollIntoViewIfNeeded();
  await shot(teacher, "11-teacher-accommodations");
  await axe(teacher, "teacher course + accommodations");
});
await step("teacher: grading queue with quiz review", async () => {
  await tabTo(teacher, "Grading");
  await waitText(teacher, "Quizzes to review");
  await waitText(teacher, "Rubric grading");
  await shot(teacher, "12-teacher-grading-queues");
  await axe(teacher, "teacher grading queues");
  const rev = teacher.getByRole("button", { name: /^Review Ava Morgan/ });
  if (await rev.count()) {
    await rev.first().click(); await loaded(teacher);
    await waitText(teacher, "Answer given");
    await shot(teacher, "13-teacher-quiz-review", { full: true });
    await axe(teacher, "teacher quiz review");
    for (const f of await teacher.locator('input[id^="pts-"]').all()) await f.fill("1");
    await teacher.locator('textarea[id^="cm-"]').first().fill("Good use of the photograph and the telegram.");
    await teacher.getByRole("button", { name: "Return to learner" }).click(); await loaded(teacher);
    await waitText(teacher, "Grading queue");
  } else console.log("      (Ava's source quiz was already reviewed on an earlier run)");
});
await step("teacher: rubric grading", async () => {
  const g = teacher.getByRole("button", { name: /^Grade (Liam|Noah|Sofia)/ });
  if (!(await g.count())) { console.log("      (all rubric work already graded)"); return; }
  await g.first().click(); await loaded(teacher);
  await waitText(teacher, "Return with rubric");
  for (const fs of await teacher.locator("form fieldset.choices").all()) await fs.locator("label.choice").nth(2).click();
  await teacher.getByLabel("Feedback for the learner and family").fill("Clear models. Label each part of the whole next time.");
  await shot(teacher, "14-teacher-rubric", { full: true });
  await axe(teacher, "teacher rubric");
  await teacher.getByRole("button", { name: "Return with rubric" }).click(); await loaded(teacher);
  await waitText(teacher, "Grading queue");
});

// ---------- family ----------
const parent = await phone();
await step("family: Grades & progress (own child only)", async () => {
  await signIn(parent, USERS.parent.sub);
  await waitText(parent, "Ava Morgan");
  await click(parent, "button", "Grades & progress: Ava Morgan");
  await waitText(parent, "Grades & progress · Ava");
  await waitText(parent, "Final grades & credentials");
  await waitText(parent, "Completed Grade 3 Math");
  const body = await parent.locator("main").textContent();
  check(!/Noah|Liam|Sofia/.test(body), "no other learners");
  await shot(parent, "15-family-progress");
  await axe(parent, "family progress");
  await parent.locator('section[aria-label="Final grades and credentials"]').scrollIntoViewIfNeeded();
  await shot(parent, "16-family-final-grades");
});
await step("family: mastery why + EDAL record check", async () => {
  await click(parent, "button", /^Why\? 4\.NF\.A\.1/);
  await waitText(parent, "How it's calculated");
  await axe(parent, "family mastery");
  await click(parent, "button", "‹ Back");
  await click(parent, "button", /Check record: Grade 3 Math/);
  await waitText(parent, "This record checks out");
  await waitText(parent, "not a blockchain");
  await shot(parent, "17-family-record-check");
  await axe(parent, "family record check");
});

// ---------- leaders ----------
const principal = await phone();
await step("principal: Learning card, approvals queue", async () => {
  await signIn(principal, USERS.principal.sub);
  await waitText(principal, "Lessons and sources waiting for approval");
  await section(principal, "Learning").scrollIntoViewIfNeeded();
  await shot(principal, "18-principal-learning-card");
  await axe(principal, "principal overview");
  await click(principal, "button", "Approvals");
  await waitText(principal, "Lessons for Christie");
  await waitText(principal, "Library of Congress or the National Archives");
  await shot(principal, "19-principal-approvals");
  await axe(principal, "principal approvals");
});
await step("principal: records ledger verified + checkpoint", async () => {
  await click(principal, "button", "‹ School");
  await click(principal, "button", "Records ledger");
  await waitText(principal, "Ledger verified");
  await waitText(principal, "It is not a blockchain");
  await shot(principal, "20-principal-ledger");
  await axe(principal, "principal ledger");
  await principal.getByRole("button", { name: "Save checkpoint" }).click();
  await dialog(principal).getByRole("button", { name: "Save" }).click();
  await principal.locator("pre.mono").filter({ hasText: "headHash" }).waitFor();
  await shot(principal, "21-principal-checkpoint", { full: true });
  await axe(principal, "principal checkpoint");
});
const supt = await phone();
await step("superintendent: district ledger", async () => {
  await signIn(supt, USERS.superintendent.sub);
  await click(supt, "button", "Records ledger");
  await waitText(supt, "Ledger verified");
  await waitText(supt, "final grades");
  await axe(supt, "superintendent ledger");
});

for (const p of [student, teacher, parent, principal, supt]) await p.context().close().catch(() => {});
await step("no uncaught page errors", async () => { check(pageErrors.length === 0, pageErrors.join("; ")); });
await step("axe-core: no WCAG 2.1 A/AA violations on any learning screen", async () => {
  if (!AXE) { console.log("      (skipped: axe-core not found)"); return; }
  fs.writeFileSync(path.join(OUT, "axe-report.json"), JSON.stringify(axeFindings, null, 2));
  check(axeFindings.length === 0, `${axeFindings.length} violation group(s): ${axeFindings.map(f => `${f.screen}:${f.id}`).join(", ")}`);
});
await browser.close();
const failed = results.filter(r => !r[0]).length;
console.log(`\n${results.length - failed}/${results.length} learning phone steps passed; ${shots.length} screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
