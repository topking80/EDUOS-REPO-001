// Live end-to-end check of the server flow/webhook layers against a real
// PostgreSQL database and a local webhook receiver.
//   node flow-live-check.mjs <api base> <path to src/webhooks.js> <psql conninfo for RLS checks>
// Expects seeded sessions (see flow-live-seed.sql) and a server started with
// WEBHOOK_SIGNING_KEY set and WEBHOOK_ALLOW_INSECURE_LOOPBACK=true (dev only).
import http from "node:http";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const API = process.argv[2] || "http://127.0.0.1:8181";
const { verifySignature } = await import(pathToFileURL(process.argv[3]).href);
const PSQL_DB = process.argv[4] || "";
const results = [];
const check = (name, cond, detail = "") => { results.push(!!cond); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- local webhook receiver ----
const received = [];
let finalHits = 0;
const receiver = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    received.push({ path: req.url, headers: req.headers, body });
    if (req.url === "/ok") { res.statusCode = 200; return res.end("ok"); }
    if (req.url === "/fail") { res.statusCode = 500; return res.end("no"); }
    if (req.url === "/redirect") { res.statusCode = 302; res.setHeader("Location", "http://127.0.0.1:9911/final"); return res.end(); }
    if (req.url === "/final") { finalHits++; res.statusCode = 200; return res.end("final"); }
    res.statusCode = 404; res.end();
  });
});
await new Promise(r => receiver.listen(9911, "127.0.0.1", r));

// ---- API client per seeded role ----
function client(token) {
  const cookie = `eduos_session=${token}`;
  let csrf = null;
  const call = async (method, path, body, opts = {}) => {
    const headers = { cookie };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET" && !opts.noCsrf) {
      if (!csrf) csrf = (await (await fetch(API + "/api/csrf", { headers: { cookie } })).json()).csrfToken;
      headers["x-csrf-token"] = csrf;
    }
    const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  return { get: p => call("GET", p), post: (p, b, o) => call("POST", p, b, o), del: p => call("DELETE", p) };
}
const sup = client("tok-supA-0123456789abcdef"), prin = client("tok-prinA-0123456789abcdef"), teach = client("tok-teachA-0123456789abcdef"),
  parent = client("tok-parA-0123456789abcdef"), pupil = client("tok-pupA-0123456789abcdef"), supB = client("tok-supB-0123456789abcdef");

const enrolled = { type: "pupil.enrolled", refs: { section: "SEC-0001", teacher: "TCH-0001", school: "SCH-001" }, counts: { enrolled: 13, capacity: 50 } };

// ---- flow events: authorisation, validation, audience, tenant isolation ----
check("session is live for seeded teacher", (await teach.get("/api/me")).json?.role === "teacher");
const posted = await teach.post("/api/flow-events", enrolled);
check("teacher records pupil.enrolled (201)", posted.status === 201 && posted.json?.recorded === true, "status " + posted.status);
check("POST without CSRF token is rejected (403)", (await teach.post("/api/flow-events", enrolled, { noCsrf: true })).status === 403);
check("parent cannot raise flow events (403)", (await parent.post("/api/flow-events", enrolled)).status === 403);
check("teacher cannot raise a principal-only event (400)", (await teach.post("/api/flow-events", { type: "teacher.hired", counts: { teachers: 4 } })).status === 400);
check("free text / unknown keys are rejected (400)", (await teach.post("/api/flow-events", { ...enrolled, note: "Sam Rivera enrolled" })).status === 400);
check("names in references are rejected (400)", (await teach.post("/api/flow-events", { type: "pupil.enrolled", refs: { section: "Sam Rivera" } })).status === 400);
check("server-only event types cannot be reported by a client (400)", (await teach.post("/api/flow-events", { type: "assignment.created" })).status === 400);
check("principal hires -> teacher.hired (201)", (await prin.post("/api/flow-events", { type: "teacher.hired", refs: { teacher: "TCH-0004", school: "SCH-001" }, counts: { teachers: 4 } })).status === 201);
const has = async (c, type) => ((await c.get("/api/flow-events")).json?.data || []).some(e => e.type === type);
check("principal's feed receives the enrollment", await has(prin, "pupil.enrolled"));
check("parent's feed receives the enrollment", await has(parent, "pupil.enrolled"));
check("pupil's feed receives the enrollment", await has(pupil, "pupil.enrolled"));
check("superintendent's feed receives hire + enrollment", (await has(sup, "pupil.enrolled")) && (await has(sup, "teacher.hired")));
check("parent does not receive the staff-only hire event", !(await has(parent, "teacher.hired")));
check("another district sees none of it (tenant isolation)", ((await supB.get("/api/flow-events")).json?.data || []).length === 0);

