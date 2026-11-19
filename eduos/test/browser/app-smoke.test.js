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
import path from "node:path";
import { CHROME, startChrome, Page } from "./cdp.js";
import { METHODS, PROCESSORS } from "../../src/commerce/catalog.js";

const APP_DIR = new URL("../../public/app/", import.meta.url);
const ui = fs.readFileSync(new URL("app.js", APP_DIR), "utf8");

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

function mockApi(role, pathname, failWebhookLoads = false) {
  const now = new Date().toISOString();
  switch (pathname) {
    case "/api/me": return { userId: "u1", displayName: "Smoke Test", role, districtId: "d1", schoolId: "s1", memberships: [] };
    case "/api/session": return { csrfToken: "smoke" };
    case "/api/safety/status": return { data: { incidents: [], canInitiate: false, canLead: false } };
    case "/api/home": return { data: { school_name: "Maple", students: 4, absent_today: 1, open_cases: 0, overdue_follow_ups: 0, pending_invitations: 0, schools: 1, urgent_cases: 0, absences_7d: 1 } };
    case "/api/attendance": return { data: [{ id: "e1", event_date: today(), status: "absent", display_name: "Bob B" }] };
    case "/api/attendance/day": return { data: { date: today(), counts: { present: 3, absent: 1, tardy: 0, excused: 0 }, exceptions: [{ student_id: "s1", status: "absent", display_name: "Bob B" }] } };
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
    case "/api/ai/status": return { data: { provider: "local", budget: { district: { used: 100, cap: 200000 }, you: { used: 50, cap: 20000 } },
      usecases: [{ id: "lesson_draft", label: "Lesson draft", enabled: true, input: { min: 3, max: 500 } }, { id: "ops_brief", label: "Operations brief", enabled: true, input: null }] } };
    case "/api/edison/trends": return { data: { scope: "school", days: 10, k: 5, withheld: 1, briefEnabled: true, schools: [{ label: "School 1", schoolId: "s1", name: "Maple", today: today(), enrolled: 120,
      attendance: [{ date: today(), total: 120, counts: { present: 100, absent: 12, tardy: 8 }, suppressed: [] }, { date: today(), total: null, counts: {}, suppressed: ["present"] }],
      transport: { date: today(), riders: 40, counts: { boarded: 35, no_checkin: 5 }, suppressed: [] } }] } };
    case "/api/ai/policy": return { data: { canEdit: role === "superintendent", provider: "local", usage30d: [{ usecase: "lesson_draft", calls: 4, tokens: 1800 }],
      policy: { enabled_usecases: ["lesson_draft"], daily_token_cap: 200000, user_daily_token_cap: 20000 },
      usecases: [{ id: "lesson_draft", label: "Lesson draft", roles: ["teacher"] }, { id: "ops_brief", label: "Operations brief", roles: ["principal"] }] } };
    case "/api/edge/updates": return { data: { canApprove: ["superintendent", "it_admin"].includes(role),
      policy: { require_approval: true, min_canaries: 2, soak_hours: 24 }, fleet: [{ version: "45.20261110.3.0", cohort: "canary", devices: 2 }],
      releases: [{ id: "r1", version: "45.20261117.3.0", stage: "canary", approved_at: now, approved_by_name: "Supt",
        gate: { ready: false, blockers: ["1 of 2 canaries healthy on it"], soaked: 0, required: 2, soakHours: 24 } },
        { id: "r0", version: "45.20261110.3.0", stage: "promoted", approved_at: now, promoted_at: now, approved_by_name: "Supt", promoted_by_name: "IT" }] } };
    case "/api/integrations/connectors": return { data: { enabled: true, schools: [{ id: "s1", name: "Maple" }], connectors: [
      { id: "c1", kind: "oneroster", name: "District SIS", baseUrl: "https://sis.example.org/ims/oneroster/rostering/v1p2", status: "active", updatedBy: "IT", approvedBy: "Supt", canApprove: false, lastSyncAt: now, lastSyncStatus: "completed", schoolMap: [] },
      { id: "c2", kind: "edfi", name: "State Ed-Fi", baseUrl: "https://edfi.example.org/api/data", status: "pending_approval", updatedBy: "IT", canApprove: true, schoolMap: [] }] } };
    // 37.7.0 commerce (sandbox) screens.
    case "/api/events": return { data: [{ id: "e1", activity_id: "a1", school_id: "s1", title: "Friday Night Football", starts_at: new Date(Date.now() + 864e5).toISOString(),
      ends_at: new Date(Date.now() + 9e7).toISOString(), venue: "Main field", status: "published", school_name: "Maple" }] };
    case "/api/commerce/status": return { data: { provider: "sandbox", enabled: true, live: false, sandbox: false, canPay: ["parent", "superintendent"].includes(role),
      canManageProviders: ["superintendent", "it_admin"].includes(role), note: "Test mode: payments go to the processor's test system. No real money moves.", defaultMethod: "paypal",
      methods: [{ method: "paypal", label: "PayPal", processor: "paypal", mode: "test", default: true }, { method: "sandbox", label: "Sandbox (test checkout)", processor: "sandbox", mode: "test", default: false }],
      settings: { enabled: true, networkFeeBps: 300, salesTaxBps: 0, split: { schoolBps: 8500, districtBps: 1000, stateBps: 500 }, stateFundLabel: "State education fund",
        marketplaceFeeBps: 500, holdMinutes: 10, updatedAt: now } } };
    case "/api/commerce/shop": return { data: { events: [{ id: "e1", title: "Friday Night Football", startsAt: now, venue: "Main field", school: "Maple",
      ticketTypes: [{ id: "t1", name: "Adult", priceCents: 1000, currency: "USD", available: 3 }, { id: "t2", name: "Student", priceCents: 0, currency: "USD", available: 0 }] }] } };
    case "/api/commerce/my": return { data: { payments: [{ id: "p1", purpose: "event_tickets", status: "succeeded", amountCents: 2000, currency: "USD", title: "Friday Night Football",
      quantity: 2, createdAt: now, receipts: [{ id: "r1", kind: "payment", number: "R-20261117-ABCDEF0123", amountCents: 2000, issuedAt: now }] }] } };
    case "/api/commerce/report": return { data: { scope: role === "principal" ? "school" : "district",
      totals: { gross: 2000, processing_fee: 88, network_fee: 60, school_share: 1574, district_share: 185, state_share: 93 },
      bySchool: [{ id: "s1", name: "Maple", totals: { gross: 2000, school_share: 1574 } }, { id: "s2", name: "Oak", totals: { gross: 1000, school_share: 787 } }],
      payments: [{ id: "p1", purpose: "event_tickets", status: "succeeded", amountCents: 2000, currency: "USD", payer: "Parent A", title: "Friday Night Football", quantity: 2, createdAt: now, refundable: true }] } };
    case "/api/commerce/marketplace": return { data: { marketplaceFeeBps: 500, licenses: [
      { feeEventId: "f1", approvedAt: now, listingId: "l1", name: "Math Garden", vendor: "MathCo", unitPriceCents: 1250, priceUnit: "seat", seatLimit: 30, purchase: null },
      { feeEventId: "f2", approvedAt: now, listingId: "l2", name: "Read Along", vendor: "ReadCo", unitPriceCents: null, priceUnit: "flat", seatLimit: null, purchase: { id: "m1", status: "paid", total_cents: 5000, quantity: 1 } }] } };
    // 37.8.0 district webhook operations.
    case "/api/commerce/providers/webhook-refund-cases": if (failWebhookLoads) return null; return { data: { refundCases: [{ id: "rf1", processor: "paypal", captureRef: "CAPTURE-123", amountCents: 1250, currency: "USD", reasonCode: "hold_expired", openedAt: now }] } };
    case "/api/commerce/providers/webhook-dead-letters": if (failWebhookLoads) return null; return { data: { deadLetters: [{ id: "dl1", processor: "square", providerEventId: "evt-123", eventType: "payment.updated", attempts: 20, errorCode: "provider_unreachable", receivedAt: now }] } };
    // 37.7.1 district payment setup, built from the real catalog.
    case "/api/commerce/providers": return { data: { liveSwitch: false, secretsKeyConfigured: true, btcpayAllowedHosts: [],
      setup: { enabledMethods: ["paypal", "sandbox"], defaultMethod: "paypal", cardProcessor: "square", updatedAt: now },
      processors: Object.fromEntries(["paypal", "square", "btcpay"].map(p => { const spec = PROCESSORS[p], plain = spec.fields.filter(f => !f.secret), sec = spec.fields.filter(f => f.secret);
        return [p, { processor: p, label: spec.label, description: spec.description, fields: spec.fields, enabled: p === "paypal", mode: "test", status: p === "paypal" ? "test" : "not_set_up",
          config: Object.fromEntries(plain.map(f => [f.key, p === "paypal" && f.key === "clientId" ? "AbcDef1234567890" : null])),
          secretsSet: Object.fromEntries(sec.map(f => [f.key, p === "paypal"])), missing: [], fee: spec.defaultFee,
          lastTest: p === "paypal" ? { at: now, ok: true, detail: "token_ok" } : null, updatedAt: now }]; })),
      methods: Object.values(METHODS).map(m => ({ id: m.id, label: m.label, description: m.description, processors: m.processors, setupProcessor: m.setupProcessor, checkout: !m.methodless,
        signup: m.signup || null, developer: m.developer || null, docs: m.docs || [], notes: m.notes || [], otherLinks: m.otherLinks || [], adapter: m.adapter, comingReason: m.comingReason || null })) } };
    default:
      if (pathname.startsWith("/api/node/")) return null; // no local node: 404
      return { data: [] };
  }
}

