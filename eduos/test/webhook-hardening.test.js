// Webhook hardening from the 2026-11-16 code and webhook audit: special-purpose
// addresses, Retry-After, signatures during a signing-key rotation, the
// delivery limiter and the production allowlist rule.
import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { isBlockedAddress, parseRetryAfter, signatureHeader, verifySignature, deliverOnce, deliverWebhook } from "../src/webhooks.js";
import { createLimiter } from "../src/webhook-outbox.js";

test("special-purpose IPv4 and IPv6 ranges are refused; ordinary public addresses aren't", () => {
  for (const a of ["2001:0:4136:e378:8000:63bf:3fff:fdd2" /* Teredo */, "2001::1", "2001:2::1" /* benchmarking */, "2001:10::1", "2001:20::1" /* ORCHID */,
    "2001:1ff::1", "5f00::1" /* SRv6 */, "3fff::1", "3fff:fff::1" /* documentation */, "2620:4f:8000::1" /* AS112 */,
    "192.31.196.1", "192.52.193.9", "192.175.48.6", "::ffff:192.175.48.6"])
    assert.equal(isBlockedAddress(a), true, a);
  for (const a of ["2001:4860:4860::8888", "2606:4700:4700::1111", "2001:200::1", "2620:4f:8001::1", "4000::1", "8.8.8.8", "1.1.1.1", "192.31.197.1"])
    assert.equal(isBlockedAddress(a), false, a);
});

test("Retry-After: seconds or an HTTP date, never negative, at most an hour", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  assert.equal(parseRetryAfter("120", now), 120);
  assert.equal(parseRetryAfter(" 0 ", now), 0);
  assert.equal(parseRetryAfter("99999", now), 3600);
  assert.equal(parseRetryAfter("Mon, 16 Nov 2026 12:05:00 GMT", now), 300);
  assert.equal(parseRetryAfter("Mon, 16 Nov 2026 11:00:00 GMT", now), 0);
  for (const bad of [undefined, "", "soon", "-5", "1.5"]) assert.equal(parseRetryAfter(bad, now), null, String(bad));
});

test("a short Retry-After is waited out in the call; a long one ends the call's retries (the outbox waits instead)", async () => {
  const subscription = { id: "s", url: "https://hooks.example.test/x" };
  const base = { subscription, secret: "s".repeat(40), eventType: "webhook.test", deliveryId: "d", body: "{}" };
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  let waited = [];
  let a = await deliverWebhook({ ...base, options: { lookup, maxAttempts: 3, sleep: async ms => waited.push(ms),
    send: async () => ({ outcome: "http_error", statusCode: 429, retryAfterSeconds: 2, durationMs: 1 }) } });
  assert.equal(a.length, 3); assert.deepEqual(waited, [2000, 2000], "max(backoff, Retry-After)");
  waited = [];
  a = await deliverWebhook({ ...base, options: { lookup, maxAttempts: 3, sleep: async ms => waited.push(ms),
    send: async () => ({ outcome: "http_error", statusCode: 503, retryAfterSeconds: 120, durationMs: 1 }) } });
  assert.equal(a.length, 1); assert.deepEqual(waited, []); assert.equal(a[0].retryAfterSeconds, 120);
});

test("a real HTTP 408 response captures its Retry-After header", async () => {
  const receiver = http.createServer((_req, res) => {
    res.writeHead(408, { "Retry-After": "30" });
    res.end();
  });
  await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve));
  try {
    const result = await deliverOnce({
      url: new URL(`http://127.0.0.1:${receiver.address().port}/hook`),
      address: "127.0.0.1", family: 4, headers: {}, body: "{}"
    });
    assert.deepEqual([result.outcome, result.statusCode, result.retryAfterSeconds], ["http_error", 408, 30]);
  } finally {
    await new Promise((resolve, reject) => receiver.close(error => error ? reject(error) : resolve()));
  }
});

