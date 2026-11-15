// Browser smoke test for the web app at /app/: loads the real index.html and
// app.js in headless Chrome (driven over the DevTools protocol with Node's own
// WebSocket, no extra dependencies) against a small mock API, signed in as each
// role, and checks every tab renders without an uncaught error.
//
// 37.4.0 shipped an app.js that threw while loading (an undefined view), so
// /app/ never got past "Loading EduOS..." for anyone; nothing in CI opened it.
//
// Skips when Chrome isn't installed, unless EDUOS_REQUIRE_BROWSER=1 (set in CI).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const APP_DIR = new URL("../../public/app/", import.meta.url);
const ui = fs.readFileSync(new URL("app.js", APP_DIR), "utf8");
const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find(p => p && fs.existsSync(p));
const required = process.env.EDUOS_REQUIRE_BROWSER === "1";

// Role -> tab ids, read from ROLE_TABS so new tabs are covered automatically.
const roleTabs = (() => {
  const block = ui.slice(ui.indexOf("const ROLE_TABS"), ui.indexOf("};", ui.indexOf("const ROLE_TABS")));
  const out = {};
  for (const m of block.matchAll(/^\s*(\w+):\s*\[(.*)\],?\s*$/gm)) out[m[1]] = [...m[2].matchAll(/\["(\w+)", "/g)].map(x => x[1]);
  return out;
})();

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function mockApi(role, pathname) {
  const now = new Date().toISOString();
  switch (pathname) {
    case "/api/me": return { userId: "u1", displayName: "Smoke Test", role, districtId: "d1", schoolId: "s1", memberships: [] };
    case "/api/session": return { csrfToken: "smoke" };
    case "/api/safety/status": return { data: { incidents: [], canInitiate: false, canLead: false } };
    case "/api/home": return { data: { school_name: "Maple", students: 4, absent_today: 1, open_cases: 0, overdue_follow_ups: 0, pending_invitations: 0, schools: 1, urgent_cases: 0, absences_7d: 1 } };
    case "/api/attendance": return { data: [{ id: "e1", event_date: today(), status: "absent", display_name: "Bob B" }] };
    case "/api/school-operations/command-center": return { data: { summary: [], work: [{ id: "w1", domain: "facilities", kind: "repair", status: "open", priority: "high", summary: "Gym door", escalation_level: 0, created_at: now }] } };
    case "/api/staff-management": return { data: { absences: [], shifts: [], coverage: [], staffing: [] } };
    case "/api/transport/today": return { data: { routes: [], riders: [] } };
    case "/api/christie/path": return { data: { learner: { grade: "4" }, skills: [], activeSessionId: null } };
    case "/api/christie/copilot": return { data: { suggestions: [], note: "", bySkill: [] } };
    case "/api/learning/courses": return { data: { courses: [] } };
    case "/api/pickup/family": return { data: { children: [] } };
    case "/api/pickup/queue": return { data: { incident: null, waiting: [], released: [], blocked: 0, denied: 0, earlyDismissals: [] } };
    case "/api/learning/review": return { data: { attempts: [] } };
    case "/api/learning/progress": return { data: { children: [] } };
    case "/api/notifications": return { data: { unread: 0, items: [] } };
    default:
      if (pathname.startsWith("/api/node/")) return null; // no local node: 404
      return { data: [] };
  }
}

function startServer() {
  const state = { role: "parent" };
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://x");
    if (pathname.startsWith("/api/")) {
      const body = req.method === "GET" ? mockApi(state.role, pathname) : { data: {} };
      res.writeHead(body ? (req.method === "GET" ? 200 : 201) : 404, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(body ?? { error: "not_found" }));
    }
    const rel = pathname.replace(/^\/app\/?/, "") || "index.html";
    const file = new URL(rel, APP_DIR);
    if (!pathname.startsWith("/app/") || !file.href.startsWith(APP_DIR.href) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file.pathname)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  server.unref(); // never keep the test process alive
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })));
}

// Chrome is always killed, even when it starts slowly or the test fails early:
// a live child process would keep `node --test` (and the CI job) running forever.
async function startChrome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eduos-smoke-"));
  const proc = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${dir}`, "about:blank"], { stdio: "ignore" });
  proc.unref();
  const close = () => { try { proc.kill("SIGKILL"); } catch {} fs.rmSync(dir, { recursive: true, force: true }); };
  t.after(close);
  process.once("exit", close);
  const portFile = path.join(dir, "DevToolsActivePort");
  for (let i = 0; i < 300 && !fs.existsSync(portFile) && proc.exitCode === null; i++) await sleep(100);
  assert.ok(fs.existsSync(portFile), `Chrome didn't start within 30 s (exit code ${proc.exitCode})`);
  return { port: Number(fs.readFileSync(portFile, "utf8").split("\n")[0]) };
}

const withTimeout = (promise, ms, what) => Promise.race([promise, sleep(ms, undefined, { ref: false }).then(() => { throw new Error(`timed out: ${what}`); })]);

class Page {
  static async open(chromePort) {
    const target = await withTimeout(fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: "PUT" }).then(r => r.json()), 15000, "open a tab");
    const page = new Page(new WebSocket(target.webSocketDebuggerUrl));
    await withTimeout(new Promise((resolve, reject) => { page.ws.onopen = resolve; page.ws.onerror = reject; }), 15000, "connect to the tab");
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    return page;
  }
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
      if (msg.method === "Runtime.exceptionThrown") this.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return withTimeout(new Promise(resolve => { this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params })); }), 15000, method);
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  }
  async mainText({ timeout = 10000 } = {}) {
    const end = Date.now() + timeout;
    let text = "";
    while (Date.now() < end) {
      text = (await this.eval(`document.getElementById("main")?.innerText || ""`)) || "";
      if (this.errors.length || (text.trim() && !/^Loading/.test(text.trim()))) return text;
      await sleep(100);
    }
    return text;
  }
  close() { this.ws.close(); }
}

test("web app boots and every role's tabs render", { skip: !CHROME && !required && "Chrome not installed (set EDUOS_REQUIRE_BROWSER=1 to require it)", timeout: 180000 }, async (t) => {
  assert.ok(CHROME, "EDUOS_REQUIRE_BROWSER=1 but no Chrome found (set CHROME_PATH)");
  assert.ok(Object.keys(roleTabs).length >= 10, "read ROLE_TABS from app.js");
  const { server, state, port } = await startServer();
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const chrome = await startChrome(t);
  // Boot first: a load-time error would otherwise fail every tab the same way.
  {
    const page = await Page.open(chrome.port);
    await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html` });
    const text = (await page.mainText()).trim();
    page.close();
    assert.deepEqual(page.errors, [], "app.js threw while loading, so /app/ never starts");
    assert.doesNotMatch(text, /^Loading/, "/app/ never got past Loading");
  }
  const failures = [];
  for (const [role, tabs] of Object.entries(roleTabs)) {
    for (const tab of tabs) {
      state.role = role;
      const page = await Page.open(chrome.port);
      try {
        await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/${tab}` });
        const text = (await page.mainText()).trim();
        const hash = await page.eval("location.hash");
        const problem = page.errors.length ? `uncaught error: ${page.errors[0].split("\n")[0]}`
          : /^Loading/.test(text) ? "never got past Loading"
          : /Something went wrong/.test(text) ? "the view failed"
          : !text ? "blank"
          : hash !== `#/${tab}` ? `was sent to ${hash}` : null;
        if (problem) failures.push(`${role} #/${tab}: ${problem}`);
      } finally {
        page.close();
      }
    }
  }
  assert.deepEqual(failures, []);
});
