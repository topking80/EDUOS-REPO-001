import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { FLOW_EVENT_TYPES, normalizeFlowEvent, serverFlowEvent, webhookPayload } from "../src/flow-events.js";
import {
  deliverOnce, deliverWebhook, deriveWebhookSecret, isBlockedAddress, resolveWebhookTarget,
  parseRetryAfter, signatureHeader, validateWebhookUrl, verifySignature
} from "../src/webhooks.js";
import { ROLE_PERMISSIONS, canPerform, isGrantable } from "../src/policy.js";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [server, migration, grants, migrate, html, bridge, config] = await Promise.all([
  read("../src/server.js"), read("../db/008_flow_events_webhooks.sql"), read("../db/runtime_grants.template.sql"),
  read("../src/migrate.js"), Promise.all([read("../public/index.html"), read("../public/legacy-app.js")]).then(x => x.join("")), read("../public/api-bridge.js"), read("../src/config.js")
]);
const valid = { type: "pupil.enrolled", refs: { section: "SEC-0001", teacher: "TCH-0001", school: "SCH-001" }, counts: { enrolled: 13, capacity: 50 } };

// ---- flow event vocabulary ----
test("a valid client event is normalized, frozen and labelled client-reported", () => {
  const event = normalizeFlowEvent(valid, "teacher");
  assert.equal(event.type, "pupil.enrolled");
  assert.equal(event.source, "client-reported");
  assert.deepEqual(event.audience, ["principal", "superintendent", "parent", "pupil"]);
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.refs) && Object.isFrozen(event.counts));
});
test("flow events reject the wrong role, free text, names and impossible counters", () => {
  assert.equal(normalizeFlowEvent(valid, "parent"), null);
  assert.equal(normalizeFlowEvent(valid, "principal"), null);
  assert.equal(normalizeFlowEvent({ ...valid, note: "Sam Rivera" }, "teacher"), null);
  assert.equal(normalizeFlowEvent({ type: "pupil.enrolled", refs: { section: "Sam Rivera" } }, "teacher"), null);
  assert.equal(normalizeFlowEvent({ type: "pupil.enrolled", refs: { pupil: "PUP-0001" } }, "teacher"), null);
  assert.equal(normalizeFlowEvent({ type: "pupil.enrolled", counts: { enrolled: 51, capacity: 50 } }, "teacher"), null);
  assert.equal(normalizeFlowEvent({ type: "pupil.enrolled", counts: { enrolled: 1.5 } }, "teacher"), null);
  assert.equal(normalizeFlowEvent({ type: "pupil.enrolled", counts: { enrolled: -1 } }, "teacher"), null);
  assert.equal(normalizeFlowEvent({ type: "__proto__" }, "teacher"), null);
  assert.equal(normalizeFlowEvent({ type: "assignment.created" }, "teacher"), null);
  for (const bad of [null, [], "x", 3]) assert.equal(normalizeFlowEvent(bad, "teacher"), null);
});
test("server events need an authoritative type and a UUID resource", () => {
  const id = "0b9c2e1a-7d44-4c1e-9a55-3f6f5a1c2d3e";
  assert.deepEqual(serverFlowEvent("assignment.created", "teacher", id).refs, { resource: id });
  assert.equal(serverFlowEvent("assignment.created", "teacher", id).source, "server");
  assert.equal(serverFlowEvent("assignment.created", "pupil", id), null);
  assert.equal(serverFlowEvent("pupil.enrolled", "teacher", id), null);
  assert.equal(serverFlowEvent("assignment.created", "teacher", "not-a-uuid"), null);
});
test("webhook payload exposes a fixed, name-free shape", () => {
  const payload = webhookPayload({ id: "e", type: "pupil.enrolled", occurredAt: "t", source: "client-reported", actorRole: "teacher",
    audience: ["principal"], districtId: "d", refs: { section: "SEC-0001" }, counts: { enrolled: 1 }, actorUserId: "secret-user", staffText: "Sam Rivera" });
  assert.deepEqual(Object.keys(payload).sort(), ["actorRole", "audience", "counts", "districtId", "id", "occurredAt", "refs", "source", "type"]);
  assert.ok(!JSON.stringify(payload).includes("Sam Rivera") && !JSON.stringify(payload).includes("secret-user"));
});
test("every event type names valid emitters and audiences", () => {
  const roles = ["superintendent", "it_admin", "principal", "teacher", "parent", "pupil"];
  for (const def of Object.values(FLOW_EVENT_TYPES)) {
    assert.ok(def.emitters.length && def.emitters.every(r => roles.includes(r)));
    assert.ok(def.audience.length && def.audience.every(r => roles.includes(r)));
    assert.ok(!def.emitters.includes("parent") && !def.emitters.includes("pupil"));
  }
});