test("HTTP 408 responses are retried as transient failures; permanent 4xx responses are not", async () => {
  const subscription = { id: "s", url: "https://hooks.example.test/x" };
  const base = { subscription, secret: "s".repeat(40), eventType: "webhook.test", deliveryId: "d", body: "{}" };
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const waits = [];
  let calls = 0;
  const attempts = await deliverWebhook({ ...base, options: {
    lookup, maxAttempts: 2, sleep: async ms => waits.push(ms),
    send: async () => (++calls === 1
      ? { outcome: "http_error", statusCode: 408, durationMs: 1 }
      : { outcome: "delivered", statusCode: 204, durationMs: 1 })
  } });
  assert.deepEqual(attempts.map(a => [a.outcome, a.statusCode]), [["http_error", 408], ["delivered", 204]]);
  assert.deepEqual(waits, [400]);
  calls = 0;
  const permanent = await deliverWebhook({ ...base, options: {
    lookup, maxAttempts: 2,
    send: async () => { calls++; return { outcome: "http_error", statusCode: 404, durationMs: 1 }; }
  } });
  assert.equal(calls, 1, "a permanent 404 is not retried");
  assert.equal(permanent.length, 1);
});

test("during a key rotation the header carries one signature per secret and either verifies", () => {
  const body = '{"type":"x"}', t = Math.floor(Date.now() / 1000);
  const header = signatureHeader(["new".padEnd(40, "n"), "old".padEnd(40, "o")], t, body);
  assert.match(header, /^t=\d+,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
  assert.ok(verifySignature("new".padEnd(40, "n"), header, body));
  assert.ok(verifySignature("old".padEnd(40, "o"), header, body));
  assert.ok(!verifySignature("other".padEnd(40, "x"), header, body));
  assert.ok(!verifySignature("new".padEnd(40, "n"), header, body + " "), "tampered body");
  assert.equal(signatureHeader("one".padEnd(40, "1"), t, body).split("v1=").length, 2, "one secret, one signature (unchanged format)");
  const five = `t=${t}` + ",v1=".concat("a".repeat(64)).repeat(5);
  assert.ok(!verifySignature("x", five, body), "at most four signatures are read");
});

test("the delivery limiter never runs more than its limit at once", async () => {
  const limiter = createLimiter(3);
  let now = 0, peak = 0;
  await Promise.all(Array.from({ length: 20 }, () => limiter.run(async () => { now++; peak = Math.max(peak, now); await new Promise(r => setTimeout(r, 5)); now--; })));
  assert.equal(peak, 3); assert.equal(limiter.active, 0); assert.equal(limiter.waiting, 0);
  await assert.rejects(limiter.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(limiter.active, 0, "a failing delivery releases its slot");
});

test("production refuses webhooks with no receiver allowlist unless any public host is chosen explicitly", async () => {
  const { baseEnv } = await import("./integration/harness.js");
  const env = { ...process.env, ...baseEnv({ OIDC_ISSUER: "https://idp.example.org" }), NODE_ENV: "production", DATABASE_URL: "postgres://u:p@db.example.org/eduos",
    DATABASE_SSL: "true", PUBLIC_ORIGIN: "https://eduos.example.org", WEBHOOK_SIGNING_KEY: "k".repeat(40), WEBHOOK_ALLOWED_HOSTS: "", WEBHOOK_ALLOW_ANY_PUBLIC_HOST: "" };
  const load = extra => spawnSync(process.execPath, ["-e", "import('./src/config.js').then(()=>console.log('LOADED'),e=>console.log('ERR '+e.message))"],
    { env: { ...env, ...extra }, encoding: "utf8" }).stdout.trim();
  assert.match(load({}), /^ERR Webhooks are on in production without WEBHOOK_ALLOWED_HOSTS/);
  assert.equal(load({ WEBHOOK_ALLOWED_HOSTS: "hooks.example.org" }), "LOADED");
  assert.equal(load({ WEBHOOK_ALLOW_ANY_PUBLIC_HOST: "true" }), "LOADED");
  assert.equal(load({ WEBHOOK_SIGNING_KEY: "" }), "LOADED", "webhooks off: nothing to allow");
  assert.match(load({ WEBHOOK_ALLOWED_HOSTS: "h.example.org", WEBHOOK_SIGNING_KEY_PREVIOUS: "short" }), /PREVIOUS must be at least 32/);
  assert.match(load({ WEBHOOK_ALLOWED_HOSTS: "h.example.org", WEBHOOK_SIGNING_KEY_PREVIOUS: "k".repeat(40) }), /must differ/);
  assert.equal(load({ WEBHOOK_ALLOWED_HOSTS: "h.example.org", WEBHOOK_SIGNING_KEY_PREVIOUS: "o".repeat(40) }), "LOADED");
});