// ---- webhooks: who may manage, what destinations are allowed ----
check("principal cannot manage webhooks (403)", (await prin.post("/api/webhooks", { url: "http://127.0.0.1:9911/ok", eventTypes: ["*"] })).status === 403);
const reject = async (url, reason) => { const r = await sup.post("/api/webhooks", { url, eventTypes: ["*"] }); return r.status === 400 && r.json?.reason === reason ? true : `${r.status}/${r.json?.reason}`; };
for (const [url, reason] of [
  ["http://example.org/hook", "https_required"], ["https://10.0.0.5/hook", "address_not_allowed"],
  ["https://169.254.169.254/latest/meta-data", "address_not_allowed"], ["https://[::ffff:10.0.0.1]/hook", "address_not_allowed"],
  ["https://user:pw@example.org/hook", "credentials_not_allowed"], ["https://example.org:22/hook", "port_not_allowed"],
  ["https://intranet/hook", "address_not_allowed"]
]) { const r = await reject(url, reason); check(`destination rejected: ${url} -> ${reason}`, r === true, r === true ? "" : String(r)); }
check("unknown event type in subscription rejected (400)", (await sup.post("/api/webhooks", { url: "http://127.0.0.1:9911/ok", eventTypes: ["nope.event"] })).status === 400);

const okHook = await sup.post("/api/webhooks", { url: "http://127.0.0.1:9911/ok", eventTypes: ["pupil.enrolled", "assignment.created", "attendance.recorded"] });
check("superintendent registers a webhook and receives the secret once", okHook.status === 201 && /^whsec_/.test(okHook.json?.secret || ""), "status " + okHook.status);
check("duplicate destination rejected (409)", (await sup.post("/api/webhooks", { url: "http://127.0.0.1:9911/ok", eventTypes: ["*"] })).status === 409);
const listed = (await sup.get("/api/webhooks")).json;
check("listing never exposes a secret", listed?.data?.length === 1 && !JSON.stringify(listed).includes("whsec_"));
check("another district cannot see the subscription", ((await supB.get("/api/webhooks")).json?.data || []).length === 0);

// ---- delivery: signed, minimal payload ----
received.length = 0;
await teach.post("/api/flow-events", enrolled);
for (let i = 0; i < 40 && !received.some(r => r.path === "/ok"); i++) await sleep(100);
const hit = received.find(r => r.path === "/ok");
check("receiver gets the event", !!hit);
if (hit) {
  const payload = JSON.parse(hit.body);
  check("signature verifies with the issued secret", verifySignature(okHook.json.secret, hit.headers["x-eduos-signature"], hit.body));
  check("tampered body fails verification", !verifySignature(okHook.json.secret, hit.headers["x-eduos-signature"], hit.body.replace("13", "14")));
  check("wrong secret fails verification", !verifySignature("whsec_wrong", hit.headers["x-eduos-signature"], hit.body));
  check("stale timestamp fails verification (replay window)", !verifySignature(okHook.json.secret, hit.headers["x-eduos-signature"], hit.body, { now: Date.now() + 3600_000 }));
  check("event headers are present", hit.headers["x-eduos-event"] === "pupil.enrolled" && /^[0-9a-f-]{36}$/.test(hit.headers["x-eduos-delivery"] || ""));
  check("payload carries type, refs and counts only", payload.type === "pupil.enrolled" && payload.counts.enrolled === 13 && payload.source === "client-reported" &&
    Object.keys(payload).sort().join() === "actorRole,audience,counts,districtId,id,occurredAt,refs,source,type");
}
received.length = 0;
await prin.post("/api/flow-events", { type: "teacher.hired", counts: { teachers: 5 } });
await sleep(700);
check("unsubscribed event types are not delivered", !received.some(r => r.path === "/ok"));

