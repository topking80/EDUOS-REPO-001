// Signed outbound webhooks for cross-profile flow events.
//
// Security model
//  - Destinations are HTTPS only, carry no embedded credentials, and must
//    resolve exclusively to public addresses. The request is then pinned to the
//    address that was vetted, so a DNS answer cannot change between the check
//    and the connection (rebinding). Redirects are never followed.
//  - Every delivery is signed: X-EduOS-Signature: t=<unix>,v1=<hex HMAC-SHA256
//    of "<t>.<body>">. Receivers should verify it and reject stale timestamps.
//  - Per-subscription secrets are derived from a server-held master key, so no
//    signing secret is ever stored in the database.
//  - This module is pure (no config or database imports) so it can be tested
//    in isolation; the server wires in configuration and persistence.
import crypto from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export const WEBHOOK_MAX_ATTEMPTS = 3;
export const WEBHOOK_TIMEOUT_MS = 5000;
export const WEBHOOK_DNS_TIMEOUT_MS = 3000;
export const WEBHOOK_DISABLE_AFTER_FAILURES = 10;
const MAX_URL_LENGTH = 2048;
const MAX_RESPONSE_BYTES = 64 * 1024;

const blocked = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) blocked.addSubnet(prefix, bits, "ipv4");
for (const [prefix, bits] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  // Forms that embed or translate to an IPv4 address, plus deprecated site-local.
  ["::", 96],            // IPv4-compatible ::a.b.c.d (deprecated)
  // (IPv4-mapped ::ffff:0:0/96 is unwrapped to IPv4 by unwrapMapped(); adding it
  //  here would make Node's BlockList match every IPv4 address.)
  ["::ffff:0:0:0", 96],  // SIIT IPv4-translated ::ffff:0:a.b.c.d
  ["64:ff9b:1::", 48],   // local-use NAT64 (RFC 8215)
  ["2002::", 16],        // 6to4
  ["fec0::", 10]         // site-local (deprecated)
]) blocked.addSubnet(prefix, bits, "ipv6");

const loopback = new net.BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

function unwrapMapped(address) {
  // ::ffff:a.b.c.d and ::ffff:hhhh:hhhh both carry an IPv4 address.
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return address;
}

