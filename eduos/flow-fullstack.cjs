// Full-stack browser check: UI -> API bridge -> server -> database -> webhook.
// Needs the API server (:8181, seeded sessions) — see flow-live-check.mjs.
const { chromium } = require("playwright");
const http = require("http");
const BASE = process.argv[2] || "http://127.0.0.1:8181";
const results = []; const check = (n, c, d = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  (" + d + ")" : ""}`); };
(async () => {
  const got = [];
  const receiver = http.createServer((q, r) => { let b = ""; q.on("data", c => b += c); q.on("end", () => { got.push({ event: q.headers["x-eduos-event"], body: b }); r.end("ok"); }); });
  await new Promise(r => receiver.listen(9912, "127.0.0.1", r));
  const browser = await chromium.launch();
  // After sign-in the bridge loads records and then aligns the workspace with the
  // verified role; wait for that to settle before driving the UI.
  const ready = async pg => {
    await pg.waitForFunction(() => window.EduOSApi && window.EduOSApi.actor && /records loaded|records unavailable/i.test((document.getElementById("eduos-api-state") || {}).textContent || ""), null, { timeout: 10000 });
    await pg.waitForTimeout(150);
  };
  const open = async token => {
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "eduos_session", value: token, url: BASE }]);
    const pg = await ctx.newPage(); const csp = [], errs = [];
    pg.on("console", m => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });
    pg.on("pageerror", e => errs.push(e.message));
    await pg.goto(BASE + "/", { waitUntil: "load" });
    await ready(pg);
    return { pg, csp, errs, ctx };
  };

  const t = await open("tok-teachA-0123456789abcdef");
  check("bridge signs the teacher in from the session", (await t.pg.evaluate(() => window.EduOSApi.actor.role)) === "teacher");
  await t.pg.evaluate(() => { localStorage.removeItem("eduos_staffing_v1"); localStorage.removeItem("eduos_flow_events_v1"); });
  await t.pg.reload({ waitUntil: "load" });
  await ready(t.pg);
  await t.pg.evaluate(() => { window.setPersona("teacher"); window.go("staffing"); });
  await t.pg.selectOption("#enr-section", "SEC-0003");
  await t.pg.waitForTimeout(40);
  await t.pg.fill("#enr-pupil", "Full Stack Pupil");
  await t.pg.click('button[onclick="enrollPupil()"]');
  await t.pg.waitForFunction(() => { const e = eval("flowEvents"); return e.length && e[e.length - 1].server !== "local"; }, null, { timeout: 6000 }).catch(() => {});
  check("UI enrollment is recorded on the server through the bridge", (await t.pg.evaluate(() => eval("flowEvents").slice(-1)[0].server)) === "recorded");
  const serverRows = await t.pg.evaluate(async () => (await window.EduOSApi.flowEvents()).data);
  const mine = serverRows.find(r => r.type === "pupil.enrolled" && r.refs.section === "SEC-0003");
  check("server stored references and counters, not the pupil's name", !!mine && mine.counts.enrolled === 1 && !JSON.stringify(serverRows).includes("Full Stack Pupil"));
  check("no CSP violations or JS errors in the teacher session", t.csp.length === 0 && t.errs.length === 0, [...t.csp, ...t.errs].slice(0, 1).join(""));

  const s = await open("tok-supA-0123456789abcdef");
  const made = await s.pg.evaluate(() => window.EduOSApi.createWebhook({ url: "http://127.0.0.1:9912/hook", eventTypes: ["*"] }).then(r => ({ ok: true, secret: r.secret }), e => ({ ok: false, m: e.message })));
  check("superintendent registers a destination through the bridge", made.ok && /^whsec_/.test(made.secret || ""), made.m || "");
  await s.pg.evaluate(() => { window.setPersona("superintendent"); window.go("staffing"); });
  await s.pg.waitForFunction(() => /9912\/hook/.test((document.getElementById("flowWebhookBody") || {}).innerText || ""), null, { timeout: 6000 }).catch(() => {});
  check("webhook panel lists the destination", /127\.0\.0\.1:9912\/hook/.test(await s.pg.evaluate(() => document.getElementById("flowWebhookBody").innerText)));
  check("superintendent feed shows events recorded on the server", /Recorded on the server/.test(await s.pg.evaluate(() => (document.getElementById("flowServerFeed") || {}).innerText || "")));
  await s.pg.click('#flowWebhookBody button[onclick^="flowWebhookTest"]');
  await s.pg.waitForFunction(() => /Test delivered/.test(document.getElementById("toast").textContent), null, { timeout: 8000 }).catch(() => {});
  check("Send test from the UI is delivered and signed", /Test delivered \(HTTP 200\)/.test(await s.pg.evaluate(() => document.getElementById("toast").textContent)) && got.some(g => g.event === "webhook.test"));

  // a second UI enrollment now reaches the external receiver end to end
  await t.pg.fill("#enr-pupil", "Second Pupil");
  await t.pg.click('button[onclick="enrollPupil()"]');
  for (let i = 0; i < 50 && !got.some(g => g.event === "pupil.enrolled"); i++) await new Promise(r => setTimeout(r, 100));
  const hook = got.find(g => g.event === "pupil.enrolled");
  check("UI action -> bridge -> server -> webhook receiver, without names", !!hook && JSON.parse(hook.body).counts.enrolled === 2 && !hook.body.includes("Second Pupil"));
  await s.pg.click('#flowWebhookBody button[onclick^="flowWebhookDisable"]').catch(() => {});
  check("no CSP violations or JS errors in the superintendent session", s.csp.length === 0 && s.errs.length === 0, [...s.csp, ...s.errs].slice(0, 1).join(""));

  await browser.close(); receiver.close();
  const pass = results.filter(Boolean).length; console.log(`\n${pass}/${results.length} full-stack checks passed`); process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error("HARNESS ERROR", e); process.exit(2); });
