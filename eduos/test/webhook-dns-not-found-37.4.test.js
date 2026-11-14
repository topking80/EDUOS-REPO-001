// A receiver domain that doesn't exist (NXDOMAIN) is classified separately from
// resolver outages, so the outbox can stop retrying it sooner.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveWebhookTarget, deliverWebhook, deriveWebhookSecret } from "../src/webhooks.js";
import { DNS_NOT_FOUND_MAX_ATTEMPTS } from "../src/webhook-outbox.js";

const url = new URL("https://hooks.example.test/events");
const dnsError = code => Object.assign(new Error(`getaddrinfo ${code} hooks.example.test`), { code });

test("NXDOMAIN is dns_not_found; resolver errors stay dns_failure (timeouts: phase33 test)", async () => {
  assert.equal((await resolveWebhookTarget(url, { lookup: async () => { throw dnsError("ENOTFOUND"); } })).reason, "dns_not_found");
  for (const code of ["EAI_AGAIN", "ESERVFAIL", "ECONNREFUSED", undefined])
    assert.equal((await resolveWebhookTarget(url, { lookup: async () => { throw dnsError(code); } })).reason, "dns_failure", String(code));
  assert.equal((await resolveWebhookTarget(url, { lookup: async () => [] })).reason, "dns_failure", "an empty answer is not proof the name is gone");
});

test("NXDOMAIN is retried as a network error within one delivery, never sent", async () => {
  let lookups = 0;
  const attempts = await deliverWebhook({
    subscription: { id: "sub-nx", url: url.href }, secret: deriveWebhookSecret("k".repeat(40), "sub-nx"),
    eventType: "pupil.enrolled", deliveryId: "delivery-nx", body: "{}",
    options: { lookup: async () => { lookups += 1; throw dnsError("ENOTFOUND"); }, send: async () => { throw new Error("must not send"); },
      sleep: async () => {}, maxAttempts: 3 }
  });
  assert.deepEqual(attempts.map(a => [a.outcome, a.reason]), [["network_error", "dns_not_found"], ["network_error", "dns_not_found"], ["network_error", "dns_not_found"]]);
  assert.equal(lookups, 3);
});

test("the outbox gives a missing domain one retry", () => {
  assert.equal(DNS_NOT_FOUND_MAX_ATTEMPTS, 2);
});