// ---- server-raised events from authoritative writes ----
received.length = 0;
const asg = await teach.post("/api/assignments", { title: "Flow check assignment" });
for (let i = 0; i < 40 && !received.some(r => r.headers["x-eduos-event"] === "assignment.created"); i++) await sleep(100);
const asgHit = received.find(r => r.headers["x-eduos-event"] === "assignment.created");
check("creating an assignment raises a server flow event + webhook", asg.status === 201 && !!asgHit && JSON.parse(asgHit.body).source === "server" && JSON.parse(asgHit.body).refs.resource === asg.json.data.id, "status " + asg.status);
check("pupil's feed shows the published assignment", await has(pupil, "assignment.created"));

// ---- failure handling: retries, no redirects, test endpoint, disable ----
const failHook = await sup.post("/api/webhooks", { url: "http://127.0.0.1:9911/fail", eventTypes: ["section.full"] });
received.length = 0;
await teach.post("/api/flow-events", { type: "section.full", refs: { section: "SEC-0001" }, counts: { enrolled: 50, capacity: 50 } });
for (let i = 0; i < 60 && received.filter(r => r.path === "/fail").length < 3; i++) await sleep(100);
await sleep(400);
check("failing receiver is retried 3 times", received.filter(r => r.path === "/fail").length === 3, "attempts " + received.filter(r => r.path === "/fail").length);
const failLog = (await sup.get(`/api/webhooks/${failHook.json.data.id}/deliveries`)).json?.data || [];
check("every attempt is logged with its outcome", failLog.length === 3 && failLog.every(d => d.outcome === "http_error" && d.statusCode === 500));
check("failure count is tracked on the subscription", (await sup.get("/api/webhooks")).json.data.find(h => h.id === failHook.json.data.id)?.failureCount === 1);

const redirHook = await sup.post("/api/webhooks", { url: "http://127.0.0.1:9911/redirect", eventTypes: ["teacher.removed"] });
const redirTest = await sup.post(`/api/webhooks/${redirHook.json.data.id}/test`, {});
check("redirects are not followed", redirTest.json?.outcome === "http_error" && redirTest.json?.statusCode === 302 && finalHits === 0, JSON.stringify(redirTest.json));
const okTest = await sup.post(`/api/webhooks/${okHook.json.data.id}/test`, {});
check("test delivery succeeds for a healthy receiver", okTest.json?.outcome === "delivered" && okTest.json?.statusCode === 200);

check("webhook can be disabled", (await sup.del(`/api/webhooks/${okHook.json.data.id}`)).status === 200);
received.length = 0;
await teach.post("/api/flow-events", enrolled);
await sleep(800);
check("disabled webhook receives nothing further", !received.some(r => r.path === "/ok"));
check("audit trail records webhook administration", ((await sup.get("/api/audit")).json?.data || []).filter(a => a.resource_type === "webhook_subscription").length >= 4);

// ---- database guarantees (runtime role) ----
if (PSQL_DB) {
  const q = (sql, opts = "") => { try { return execFileSync("psql", [PSQL_DB, "-tAc", sql], { env: { ...process.env, PGOPTIONS: opts }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) { return "ERR:" + String(e.stderr || e.message).split("\n")[0]; } };
  const dA = q("SELECT district_id FROM flow_events LIMIT 1", "-c app.district_id=" + (await sup.get("/api/me")).json.districtId);
  check("RLS: no tenant context -> no rows", q("SELECT count(*) FROM flow_events") === "0");
  check("RLS: district B context sees zero district A events", q("SELECT count(*) FROM flow_events", "-c app.district_id=" + (await supB.get("/api/me")).json.districtId) === "0");
  check("RLS: district A context sees its events", Number(q("SELECT count(*) FROM flow_events", "-c app.district_id=" + dA)) >= 5);
  check("runtime role cannot rewrite event history", /permission denied/.test(q("UPDATE flow_events SET event_type='x.y'", "-c app.district_id=" + dA)) && /permission denied/.test(q("DELETE FROM flow_events", "-c app.district_id=" + dA)));
  check("runtime role cannot delete delivery logs or subscriptions", /permission denied/.test(q("DELETE FROM webhook_deliveries", "-c app.district_id=" + dA)) && /permission denied/.test(q("DELETE FROM webhook_subscriptions", "-c app.district_id=" + dA)));
  check("no signing secret is stored in the database", q("SELECT count(*) FROM information_schema.columns WHERE table_name='webhook_subscriptions' AND column_name ILIKE '%secret%'", "") === "0");
}

receiver.close();
const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} live flow/webhook checks passed`);
process.exit(pass === results.length ? 0 : 1);
