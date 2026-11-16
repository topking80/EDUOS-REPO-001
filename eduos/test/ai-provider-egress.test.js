import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAiProviderUrl } from "../src/ai/provider-egress.js";
import { resolveWebhookTarget } from "../src/webhooks.js";

test("AI provider URLs require an explicit approved host and clean HTTPS origin", () => {
  assert.equal(validateAiProviderUrl("https://api.vendor.example", []).reason, "ai_provider_allowlist_required");
  assert.equal(validateAiProviderUrl("https://api.vendor.example", ["vendor.example"]).ok, true);
  assert.equal(validateAiProviderUrl("http://127.0.0.1:8080/v1", ["127.0.0.1"]).ok, false);
  assert.equal(validateAiProviderUrl("http://127.0.0.1:8080/v1", ["127.0.0.1"], { allowInsecureLoopback: true }).ok, true);
  assert.equal(validateAiProviderUrl("http://10.0.0.8:8080/v1", ["10.0.0.8"], { allowInsecureLoopback: true }).ok, false);
  for (const url of [
    "http://api.vendor.example", "https://user:secret@api.vendor.example",
    "https://127.0.0.1", "https://localhost", "https://api.vendor.example?token=secret", "https://not-approved.example"
  ]) assert.equal(validateAiProviderUrl(url, ["vendor.example"]).ok, false, url);
});

test("DNS resolution rejects mixed public/private answers and all special address classes", async () => {
  const url = new URL("https://api.vendor.example");
  for (const address of ["127.0.0.1", "10.2.3.4", "169.254.1.1", "192.168.1.5", "::1", "fc00::1", "fe80::1", "2001:db8::1"]) {
    const result = await resolveWebhookTarget(url, { lookup: async () => [{ address: "1.1.1.1", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }] });
    assert.equal(result.ok, false, address);
    assert.equal(result.reason, "address_not_allowed", address);
  }
  const publicOnly = await resolveWebhookTarget(url, { lookup: async () => [{ address: "1.1.1.1", family: 4 }, { address: "8.8.8.8", family: 4 }] });
  assert.equal(publicOnly.ok, true);
  assert.equal(publicOnly.address, "1.1.1.1");
});

test("DNS lookup failure fails closed", async () => {
  const result = await resolveWebhookTarget(new URL("https://api.vendor.example"), { lookup: async () => { throw Object.assign(new Error("no DNS"), { code: "ENOTFOUND" }); } });
  assert.deepEqual(result, { ok: false, reason: "dns_not_found" });
});
