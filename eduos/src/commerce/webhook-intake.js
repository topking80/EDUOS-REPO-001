// EduOS 37.8.0: public, signature-verified commerce webhook intake.
// This module verifies provider authenticity and durably records matching
// notifications. It deliberately does NOT settle payments or change tickets.
import { createHash } from "node:crypto";
import { pool } from "../db.js";
import { config } from "../config.js";
import { request } from "../integrations/http.js";
import { validateWebhookUrl } from "../webhooks.js";
import { PROCESSORS } from "./catalog.js";
import { ADAPTERS, ProviderError } from "./adapters.js";
import { openSecrets } from "./secrets.js";
import { normalizeVerifiedPaymentEvent } from "./webhook-events.js";

const digest = token => createHash("sha256").update(token, "utf8").digest("hex");
const fail = (status, code) => Object.assign(new Error(code), { status, code });

async function providerAdapter(account) {
  const { processor, mode, config: cfg = {}, secrets_enc: sealed } = account;
  if (!Object.hasOwn(PROCESSORS, processor) || processor === "sandbox") throw fail(404, "endpoint_not_found");
  if (!config.commerceSecretsKey) throw fail(503, "webhook_verification_unavailable");
  let secrets;
  try { secrets = openSecrets(config.commerceSecretsKey, account.district_id, processor, sealed); }
  catch { throw fail(503, "webhook_verification_unavailable"); }

  let base, allowedHosts;
  if (processor === "btcpay") {
    const checked = validateWebhookUrl(String(cfg.serverUrl || ""), { allowedHosts: config.commerceAllowedHosts });
    if (!checked.ok || checked.url.protocol !== "https:" || !config.commerceAllowedHosts.length)
      throw fail(503, "webhook_verification_unavailable");
    base = checked.url.origin + checked.url.pathname.replace(/\\/+$/, "");
    allowedHosts = config.commerceAllowedHosts;
  } else {
    const host = PROCESSORS[processor].hosts[mode];
    if (!host) throw fail(503, "webhook_verification_unavailable");
    base = `https://${host}`;
    allowedHosts = [host];
  }
  const transport = async (url, options) => request(url, {
    method: options.method, headers: options.headers, body: options.body,
    options: { allowedHosts: config.commerceTestApiBase ? [] : options.allowedHosts,
      allowInsecureLoopback: Boolean(config.commerceTestApiBase), timeoutMs: 15_000 }
  });
  try {
    return ADAPTERS[processor]({ mode, ...cfg, ...secrets,
      fee: { bps: account.fee_bps, fixedCents: account.fee_fixed_cents },
      transport, base: config.commerceTestApiBase ? `${config.commerceTestApiBase}/${processor}` : base,
      allowedHosts: config.commerceTestApiBase ? [] : allowedHosts });
  } catch { throw fail(503, "webhook_verification_unavailable"); }
}

/**
 * Token is an opaque bearer credential. No district or provider is accepted
 * from the payload; the SECURITY DEFINER resolver supplies that identity.
 */
export async function receiveCommerceWebhook({ processor, token, headers, rawBody, body }) {
  if (!Object.hasOwn(PROCESSORS, processor) || processor === "sandbox"
    || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)
    || !Buffer.isBuffer(rawBody) || rawBody.length === 0 || !body || typeof body !== "object" || Array.isArray(body))
    throw fail(404, "endpoint_not_found");

  const resolved = await pool.query("SELECT * FROM eduos_commerce_webhook_account($1)", [digest(token)]);
  const account = resolved.rows[0];
  if (!account || account.processor !== processor) throw fail(404, "endpoint_not_found");

  let adapter;
  try { adapter = await providerAdapter(account); }
  catch (e) { if (e.status) throw e; throw fail(503, "webhook_verification_unavailable"); }

  let verified = false;
  try { verified = await adapter.verifyWebhook({ headers, rawBody }); }
  catch (e) {
    if (e instanceof ProviderError || e?.code) throw fail(503, "webhook_verification_unavailable");
    throw fail(503, "webhook_verification_unavailable");
  }
  if (verified !== true) throw fail(401, "invalid_webhook_signature");

  const event = normalizeVerifiedPaymentEvent(processor, body);
  if (!event) throw fail(400, "invalid_webhook_event");
  // Non-payment and non-final events are acknowledged but never persisted as
  // settlement work. This prevents provider retry storms for harmless notices.
  if (event.disposition === "ignored") return { outcome: "ignored" };

  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  // The payment table's ordinary RLS policy intentionally requires a payer or
  // district administrator. Public callbacks have no user identity, so this
  // narrow SECURITY DEFINER function performs the exact match + inbox insert.
  const saved = await pool.query(
    "SELECT eduos_commerce_receive_webhook($1,$2,$3,$4,$5,$6,$7,$8,$9) AS outcome",
    [digest(token), processor, event.providerEventId, event.eventType, payloadHash,
      event.providerRef, event.captureRef, event.amountCents, event.currency]
  );
  const outcome = saved.rows[0]?.outcome;
  if (outcome === "endpoint_not_found") throw fail(404, "endpoint_not_found");
  if (!["received", "unmatched", "duplicate", "event_id_conflict"].includes(outcome))
    throw fail(503, "webhook_verification_unavailable");
  return { outcome };
}

export function webhookHttpStatus(error) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 503;
}