// ---- SSRF defences ----
test("non-public addresses are blocked, public ones are not", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "not-an-ip", ""])
    assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isBlockedAddress(ip), false, ip);
});
test("IANA special-purpose IPv6 ranges are rejected while global unicast remains allowed", () => {
  // Regression coverage for protocol-assignment, benchmarking, ORCHID,
  // SRv6, AS112, documentation, NAT64-local-use and 6to4 ranges.
  for (const ip of [
    "2001::1", "2001:1::1", "2001:2::1", "2001:10::1", "2001:20::1",
    "5f00::1", "2620:4f:8000::1", "3fff::1", "64:ff9b:1::1",
    "2002:0808:0808::1", "fec0::1", "::ffff:192.0.2.1"
  ]) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["2001:4860:4860::8888", "2606:4700:4700::1111"])
    assert.equal(isBlockedAddress(ip), false, ip);
});

test("Retry-After accepts bounded delta-seconds and HTTP dates, rejects malformed values", () => {
  const now = Date.parse("2026-11-16T14:00:00.000Z");
  assert.equal(parseRetryAfter("120", now), 120);
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter("7200", now), 3600, "receiver delay is capped at one hour");
  assert.equal(parseRetryAfter("Mon, 16 Nov 2026 14:02:30 GMT", now), 150);
  assert.equal(parseRetryAfter("Mon, 16 Nov 2026 13:59:00 GMT", now), 0);
  for (const bad of [undefined, null, "", "soon", "-1", "1.5", "999999999999", "Mon, not-a-date"])
    assert.equal(parseRetryAfter(bad, now), null, String(bad));
});

test("destination URLs must be https, credential-free, public and on a safe port", () => {
  const reason = (url, opts) => validateWebhookUrl(url, opts).reason;
  assert.equal(validateWebhookUrl("https://hooks.example.org/eduos?x=1").ok, true);
  assert.equal(validateWebhookUrl("https://hooks.example.org:8443/eduos").ok, true);
  assert.equal(reason("http://hooks.example.org/eduos"), "https_required");
  assert.equal(reason("ftp://hooks.example.org/eduos"), "https_required");
  assert.equal(reason("file:///etc/passwd-padding"), "https_required");
  assert.equal(reason("https://user:pw@hooks.example.org/"), "credentials_not_allowed");
  assert.equal(reason("https://hooks.example.org/#frag"), "fragment_not_allowed");
  assert.equal(reason("https://hooks.example.org:22/"), "port_not_allowed");
  for (const url of ["https://127.0.0.1/hook", "https://localhost/hook", "https://10.0.0.5/hook", "https://[::1]/hook", "https://[fd00::1]/hook",
    "https://169.254.169.254/latest", "https://intranet/hook", "https://db.internal/hook", "https://printer.local/hook", "https://2130706433/hook", "https://0x7f.0.0.1/hook"])
    assert.equal(reason(url), "address_not_allowed", url);
  for (const bad of [null, 42, "", "https://", "not a url at all", "https://exa mple.org/x", "https://example.org/" + "a".repeat(2100)]) assert.equal(validateWebhookUrl(bad).ok, false);
});
test("loopback http is a development-only allowance and an allow-list pins destinations", () => {
  assert.equal(validateWebhookUrl("http://127.0.0.1:9911/ok").ok, false);
  assert.equal(validateWebhookUrl("http://127.0.0.1:9911/ok", { allowInsecureLoopback: true }).ok, true);
  assert.equal(validateWebhookUrl("http://10.0.0.5:9911/ok", { allowInsecureLoopback: true }).reason, "https_required");
  assert.equal(validateWebhookUrl("https://evil.example.com/x", { allowedHosts: ["example.org"] }).reason, "host_not_allowed");
  assert.equal(validateWebhookUrl("https://notexample.org/x", { allowedHosts: ["example.org"] }).reason, "host_not_allowed");
  assert.equal(validateWebhookUrl("https://hooks.example.org/x", { allowedHosts: ["example.org"] }).ok, true);
  assert.match(config, /webhookAllowInsecureLoopback: process\.env\.WEBHOOK_ALLOW_INSECURE_LOOPBACK === "true" && \(process\.env\.NODE_ENV \|\| "development"\) !== "production"/);
});
test("DNS answers must all be public (no rebinding through a mixed answer)", async () => {
  const url = new URL("https://hooks.example.org/x");
  const ok = await resolveWebhookTarget(url, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
  assert.deepEqual(ok, { ok: true, address: "93.184.216.34", family: 4 });
  const mixed = await resolveWebhookTarget(url, { lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }] });
  assert.deepEqual(mixed, { ok: false, reason: "address_not_allowed" });
  assert.equal((await resolveWebhookTarget(url, { lookup: async () => [{ address: "127.0.0.1", family: 4 }] })).ok, false);
  assert.equal((await resolveWebhookTarget(url, { lookup: async () => [] })).reason, "dns_failure");
  assert.equal((await resolveWebhookTarget(url, { lookup: async () => { throw new Error("ENOTFOUND"); } })).reason, "dns_failure");
  // The DNS timer is unref'd (it must never hold the server open), so keep the
  // test process alive while it fires; otherwise Node can see nothing left to
  // run and fail the test with "Promise resolution is still pending".
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.equal((await resolveWebhookTarget(url, { dnsTimeoutMs: 5, lookup: () => new Promise(() => {}) })).reason, "dns_timeout");
  } finally { clearInterval(keepAlive); }
});

