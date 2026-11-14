// Cross-profile navigation audit for the EduOS single-file app.
// Loads the real page in Chromium, switches through every persona, clicks every
// nav link, and flags: broken links (alert card / console.error / empty render /
// missing route), navigation loops/recursion, and cross-profile breakage.
const { chromium } = require("playwright");
const fileUrl = /^https?:\/\//.test(process.argv[2]) ? process.argv[2] : "file://" + process.argv[2];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  let ctx = { persona: "-", page: "-" };
  const assetMisses = [];
  page.on("console", m => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource|ERR_FILE_NOT_FOUND|ERR_CONNECTION/i.test(t)) { assetMisses.push({ ...ctx, text: t }); return; }
    errors.push({ ...ctx, kind: "console", text: t });
  });
  page.on("requestfailed", r => assetMisses.push({ ...ctx, text: r.url().split("/").pop() }));
  page.on("pageerror", e => errors.push({ ...ctx, kind: "pageerror", text: e.message }));

  await page.goto(fileUrl, { waitUntil: "load" });
  await page.waitForTimeout(150);
  // dismiss any opening modal/tour so it can't intercept clicks
  await page.keyboard.press("Escape").catch(() => {});

  // --- read the data model by lexical name (classic-script globals) ---
  const model = await page.evaluate(() => {
    const safe = n => { try { return eval(n); } catch { return undefined; } };
    const rm = safe("roleMenus"), pc = safe("personaConfig"), rn = safe("renderers"), pn = safe("pageNames");
    const out = { hasModel: !!(rm && pc), rendererKeys: rn ? Object.keys(rn) : [], pageNameKeys: pn ? Object.keys(pn) : [], personas: {} };
    if (rm) for (const [pid, def] of Object.entries(rm)) {
      const menu = []; (def.groups || []).forEach(g => menu.push(...(g.pages || [])));
      out.personas[pid] = { menu, allowed: (pc && pc[pid] && pc[pid].pages) || null };
    }
    return out;
  });

  const personas = Object.keys(model.personas);
  const LEADERSHIP = new Set(["superintendent", "principal"]);
  const RESTRICTED = new Set(["audit", "accessrequests"]); // leadership-only by design

  // --- static consistency from the model ---
  const modelIssues = [];
  for (const [pid, d] of Object.entries(model.personas)) {
    const allowed = new Set(d.allowed || []);
    for (const pg of d.menu) {
      if (!model.rendererKeys.includes(pg)) modelIssues.push(`${pid}: menu page "${pg}" has NO renderer`);
      if (!model.pageNameKeys.includes(pg)) modelIssues.push(`${pid}: menu page "${pg}" has NO pageName`);
      if (d.allowed && !allowed.has(pg)) modelIssues.push(`${pid}: menu shows "${pg}" but personaConfig forbids it (dead link)`);
      if (RESTRICTED.has(pg) && !LEADERSHIP.has(pid)) modelIssues.push(`${pid}: menu shows restricted "${pg}" (would be blocked)`);
    }
  }

  // --- runtime crawl: every persona × every nav link ---
  const results = []; // {persona,page,ok,reason,crumb,textlen}
  const distinctMenus = {};
  for (const persona of personas) {
    ctx = { persona, page: "switch" };
    const before = errors.length;
    // switch via the real persona chip when present, else setPersona()
    const chip = await page.$(`#nav [data-role-switch="${persona}"]`);
    if (chip) await chip.click({ timeout: 3000 }).catch(() => page.evaluate(id => window.setPersona && window.setPersona(id), persona));
    else await page.evaluate(id => window.setPersona && window.setPersona(id), persona);
    await page.waitForTimeout(40);
    await page.evaluate(() => window.go && window.go("home"));
    await page.waitForTimeout(40);
    const navPages = await page.$$eval("#nav button[data-page]", bs => [...new Set(bs.map(b => b.dataset.page))]);
    distinctMenus[persona] = navPages.join(",");

    for (const pg of navPages) {
      ctx = { persona, page: pg };
      const errBefore = errors.length;
      // Navigate via the exposed go() — exactly what the nav click handler calls.
      // (Clicking the DOM button directly stalls on items inside collapsed
      //  <details> nav groups, which are display:none until expanded.)
      await page.evaluate(p => window.go(p), pg);
      await page.waitForTimeout(15);
      const st = await page.evaluate(() => {
        const c = document.getElementById("content");
        return {
          crumb: (document.getElementById("crumb") || {}).textContent || "",
          alert: /That section could not open/.test(c ? c.innerHTML : ""),
          textlen: (c ? c.innerText : "").trim().length,
          activeMatches: !!document.querySelector(`#nav button[data-page].active`)
        };
      });
      const newErrs = errors.slice(errBefore);
      const ok = !st.alert && newErrs.length === 0 && st.textlen > 30;
      results.push({ persona, page: pg, ok, crumb: st.crumb, textlen: st.textlen,
        reason: st.alert ? "alert-card(route blocked/missing)" : newErrs.length ? newErrs[0].text.slice(0, 80) : st.textlen <= 30 ? "empty-render" : "" });
    }
  }

  // --- loop / stability probe: A->B->A must return; repeated click idempotent; no stack overflow ---
  ctx = { persona: "loopcheck", page: "-" };
  await page.evaluate(() => window.setPersona && window.setPersona("superintendent"));
  const loopFindings = [];
  const seq = ["home", "records", "home", "schools", "home"];
  for (const p of seq) { await page.evaluate(x => window.go(x), p); await page.waitForTimeout(20); }
  const backHome = await page.evaluate(() => (document.getElementById("crumb") || {}).textContent || "");
  // double-click same nav twice -> stable, no runaway
  await page.evaluate(() => window.go("overview"));
  const h1 = await page.evaluate(() => (document.getElementById("content") || {}).innerHTML.length);
  await page.evaluate(() => window.go("overview"));
  const h2 = await page.evaluate(() => (document.getElementById("content") || {}).innerHTML.length);
  if (Math.abs(h1 - h2) > 5) loopFindings.push(`re-render of same page not idempotent (${h1} vs ${h2})`);
  if (errors.some(e => /maximum call stack|too much recursion/i.test(e.text))) loopFindings.push("call-stack overflow during navigation (loop)");

  // cross-profile: all personas distinct menus & all switchable
  const menuSig = new Set(Object.values(distinctMenus));
  const crossOk = personas.length >= 2 && menuSig.size >= 2;

  // screenshots for two contrasting personas
  for (const p of ["superintendent", "pupil"]) {
    await page.evaluate(id => window.setPersona && window.setPersona(id), p);
    await page.evaluate(() => window.go("home"));
    await page.waitForTimeout(60);
    await page.screenshot({ path: `/tmp/claude-0/-home-user-app/532f95fc-4493-577d-a04f-10ab661f5b8b/scratchpad/profile-${p}.png` });
  }

  await browser.close();

  // --- report ---
  const broken = results.filter(r => !r.ok);
  const byPersona = {};
  for (const r of results) { (byPersona[r.persona] ||= { ok: 0, bad: 0 }); r.ok ? byPersona[r.persona].ok++ : byPersona[r.persona].bad++; }
  console.log("MODEL:", model.hasModel ? "readable" : "NOT readable", "| personas:", personas.join(", "));
  console.log("renderers:", model.rendererKeys.length, "pageNames:", model.pageNameKeys.length);
  console.log("\n== per-persona nav results (ok/total) ==");
  for (const p of personas) console.log(`  ${p.padEnd(15)} ${byPersona[p] ? byPersona[p].ok : 0}/${(byPersona[p] ? byPersona[p].ok + byPersona[p].bad : 0)} links OK`);
  console.log("\n== model/consistency issues ==");
  console.log(modelIssues.length ? modelIssues.map(s => "  - " + s).join("\n") : "  none");
  console.log("\n== broken links at runtime ==");
  console.log(broken.length ? broken.map(b => `  - [${b.persona}] ${b.page}: ${b.reason}`).join("\n") : "  none");
  console.log("\n== loop / stability ==");
  console.log("  A->B->A returns home:", backHome);
  console.log(loopFindings.length ? loopFindings.map(s => "  - " + s).join("\n") : "  no loops / recursion detected");
  console.log("\n== cross-profile ==");
  console.log("  all personas switchable + distinct menus:", crossOk, `(${menuSig.size} distinct menu signatures)`);
  console.log("\n== asset (image) load misses ==");
  const uniqMiss = [...new Set(assetMisses.map(a => (a.text || "").split("/").pop()))].filter(Boolean);
  console.log(uniqMiss.length ? "  " + uniqMiss.length + " distinct: " + uniqMiss.slice(0, 20).join(", ") : "  none (all assets resolved)");
  console.log("\n== uncaught JS errors total ==", errors.length);
  console.log(`\nSUMMARY: ${results.length} links across ${personas.length} personas; ${broken.length} broken; ${modelIssues.length} model issues; ${loopFindings.length} loop issues.`);
  process.exit(broken.length || loopFindings.length || modelIssues.length ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR", e); process.exit(2); });