export function isLoopbackAddress(address) {
  const ip = unwrapMapped(String(address));
  const family = net.isIP(ip);
  return family !== 0 && loopback.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/** True for anything that is not a routable public unicast address. */
export function isBlockedAddress(address) {
  const ip = unwrapMapped(String(address));
  const family = net.isIP(ip);
  if (family === 0) return true;
  return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

const bareHost = hostname => hostname.replace(/^\[|\]$/g, "").toLowerCase();

/**
 * Structural validation of a destination URL (no network access).
 * options.allowInsecureLoopback permits http:// to a loopback literal for
 * local development only; options.allowedHosts optionally pins destinations.
 */
export function validateWebhookUrl(raw, options = {}) {
  const fail = reason => ({ ok: false, reason });
  if (typeof raw !== "string" || raw.length < 12 || raw.length > MAX_URL_LENGTH) return fail("invalid_url");
  if (/[\s\\]/.test(raw)) return fail("invalid_url");
  let url;
  try { url = new URL(raw); } catch { return fail("invalid_url"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") return fail("https_required");
  if (url.username || url.password) return fail("credentials_not_allowed");
  if (url.hash) return fail("fragment_not_allowed");
  const host = bareHost(url.hostname);
  if (!host) return fail("invalid_host");
  const literal = net.isIP(host) !== 0;
  const loopbackTarget = host === "localhost" || (literal && isLoopbackAddress(host));

  if (url.protocol === "http:") {
    if (!(options.allowInsecureLoopback && loopbackTarget)) return fail("https_required");
  } else if (url.protocol !== "https:") {
    return fail("https_required");
  }
  if (loopbackTarget && !options.allowInsecureLoopback) return fail("address_not_allowed");
  if (!loopbackTarget) {
    if (literal && isBlockedAddress(host)) return fail("address_not_allowed");
    if (!literal && (!host.includes(".") || /\.(local|localhost|internal|lan|home|corp|intranet)$/.test(host))) return fail("address_not_allowed");
  }
  if (url.port) {
    const port = Number(url.port);
    if (port !== 443 && port < 1024) return fail("port_not_allowed");
  }
  const allowed = (options.allowedHosts || []).map(h => String(h).toLowerCase()).filter(Boolean);
  if (allowed.length && !loopbackTarget && !allowed.some(h => host === h || host.endsWith("." + h))) return fail("host_not_allowed");
  return { ok: true, url, host, loopbackTarget };
}

/**
 * Resolve the destination and require every answer to be a public address.
 * Returns the single address the delivery must connect to.
 */
export async function resolveWebhookTarget(url, options = {}) {
  const host = bareHost(url.hostname);
  const lookup = options.lookup || ((name, opts) => dns.lookup(name, opts));
  const permitted = address => (options.allowInsecureLoopback && isLoopbackAddress(address)) || !isBlockedAddress(address);
  let answers;
  if (net.isIP(host)) answers = [{ address: host, family: net.isIP(host) }];
  else {
    // DNS is part of the outbound request's security boundary. Bound it so a
    // stalled resolver cannot hold a worker lease indefinitely.
    const timeoutMs = Number.isInteger(options.dnsTimeoutMs) && options.dnsTimeoutMs > 0
      ? Math.min(options.dnsTimeoutMs, 15000) : WEBHOOK_DNS_TIMEOUT_MS;
    let timer;
    try {
      answers = await Promise.race([
        Promise.resolve().then(() => lookup(host, { all: true, verbatim: true })),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("dns_timeout")), timeoutMs);
          timer.unref?.();
        })
      ]);
    } catch (error) {
      return { ok: false, reason: error?.message === "dns_timeout" ? "dns_timeout" : "dns_failure" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (!Array.isArray(answers) || answers.length === 0) return { ok: false, reason: "dns_failure" };
  if (!answers.every(a => a && typeof a.address === "string" && permitted(a.address))) return { ok: false, reason: "address_not_allowed" };
  return { ok: true, address: answers[0].address, family: answers[0].family || net.isIP(answers[0].address) };
}

export function deriveWebhookSecret(masterKey, subscriptionId) {
  if (typeof masterKey !== "string" || masterKey.length < 32) throw new Error("Webhook signing key must be at least 32 characters");
  return "whsec_" + crypto.createHmac("sha256", masterKey).update("eduos-webhook-secret:v1:" + subscriptionId).digest("base64url");
}

export function signPayload(secret, timestamp, body) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function signatureHeader(secret, timestamp, body) {
  return `t=${timestamp},v1=${signPayload(secret, timestamp, body)}`;
}

/** Receiver-side check (also used by the tests): constant-time, with replay window. */
export function verifySignature(secret, header, body, options = {}) {
  if (typeof header !== "string" || header.length > 200) return false;
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
  if (!match) return false;
  const timestamp = Number(match[1]);
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSec ?? 300)) return false;
  const expected = Buffer.from(signPayload(secret, timestamp, body), "hex");
  const supplied = Buffer.from(match[2], "hex");
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

/** One POST to the vetted address. Never follows redirects; body is discarded. */
export function deliverOnce({ url, address, family, headers, body, timeoutMs = WEBHOOK_TIMEOUT_MS }) {
  return new Promise(resolve => {
    const started = Date.now();
    let settled = false;
    const finish = result => { if (!settled) { settled = true; resolve({ ...result, durationMs: Date.now() - started }); } };
    const transport = url.protocol === "https:" ? https : http;
    const pinned = (_hostname, opts, callback) => {
      const cb = typeof opts === "function" ? opts : callback;
      if (opts && opts.all) cb(null, [{ address, family }]); else cb(null, address, family);
    };
    const host = bareHost(url.hostname);
    const request = transport.request({
      protocol: url.protocol, hostname: host, port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search, method: "POST", agent: false, lookup: pinned,
      servername: net.isIP(host) ? undefined : host,
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) }
    }, response => {
      let seen = 0;
      response.on("data", chunk => {
        seen += chunk.length;
        if (seen > MAX_RESPONSE_BYTES) {
          // A truncated 2xx response is not a successful delivery.
          response.destroy(new Error("webhook_response_too_large"));
        }
      });
      response.on("end", () => {
        finish(response.complete ? classify(response.statusCode) : { outcome: "network_error", statusCode: null });
      });
      response.on("aborted", () => finish({ outcome: "network_error", statusCode: null }));
      response.on("close", () => {
        if (!response.complete) finish({ outcome: "network_error", statusCode: null });
      });
      response.on("error", () => finish({ outcome: "network_error", statusCode: null }));
    });
    request.setTimeout(timeoutMs, () => { finish({ outcome: "timeout", statusCode: null }); request.destroy(); });
    request.on("error", () => finish({ outcome: "network_error", statusCode: null }));
    request.end(body);
  });
}

