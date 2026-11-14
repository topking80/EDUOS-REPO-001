// Browser test: cross-profile flow (events, badges, feed, transitions, cross-tab sync).
// Serve public/ first, e.g. on :8099, then: node flow-functional.cjs [url]
const { chromium } = require("playwright");
const URL = process.argv[2] || "http://127.0.0.1:8099/index.html";
const results = [];
const check = (n, cond, d = "") => { results.push(!!cond); console.log(`${cond ? "PASS" : "FAIL"}  ${n}${d ? "  (" + d + ")" : ""}`); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  const errs = [];
  pg.on("pageerror", e => errs.push(e.message));
  await pg.goto(URL, { waitUntil: "load" });
  await pg.evaluate(() => { ["eduos_staffing_v1", "eduos_flow_events_v1", "eduos_flow_seen_v1"].forEach(k => localStorage.removeItem(k)); });
  await pg.reload({ waitUntil: "load" });
  const badge = (p, role) => p.evaluate(r => { const b = document.querySelector(`#nav [data-role-switch="${r}"] .flow-badge`); return b ? b.textContent : ""; }, role);
  const events = p => p.evaluate(() => eval("flowEvents").map(e => e.type));

  // 1. principal hires -> event raised, other profiles badged
  await pg.evaluate(() => { window.setPersona("principal"); window.go("staffing"); });
  await pg.fill("#stf-name", "Alex Morgan");
  await pg.fill("#stf-subject", "History");
  await pg.click('button[onclick="hireTeacher()"]');
  await pg.waitForTimeout(60);
  check("hiring raises a teacher.hired flow event", (await events(pg)).join() === "teacher.hired", (await events(pg)).join());
  check("superintendent and teacher switches show an unread badge", (await badge(pg, "superintendent")) === "1" && (await badge(pg, "teacher")) === "1");
  check("profiles outside the audience are not badged", (await badge(pg, "parent")) === "" && (await badge(pg, "pupil")) === "" && (await badge(pg, "principal")) === "");

  // 2. switch profile through the real control -> handoff ribbon + profile transition + feed
  await pg.click('#nav [data-role-switch="teacher"]');
  await pg.waitForTimeout(60);
  const afterSwitch = await pg.evaluate(() => ({
    ribbon: !!document.getElementById("flowRibbon"), ribbonText: (document.getElementById("flowRibbon") || {}).textContent || "",
    cls: document.getElementById("content").className, feed: (document.getElementById("flowFeed") || {}).innerText || ""
  }));
  check("profile switch shows the handoff ribbon", afterSwitch.ribbon && /Teacher/.test(afterSwitch.ribbonText), afterSwitch.ribbonText);
  check("profile switch plays the profile transition", /flow-persona-in/.test(afterSwitch.cls), afterSwitch.cls);
  check("teacher home feed shows the hire as New", /Teacher hired/.test(afterSwitch.feed) && /New/.test(afterSwitch.feed) && /Alex Morgan/.test(afterSwitch.feed));
  check("visiting the profile clears its badge", (await badge(pg, "teacher")) === "");
  await pg.evaluate(() => window.go("staffing"));
  check("page navigation plays the page transition", /flow-page-in/.test(await pg.evaluate(() => document.getElementById("content").className)));

  // 3. teacher enrolls -> principal, superintendent, family badged; family text has no pupil name
  await pg.selectOption("#enr-section", "SEC-0001");
  await pg.waitForTimeout(30);
  await pg.fill("#enr-pupil", "Sam Rivera");
  await pg.click('button[onclick="enrollPupil()"]');
  await pg.waitForTimeout(60);
  check("enrolling raises pupil.enrolled", (await events(pg)).includes("pupil.enrolled"));
  check("principal, parent and pupil are badged", (await badge(pg, "principal")) === "1" && (await badge(pg, "parent")) === "1" && (await badge(pg, "pupil")) === "1");
  await pg.click('#nav [data-role-switch="parent"]');
  await pg.waitForTimeout(60);
  const parentFeed = await pg.evaluate(() => (document.getElementById("flowFeed") || {}).innerText || "");
  check("parent feed shows the roster update without the pupil's name", /class roster updated/.test(parentFeed) && !/Sam Rivera/.test(parentFeed), parentFeed.slice(0, 90).replace(/\n/g, " "));

  // 4. second tab (another profile) updates live without reload
  const pg2 = await ctx.newPage();
  pg2.on("pageerror", e => errs.push("tab2: " + e.message));
  await pg2.goto(URL, { waitUntil: "load" });
  await pg2.evaluate(() => { window.setPersona("principal"); window.go("staffing"); });
  const before2 = await pg2.evaluate(() => document.getElementById("content").innerText.includes("2 / 50"));
  await pg.evaluate(() => { window.setPersona("teacher"); window.go("staffing"); });
  await pg.selectOption("#enr-section", "SEC-0001");
  await pg.waitForTimeout(30);
  await pg.fill("#enr-pupil", "Mia Chen");
  await pg.click('button[onclick="enrollPupil()"]');
  await pg2.waitForFunction(() => document.getElementById("content").innerText.includes("2 / 50"), null, { timeout: 4000 }).catch(() => {});
  const after2 = await pg2.evaluate(() => ({ live: document.getElementById("content").innerText.includes("2 / 50"), feed: (document.getElementById("flowFeed") || {}).innerText || "" }));
  check("principal's open tab updates the section live (no reload)", !before2 && after2.live);
  check("principal's tab feed receives the event", /Mia Chen enrolled/.test(after2.feed));
  await pg2.close();

  // 5. section.full is raised at capacity
  await pg.evaluate(() => { const s = eval("staffing").sections.find(x => x.id === "SEC-0002"); while (s.pupils.length < 49) s.pupils.push({ id: "PUP-F" + s.pupils.length, name: "Filler " + s.pupils.length, grade: "Grade 10", enrolledAt: "2026-09-01" }); saveStaffing(); window.__enrSection = "SEC-0002"; window.go("staffing"); });
  await pg.fill("#enr-pupil", "Last Seat");
  await pg.click('button[onclick="enrollPupil()"]');
  await pg.waitForTimeout(60);
  check("filling the last seat raises section.full", (await events(pg)).includes("section.full"));

  // 6. hostile names are rendered as text in every feed
  await pg.evaluate(() => { window.setPersona("principal"); window.go("staffing"); });
  await pg.fill("#stf-name", "<img src=x onerror=window.__xss=1>");
  await pg.click('button[onclick="hireTeacher()"]');
  await pg.evaluate(() => { window.setPersona("superintendent"); window.go("home"); window.go("staffing"); });
  await pg.waitForTimeout(120);
  check("event text is escaped (no script execution)", (await pg.evaluate(() => window.__xss)) === undefined);
  check("superintendent staffing view shows the webhook panel", await pg.evaluate(() => !!document.getElementById("flowWebhooks")));

  // 7. reduced motion: no transition classes, no ribbon animation
  const calm = await browser.newContext({ reducedMotion: "reduce" });
  const pg3 = await calm.newPage();
  await pg3.goto(URL, { waitUntil: "load" });
  await pg3.evaluate(() => { window.setPersona("teacher"); window.go("home"); window.go("staffing"); });
  check("reduced-motion preference disables transitions", !/flow-(page|persona)-in/.test(await pg3.evaluate(() => document.getElementById("content").className)));
  await calm.close();

  check("no uncaught JS errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} flow checks passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error("HARNESS ERROR", e); process.exit(2); });