test("transient DNS failures retry, while unsafe DNS answers remain blocked", async () => {
  const secret = deriveWebhookSecret("k".repeat(40), "sub-dns-retry");
  let lookups = 0, sends = 0, sleeps = 0;
  const retried = await deliverWebhook({
    subscription: { id: "sub-dns-retry", url: "https://hooks.example.test/events" },
    secret, eventType: "pupil.enrolled", deliveryId: "delivery-dns-retry", body: "{}",
    options: {
      lookup: async () => {
        lookups += 1;
        if (lookups === 1) throw new Error("EAI_AGAIN");
        return [{ address: "93.184.216.34", family: 4 }];
      },
      send: async () => { sends += 1; return { outcome: "delivered", statusCode: 204, durationMs: 1 }; },
      sleep: async () => { sleeps += 1; }, maxAttempts: 2
    }
  });
  assert.deepEqual(retried.map(x => x.outcome), ["network_error", "delivered"]);
  assert.equal(lookups, 2);
  assert.equal(sends, 1);
  assert.equal(sleeps, 1);

  const blocked = await deliverWebhook({
    subscription: { id: "sub-dns-retry", url: "https://hooks.example.test/events" },
    secret, eventType: "pupil.enrolled", deliveryId: "delivery-dns-blocked", body: "{}",
    options: {
      lookup: async () => [{ address: "10.0.0.8", family: 4 }],
      send: async () => { throw new Error("must not send to private address"); },
      maxAttempts: 3
    }
  });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].outcome, "blocked");
  assert.equal(blocked[0].reason, "address_not_allowed");
});