function classify(statusCode) {
  if (statusCode >= 200 && statusCode < 300) return { outcome: "delivered", statusCode };
  return { outcome: "http_error", statusCode };
}

const retryable = result => result.outcome === "timeout" || result.outcome === "network_error" ||
  (result.outcome === "http_error" && (result.statusCode >= 500 || result.statusCode === 429));

/**
 * Sign and deliver one event to one subscription, retrying transient
 * failures. Returns every attempt so the caller can log them.
 */
export async function deliverWebhook({ subscription, secret, eventType, deliveryId, body, options = {} }) {
  const attempts = [];
  const send = options.send || deliverOnce;
  const sleep = options.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const backoff = options.backoffMs || [400, 1600];
  const requestedAttempts = options.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS;
  const maxAttempts = Number.isInteger(requestedAttempts) && requestedAttempts >= 1
    ? Math.min(requestedAttempts, 5) : WEBHOOK_MAX_ATTEMPTS;

  const checked = validateWebhookUrl(subscription.url, options);
  if (!checked.ok) return [{ attempt: 1, outcome: "blocked", statusCode: null, durationMs: 0, reason: checked.reason }];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Re-resolve on every attempt: a destination that starts resolving to a
    // private address is blocked even if it was public when it was registered.
    const target = await resolveWebhookTarget(checked.url, options);
    if (!target.ok) {
      // Resolver outages are transient infrastructure failures, not unsafe
      // destinations. Keep retrying within the bounded attempt budget; only
      // fail-closed policy violations (private/mixed answers, invalid hosts)
      // should permanently block and dead-letter the job.
      const transientDnsFailure = target.reason === "dns_failure" || target.reason === "dns_timeout";
      attempts.push({
        attempt,
        outcome: transientDnsFailure ? "network_error" : "blocked",
        statusCode: null,
        durationMs: 0,
        reason: target.reason
      });
      if (!transientDnsFailure || attempt === maxAttempts) break;
      await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)]);
      continue;
    }
    const timestamp = Math.floor((options.now ? options.now() : Date.now()) / 1000);
    const result = await send({
      url: checked.url, address: target.address, family: target.family, body,
      timeoutMs: options.timeoutMs || WEBHOOK_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "EduOS-Webhooks/1",
        "X-EduOS-Event": eventType,
        "X-EduOS-Delivery": deliveryId,
        "X-EduOS-Timestamp": String(timestamp),
        "X-EduOS-Signature": signatureHeader(secret, timestamp, body)
      }
    });
    attempts.push({ attempt, outcome: result.outcome, statusCode: result.statusCode ?? null, durationMs: result.durationMs ?? 0 });
    if (!retryable(result) || attempt === maxAttempts) break;
    await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)]);
  }
  return attempts;
}
