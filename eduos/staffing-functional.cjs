// Functional test: principal hires (cap 100), teacher enrolls (cap 50/section),
// each section updates live, and persona gating holds.
const { chromium } = require("playwright");
const URL = "http://127.0.0.1:8099/index.html";
const results = [];
const check = (n, cond, d = "") => { results.push(cond); console.log(`${cond ? "PASS" : "FAIL"}  ${n}${d ? "  (" + d + ")" : ""}`); };

(async () => {
  const b = await chromium.launch();
  const pg = await b.newPage();
  const errs = [];
  pg.on("pageerror", e => errs.push(e.message));
  await pg.goto(URL, { waitUntil: "load" });
  // clean slate for staffing store
  await pg.evaluate(() => { try { localStorage.removeItem("eduos_staffing_v1"); } catch (e) {} });
  await pg.reload({ waitUntil: "load" });

  const tCount = () => pg.evaluate(() => eval("staffing").teachers.length);
  const secCount = id => pg.evaluate(i => { const s = eval("staffing").sections.find(x => x.id === i); return s ? s.pupils.length : -1; }, id);

  // ---------- PRINCIPAL: hire ----------
  await pg.evaluate(() => window.setPersona("principal"));
  await pg.evaluate(() => window.go("staffing"));
  const seedT = await tCount();
  check("principal lands on Staffing with seed teachers", seedT === 3, "teachers=" + seedT);
  await pg.fill("#stf-name", "Alex Morgan");
  await pg.fill("#stf-subject", "History");
  await pg.click('button[onclick="hireTeacher()"]');
  await pg.waitForTimeout(40);
  check("hiring adds a teacher", (await tCount()) === seedT + 1, "teachers=" + (await tCount()));
  check("hired teacher appears in table", await pg.evaluate(() => document.getElementById("content").innerText.includes("Alex Morgan")));

  // cap at 100: fill to 100 then attempt one more
  await pg.evaluate(() => { const s = eval("staffing"); while (s.teachers.length < 100) s.teachers.push({ id: "TCH-f" + s.teachers.length, name: "Filler " + s.teachers.length, subject: "X", grade: "Grade 9", schoolId: "SCH-001", hiredAt: "2026-08-18" }); saveStaffing(); window.go("staffing"); });
  await pg.waitForTimeout(30);
  check("at 100 the hire form is replaced by a cap notice", await pg.evaluate(() => document.getElementById("content").innerText.includes("Hiring cap reached")));
  const blocked = await pg.evaluate(() => { const before = eval("staffing").teachers.length; window.hireTeacher(); return { before, after: eval("staffing").teachers.length }; });
  check("hiring blocked at 100 (cannot exceed cap)", blocked.before === 100 && blocked.after === 100, blocked.before + "->" + blocked.after);

  // ---------- TEACHER: enroll ----------
  await pg.evaluate(() => { try { localStorage.removeItem("eduos_staffing_v1"); } catch (e) {} });
  await pg.reload({ waitUntil: "load" });
  await pg.evaluate(() => window.setPersona("teacher"));
  await pg.evaluate(() => window.go("staffing"));
  const sec0 = await secCount("SEC-0001");
  check("teacher sees section SEC-0001 starting empty", sec0 === 0, "pupils=" + sec0);
  await pg.selectOption("#enr-section", "SEC-0001");
  await pg.waitForTimeout(20);
  await pg.fill("#enr-pupil", "Sam Rivera");
  await pg.click('button[onclick="enrollPupil()"]');
  await pg.waitForTimeout(40);
  check("enrolling a pupil updates the section to 1", (await secCount("SEC-0001")) === 1, "pupils=" + (await secCount("SEC-0001")));
  check("section table reflects 1 / 50 live", await pg.evaluate(() => /1 \/ 50/.test(document.getElementById("content").innerText)));

  // cap at 50
  await pg.evaluate(() => { const sec = eval("staffing").sections.find(s => s.id === "SEC-0001"); while (sec.pupils.length < 50) sec.pupils.push({ id: "PUP-f" + sec.pupils.length, name: "Pupil " + sec.pupils.length, grade: "Grade 9", enrolledAt: "2026-09-01" }); saveStaffing(); window.__enrSection = "SEC-0001"; window.go("staffing"); });
  await pg.waitForTimeout(30);
  check("at 50 the enroll form shows Class full", await pg.evaluate(() => document.getElementById("content").innerText.includes("Class full")));
  const encap = await pg.evaluate(() => { window.__enrSection = "SEC-0001"; const sec = eval("staffing").sections.find(s => s.id === "SEC-0001"); const before = sec.pupils.length; window.enrollPupil(); return { before, after: sec.pupils.length }; });
  check("enrollment blocked at 50 (cannot exceed cap)", encap.before === 50 && encap.after === 50, encap.before + "->" + encap.after);

  // ---------- persona gating ----------
  const gate1 = await pg.evaluate(() => { const before = eval("staffing").teachers.length; window.hireTeacher(); return before === eval("staffing").teachers.length; });
  check("teacher cannot hire (principal-only action blocked)", gate1);
  await pg.evaluate(() => window.setPersona("principal"));
  const gate2 = await pg.evaluate(() => { const sec = eval("staffing").sections.find(s => s.id === "SEC-0002"); const before = sec.pupils.length; window.__enrSection = "SEC-0002"; window.enrollPupil(); return before === sec.pupils.length; });
  check("principal cannot enroll pupils (teacher-only action blocked)", gate2);

  check("no uncaught JS errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  await b.close();
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} functional checks passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error("HARNESS ERROR", e); process.exit(2); });