// ---- signing ----
test("signatures verify, and fail on tampering, wrong secret, replay or malformed headers", () => {
  const secret = deriveWebhookSecret("k".repeat(40), "sub-1"), body = JSON.stringify({ type: "pupil.enrolled" }), now = 1_800_000_000_000;
  const header = signatureHeader(secret, now / 1000, body);
  assert.equal(verifySignature(secret, header, body, { now }), true);
  assert.equal(verifySignature(secret, header, body + " ", { now }), false);
  assert.equal(verifySignature(deriveWebhookSecret("k".repeat(40), "sub-2"), header, body, { now }), false);
  assert.equal(verifySignature(secret, header, body, { now: now + 301_000 }), false);
  for (const bad of [undefined, "", "v1=abc", "t=1,v1=zz", header + "0", "t=" + now / 1000 + ",v1=" + "0".repeat(64)]) assert.equal(verifySignature(secret, bad, body, { now }), false);
});
test("subscription secrets are derived, stable per subscription, and need a strong key", () => {
  const key = "k".repeat(40);
  assert.match(deriveWebhookSecret(key, "a"), /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.equal(deriveWebhookSecret(key, "a"), deriveWebhookSecret(key, "a"));
  assert.notEqual(deriveWebhookSecret(key, "a"), deriveWebhookSecret(key, "b"));
  assert.notEqual(deriveWebhookSecret(key, "a"), deriveWebhookSecret("j".repeat(40), "a"));
  assert.throws(() => deriveWebhookSecret("short", "a"));
  assert.match(config, /WEBHOOK_SIGNING_KEY must be at least 32 characters/);
});

// ---- delivery behaviour ----
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const subscription = { id: "sub-1", url: "https://hooks.example.org/eduos" };
const deliver = (send, extra = {}) => {
  const sleeps = [];
  return deliverWebhook({ subscription, secret: "whsec_x", eventType: "pupil.enrolled", deliveryId: "d-1", body: "{}",
    options: { lookup: publicLookup, send, sleep: async ms => { sleeps.push(ms); }, ...extra } }).then(attempts => ({ attempts, sleeps }));
};
test("transient failures are retried with backoff, then reported", async () => {
  let calls = 0;
  const { attempts, sleeps } = await deliver(async () => { calls++; return { outcome: "http_error", statusCode: 500, durationMs: 1 }; });
  assert.equal(calls, 3);
  assert.deepEqual(attempts.map(a => a.attempt), [1, 2, 3]);
  assert.deepEqual(sleeps, [400, 1600]);
});
test("success stops retrying; a client error is not retried", async () => {
  let calls = 0;
  const ok = await deliver(async () => (++calls < 2 ? { outcome: "timeout", statusCode: null } : { outcome: "delivered", statusCode: 204 }));
  assert.deepEqual(ok.attempts.map(a => a.outcome), ["timeout", "delivered"]);
  let rejected = 0;
  const no = await deliver(async () => { rejected++; return { outcome: "http_error", statusCode: 410 }; });
  assert.equal(rejected, 1);
  assert.equal(no.attempts.length, 1);
});
test("a destination that starts resolving privately is blocked without sending", async () => {
  let sent = 0;
  const { attempts } = await deliver(async () => { sent++; return { outcome: "delivered", statusCode: 200 }; }, { lookup: async () => [{ address: "10.0.0.9", family: 4 }] });
  assert.equal(sent, 0);
  assert.deepEqual(attempts.map(a => [a.outcome, a.reason]), [["blocked", "address_not_allowed"]]);
});
test("each delivery is signed and connects to the vetted address only", async () => {
  const seen = [];
  await deliver(async request => { seen.push(request); return { outcome: "delivered", statusCode: 200 }; }, { now: () => 1_800_000_000_000 });
  assert.equal(seen[0].address, "93.184.216.34");
  assert.equal(seen[0].headers["X-EduOS-Event"], "pupil.enrolled");
  assert.equal(verifySignature("whsec_x", seen[0].headers["X-EduOS-Signature"], "{}", { now: 1_800_000_000_000 }), true);
});
test("real HTTP delivery: 2xx delivered, redirect not followed, timeout enforced", async () => {
  let finalHits = 0;
  const receiver = http.createServer((req, res) => {
    req.resume();
    if (req.url === "/ok") return res.end("ok");
    if (req.url === "/redirect") { res.statusCode = 302; res.setHeader("Location", `http://127.0.0.1:${receiver.address().port}/final`); return res.end(); }
    if (req.url === "/final") { finalHits++; return res.end("final"); }
    // /hang: never answer
  });
  await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${receiver.address().port}`;
  const send = (path, timeoutMs = 2000) => deliverOnce({ url: new URL(base + path), address: "127.0.0.1", family: 4, headers: { "Content-Type": "application/json" }, body: "{}", timeoutMs });
  try {
    assert.deepEqual((({ outcome, statusCode }) => ({ outcome, statusCode }))(await send("/ok")), { outcome: "delivered", statusCode: 200 });
    const redirected = await send("/redirect");
    assert.equal(redirected.outcome, "http_error");
    assert.equal(redirected.statusCode, 302);
    assert.equal(finalHits, 0);
    assert.equal((await send("/hang", 250)).outcome, "timeout");
  } finally { receiver.closeAllConnections?.(); await new Promise(resolve => receiver.close(resolve)); }
});

test("real HTTP 429 and 503 responses preserve bounded Retry-After metadata", async () => {
  const receiver = http.createServer((req, res) => {
    req.resume();
    if (req.url === "/delta") {
      res.writeHead(429, { "Retry-After": "90" });
      return res.end();
    }
    res.writeHead(503, { "Retry-After": "Mon, 16 Nov 2026 14:02:00 GMT" });
    res.end();
  });
  await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve));
  const base = new URL(`http://127.0.0.1:${receiver.address().port}`);
  try {
    const delta = await deliverOnce({
      url: new URL("/delta", base), address: "127.0.0.1", family: 4,
      headers: {}, body: "{}", timeoutMs: 1000
    });
    assert.deepEqual([delta.outcome, delta.statusCode, delta.retryAfterSeconds], ["http_error", 429, 90]);

    const date = await deliverOnce({
      url: new URL("/date", base), address: "127.0.0.1", family: 4,
      headers: {}, body: "{}", timeoutMs: 1000
    });
    assert.deepEqual([date.outcome, date.statusCode], ["http_error", 503]);
    assert.equal(Number.isFinite(date.retryAfterSeconds), true);
    assert.ok(date.retryAfterSeconds >= 0 && date.retryAfterSeconds <= 3600);
  } finally {
    receiver.closeAllConnections?.();
    await new Promise(resolve => receiver.close(resolve));
  }
});

test("truncated or oversized webhook responses are never classified as delivered", async () => {
  const receiver = http.createServer((req, res) => {
    req.resume();
    res.writeHead(204);
    res.write("x".repeat(70 * 1024));
    res.socket.destroy();
  });
  await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve));
  const result = await deliverOnce({
    url: new URL(`http://127.0.0.1:${receiver.address().port}/large`),
    address: "127.0.0.1", family: 4, headers: {}, body: "{}", timeoutMs: 1000
  });
  try {
    assert.notEqual(result.outcome, "delivered");
  } finally {
    receiver.closeAllConnections?.();
    await new Promise(resolve => receiver.close(resolve));
  }
});