function startServer() {
  const state = { role: "parent", endpointOps: { issued: 0, revoked: 0, urls: [] } };
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://x");
    if (pathname.startsWith("/api/")) {
      const endpoint = pathname.match(/^\/api\/commerce\/providers\/(paypal|square|btcpay)\/webhook-endpoint(?:\/(rotate))?$/);
      if (endpoint && req.method === "POST" && endpoint[2] === "rotate") {
        const processor = endpoint[1], webhookUrl = `https://hooks.example.test/api/commerce/webhooks/${processor}/smoke-token-${state.endpointOps.issued + 1}`;
        state.endpointOps.issued++;
        state.endpointOps.urls.push(webhookUrl);
        res.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify({ data: { processor, webhookUrl, notice: "Copy this URL now. It will not be shown again." } }));
      }
      if (endpoint && req.method === "DELETE" && !endpoint[2]) {
        state.endpointOps.revoked++;
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify({ data: { processor: endpoint[1], revoked: 1, active: false } }));
      }
      const body = req.method === "GET" ? mockApi(state.role, pathname, state.failWebhookLoads) : { data: {} };
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
  // 37.7.0: commerce screens opened from Clubs & Sports (not tabs of their own);
  // 37.7.1: district payment setup from Ticketing & revenue or Data links.
  const SUBVIEWS = { parent: ["tickets"], pupil: ["tickets"], principal: ["commerce"], superintendent: ["commerce", "payments"], it_admin: ["payments"] };
  for (const [role, roleTabList] of Object.entries(roleTabs)) {
    for (const tab of [...roleTabList, ...(SUBVIEWS[role] || [])]) {
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
        if (["superintendent", "it_admin"].includes(role) && tab === "payments") {
          if (!text.includes("Payment webhook operations") || !text.includes("Late payment captures needing a refund") || !text.includes("Webhook events requiring investigation"))
            failures.push(`${role} #/payments: webhook operations panel is incomplete`);
          if (!text.includes("CAPTURE-123") || !text.includes("evt-123")) failures.push(`${role} #/payments: webhook recovery records did not render`);
        }
      } finally {
        page.close();
      }
    }
  }
  // Failed queue requests must be visibly different from genuinely empty queues.
  state.role = "superintendent";
  state.failWebhookLoads = true;
  {
    const page = await Page.open(chrome.port);
    try {
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/payments` });
      const text = await page.mainText();
      if (!text.includes("Refund cases couldn't be loaded") || !text.includes("Dead-letter events couldn't be loaded"))
        failures.push("superintendent #/payments: webhook API failures were presented as empty queues");
      if (page.errors.length) failures.push(`superintendent #/payments failure state: ${page.errors[0].split("\n")[0]}`);
    } finally { page.close(); }
  }
  // Exercise the real provider endpoint controls: issue, rotate (replacing the
  // one-time bearer URL), then revoke (clearing the secret from the view).
  state.failWebhookLoads = false;
  state.endpointOps = { issued: 0, revoked: 0, urls: [] };
  {
    const page = await Page.open(chrome.port);
    try {
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/app/index.html#/payments` });
      await page.mainText();
      const clickButton = label => page.eval(`([...document.querySelectorAll("button")].find(b => b.textContent.trim() === ${JSON.stringify(label)}) || {}).click?.()`);
      const clickDialogButton = label => page.eval(`([...document.querySelectorAll("dialog button")].find(b => b.textContent.trim() === ${JSON.stringify(label)}) || {}).click?.()`);
      const waitFor = async expression => {
        const end = Date.now() + 5000;
        while (Date.now() < end) {
          if (await page.eval(expression)) return true;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return false;
      };

      await clickButton("Issue / rotate URL");
      await clickDialogButton("Issue URL");
      if (!await waitFor('document.querySelector(\'[aria-label="PayPal one-time webhook URL"]\')?.value'))
        failures.push("superintendent #/payments: issuing a webhook URL did not reveal the one-time URL");
      const firstUrl = await page.eval('document.querySelector(\'[aria-label="PayPal one-time webhook URL"]\')?.value');
      await clickButton("Issue / rotate URL");
      await clickDialogButton("Issue URL");
      if (!await waitFor(`document.querySelector('[aria-label="PayPal one-time webhook URL"]')?.value !== ${JSON.stringify(firstUrl)}`))
        failures.push("superintendent #/payments: rotating a webhook URL did not replace the prior URL");
      const secondUrl = await page.eval('document.querySelector(\'[aria-label="PayPal one-time webhook URL"]\')?.value');
      await clickButton("Revoke URL");
      await clickDialogButton("Revoke");
      if (!await waitFor('!document.querySelector(\'[aria-label="PayPal one-time webhook URL"]\')'))
        failures.push("superintendent #/payments: revoking a webhook URL did not clear the revealed secret");
      if (firstUrl === secondUrl || !firstUrl?.includes("smoke-token-1") || !secondUrl?.includes("smoke-token-2"))
        failures.push("superintendent #/payments: issue/rotate returned unexpected one-time URL values");
      if (state.endpointOps.issued !== 2 || state.endpointOps.revoked !== 1)
        failures.push(`superintendent #/payments: expected 2 issue/rotate calls and 1 revoke call, got ${JSON.stringify(state.endpointOps)}`);
      if (page.errors.length) failures.push(`superintendent #/payments endpoint controls: ${page.errors[0].split("\\n")[0]}`);
    } finally { page.close(); }
  }
  assert.deepEqual(failures, []);
});