// ---- authorization model ----
test("only district roles (superintendent, IT admin) manage webhooks; families cannot raise flow events; neither is grantable", () => {
  const actor = role => ({ role, districtId: "d", userId: "u" });
  for (const role of Object.keys(ROLE_PERMISSIONS)) {
    assert.equal(canPerform(actor(role), "webhooks", "manage"), ["superintendent", "it_admin"].includes(role), role);
    assert.equal(canPerform(actor(role), "flow_events", "read"), Boolean(ROLE_PERMISSIONS[role].flow_events?.includes("read")), role);
    assert.equal(canPerform(actor(role), "flow_events", "create"), ["principal", "teacher"].includes(role), role);
  }
  assert.equal(isGrantable("webhooks", "manage"), false);
  assert.equal(isGrantable("flow_events", "create"), false);
});
test("server routes are authenticated, CSRF-protected, permissioned and fail closed", () => {
  assert.match(server, /app\.post\("\/api\/flow-events",flowLimiter,requireSession,requireCsrf,requirePermission\("flow_events","create"\)/);
  assert.match(server, /app\.get\("\/api\/flow-events",requireSession,requirePermission\("flow_events","read"\)/);
  assert.match(server, /app\.post\("\/api\/webhooks",webhookAdminLimiter,requireSession,requireCsrf,requirePermission\("webhooks","manage"\),webhooksEnabled/);
  assert.match(server, /app\.delete\("\/api\/webhooks\/:webhookId",webhookAdminLimiter,requireSession,requireCsrf,requirePermission\("webhooks","manage"\)/);
  assert.match(server, /app\.post\("\/api\/webhooks\/:webhookId\/test",webhookAdminLimiter,requireSession,requireCsrf,requirePermission\("webhooks","manage"\),webhooksEnabled/);
  assert.match(server, /webhooksEnabled=\(_req,res,next\)=>config\.webhookSigningKey\?next\(\):res\.status\(503\)\.json\(\{error:"webhooks_not_configured"\}\)/);
  assert.match(server, /const event=normalizeFlowEvent\(req\.body,req\.actor\.role\)/);
  assert.match(server, /recordFlowEvent\(req\.actor,event,req\.actor\.schoolId\)/, "school scope comes from the session, never the client");
  assert.match(server, /\$1 IN \('principal','teacher'\) AND \(school_id IS NULL OR school_id=\$3\)/);
  assert.ok(!/secret/.test(server.match(/app\.get\("\/api\/webhooks",[\s\S]*?\n\}\);/)[0]), "listing must not return secrets");
  // 2026-11-17 audit: server events are written with the business transaction's client.
  assert.match(server, /await emitServerFlow\(req,"assignment\.created",a\.id,a\.school_id,null,client\)/);
  // 32.0.53: attendance events carry the learner's school and subject student.
  assert.match(server, /await emitServerFlow\(req,"attendance\.recorded",saved\.rows\[0\]\.id,student\.rows\[0\]\.school_id,saved\.rows\[0\]\.student_id,client\)/);
});
test("migration enforces tenant isolation and stores no secrets; runtime role is least-privilege", () => {
  for (const table of ["flow_events", "webhook_subscriptions", "webhook_deliveries"]) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`CREATE POLICY tenant_isolation ON ${table}`));
  }
  assert.ok(!/secret\s+text|secret_hash|signing_key/i.test(migration));
  assert.match(migration, /source text NOT NULL CHECK\(source IN \('server','client-reported'\)\)/);
  assert.match(migrate, /"008_flow_events_webhooks\.sql"/);
  assert.match(grants, /GRANT SELECT, INSERT ON flow_events TO eduos_app;\nREVOKE UPDATE, DELETE, TRUNCATE ON flow_events FROM eduos_app;/);
  assert.match(grants, /REVOKE DELETE, TRUNCATE ON webhook_subscriptions FROM eduos_app;/);
  assert.match(grants, /REVOKE UPDATE, DELETE, TRUNCATE ON webhook_deliveries FROM eduos_app;/);
});

// ---- browser layer wiring ----
test("workspace actions raise flow events and navigation plays transitions", () => {
  for (const type of ["teacher.hired", "teacher.removed", "section.created", "pupil.enrolled", "pupil.unenrolled", "section.full"])
    assert.ok(html.includes(`flowEmit("${type}"`), type);
  assert.match(html, /content\.innerHTML=renderers\[p\]\(\);flowAfterRender\(p,content\);/);
  assert.match(html, /if\(flowPrev!==id\)flowHandoff\(flowPrev,id\)/);
  assert.match(html, /applyWorkspaceSearch\(\);flowDecorateNav\(\);/);
  assert.match(html, /new BroadcastChannel\("eduos-flow"\)/);
  assert.match(html, /window\.addEventListener\("storage",ev=>\{if\(ev\.key===FLOW_KEY\|\|ev\.key===STAFF_KEY\)flowSync\(\)\}\)/);
});
test("transitions respect reduced motion and feed text is escaped", () => {
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)\{#content\.flow-page-in,#content\.flow-persona-in[^}]*animation:none!important\}/);
  assert.match(html, /if\(!flowReduced\(\)\)\{void content\.offsetWidth;content\.classList\.add\(cls\)\}/);
  assert.match(html, /esc\(staff\?e\.staffText:e\.publicText\)/);
  assert.match(html, /code\.textContent=String\(res\.secret\|\|""\)/, "secret is written as text, never as HTML");
});
test("client only publishes to the server for a matching signed-in role and sends no free text", () => {
  assert.match(html, /api\.actor\.role===activePersona&&typeof api\.publishFlowEvent==="function"/);
  assert.match(html, /api\.publishFlowEvent\(\{type,refs:e\.refs,counts:e\.counts\}\)/);
  assert.match(bridge, /async publishFlowEvent\(event\)\{\s*if\(!\["principal","teacher"\]\.includes\(API\.actor\?\.role\)\)/);
  assert.match(bridge, /async createWebhook\(payload\)\{\s*if\(!\["superintendent","it_admin"\]\.includes\(API\.actor\?\.role\)\)/);
  for (const method of ["webhooks", "disableWebhook", "testWebhook"]) {
    const start = bridge.indexOf(`async ${method}(`);
    const body = bridge.slice(start, bridge.indexOf("\n    },", start));
    assert.ok(body.includes('!["superintendent","it_admin"].includes(API.actor?.role)'), `${method} must allow district IT admins`);
  }
});
