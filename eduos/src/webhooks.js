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
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  // IANA special-purpose (RFC 6890 registry) not covered above: AS112 and
  // AMT relays, which no webhook receiver lives on.
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.175.48.0", 24]
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
  ["fec0::", 10],        // site-local (deprecated)
  // IANA IPv6 special-purpose registry (2026-11-16 audit): the IETF protocol
  // assignments block, which holds Teredo (2001::/32, embeds an IPv4 address),
  // benchmarking (2001:2::/48), ORCHID (2001:10::/28, 2001:20::/28) and AMT,
  // plus SRv6 SIDs, the AS112 delegation and the new documentation prefix.
  ["2001::", 23],
  ["5f00::", 16],        // segment routing (SRv6) SIDs, RFC 9602
  ["2620:4f:8000::", 48],// AS112 direct delegation, RFC 7534
  ["3fff::", 20]         // documentation, RFC 9637
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
      if (error?.message === "dns_timeout") return { ok: false, reason: "dns_timeout" };
      // ENOTFOUND is the resolver saying the name doesn't exist (NXDOMAIN), for
      // example a misspelled receiver domain. It's still retried, because a
      // misconfigured resolver can answer NXDOMAIN briefly, but the outbox gives
      // up on it sooner than on an outage (src/webhook-outbox.js).
      return { ok: false, reason: error?.code === "ENOTFOUND" ? "dns_not_found" : "dns_failure" };
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

/**
 * X-EduOS-Signature: t=<unix>,v1=<hmac>[,v1=<hmac>]. With several secrets
 * (a signing-key rotation in progress: the current secret first, then the
 * previous one) the header carries one v1 per secret, so a receiver still
 * holding the old secret keeps verifying until it switches.
 */
export function signatureHeader(secrets, timestamp, body) {
  const list = (Array.isArray(secrets) ? secrets : [secrets]).filter(Boolean);
  return `t=${timestamp},` + list.map(secret => `v1=${signPayload(secret, timestamp, body)}`).join(",");
}

/** Receiver-side check (also used by the tests): constant-time, with replay window; any v1 may match. */
export function verifySignature(secret, header, body, options = {}) {
  if (typeof header !== "string" || header.length > 400) return false;
  const match = /^t=(\d{1,12})((?:,v1=[0-9a-f]{64}){1,4})$/.exec(header);
  if (!match) return false;
  const timestamp = Number(match[1]);
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSec ?? 300)) return false;
  const expected = Buffer.from(signPayload(secret, timestamp, body), "hex");
  let ok = false;
  for (const sig of match[2].slice(1).split(",")) {
    const supplied = Buffer.from(sig.slice(3), "hex");
    // Compare every candidate (no early exit) so timing doesn't reveal which matched.
    if (expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied)) ok = true;
  }
  return ok;
}

/**
 * Seconds a receiver asked us to wait (Retry-After: delta-seconds or an
 * HTTP date), or null. Capped at an hour; a date in the past means now.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  let seconds;
  if (/^\d{1,10}$/.test(v)) seconds = Number(v);
  else {
    if (!/^[A-Za-z]{3}, /.test(v)) return null; // an HTTP-date starts with the weekday
    const at = Date.parse(v);
    if (Number.isNaN(at)) return null;
    seconds = Math.ceil((at - now) / 1000);
  }
  return Math.max(0, Math.min(3600, seconds));
}

/**
 * One POST to the vetted address. Never follows redirects; body is discarded.
 *
 * timeoutMs is an ABSOLUTE deadline for the whole exchange (connect, send,
 * headers and body), not an idle timer: a receiver that trickles a byte at a
 * time can't keep the socket open past it (2026-11-17 audit, finding 1). An
 * AbortSignal (the outbox's job deadline) destroys the socket the same way.
 * The promise settles only after the request has been destroyed.
 */
export function deliverOnce({ url, address, family, headers, body, timeoutMs = WEBHOOK_TIMEOUT_MS, signal = null }) {
  return new Promise(resolve => {
    const started = Date.now();
    let settled = false, request = null, deadline = null;
    const onAbort = () => { finish({ outcome: "timeout", statusCode: null, reason: "job_deadline" }); };
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener?.("abort", onAbort);
      // Tear the connection down before reporting, so a slot freed by this
      // result never coexists with a still-open socket.
      if (result.outcome !== "delivered" && result.outcome !== "http_error") request?.destroy();
      resolve({ ...result, durationMs: Date.now() - started });
    };
    if (signal?.aborted) return finish({ outcome: "timeout", statusCode: null, reason: "job_deadline" });
    const transport = url.protocol === "https:" ? https : http;
    const pinned = (_hostname, opts, callback) => {
      const cb = typeof opts === "function" ? opts : callback;
      if (opts && opts.all) cb(null, [{ address, family }]); else cb(null, address, family);
    };
    const host = bareHost(url.hostname);
    request = transport.request({
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
        if (!response.complete) return finish({ outcome: "network_error", statusCode: null });
        const result = classify(response.statusCode);
        if (response.statusCode === 429 || response.statusCode === 503) {
          const retryAfter = parseRetryAfter(response.headers["retry-after"]);
          if (retryAfter !== null) result.retryAfterSeconds = retryAfter;
        }
        finish(result);
      });
      response.on("aborted", () => finish({ outcome: "network_error", statusCode: null }));
      response.on("close", () => {
        if (!response.complete) finish({ outcome: "network_error", statusCode: null });
      });
      response.on("error", () => finish({ outcome: "network_error", statusCode: null }));
    });
    request.setTimeout(timeoutMs, () => finish({ outcome: "timeout", statusCode: null }));
    deadline = setTimeout(() => finish({ outcome: "timeout", statusCode: null }), timeoutMs);
    signal?.addEventListener?.("abort", onAbort, { once: true });
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
export async function deliverWebhook({ subscription, secret, secrets, eventType, deliveryId, body, options = {} }) {
  const signingSecrets = (secrets && secrets.length ? secrets : [secret]).filter(Boolean);
  // A receiver's Retry-After longer than this ends in-call retries (the
  // outbox waits for it instead, see src/webhook-outbox.js).
  const maxInlineWaitMs = options.maxInlineWaitMs ?? 5000;
  const attempts = [];
  const send = options.send || deliverOnce;
  const sleep = options.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const backoff = options.backoffMs || [400, 1600];
  const requestedAttempts = options.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS;
  const maxAttempts = Number.isInteger(requestedAttempts) && requestedAttempts >= 1
    ? Math.min(requestedAttempts, 5) : WEBHOOK_MAX_ATTEMPTS;

  const checked = validateWebhookUrl(subscription.url, options);
  if (!checked.ok) return [{ attempt: 1, outcome: "blocked", statusCode: null, durationMs: 0, reason: checked.reason }];

  const signal = options.signal || null;
  const cutOff = attempt => ({ attempt, outcome: "timeout", statusCode: null, durationMs: 0, reason: "job_deadline" });
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) { attempts.push(cutOff(attempt)); break; }
    // Re-resolve on every attempt: a destination that starts resolving to a
    // private address is blocked even if it was public when it was registered.
    const target = await resolveWebhookTarget(checked.url, options);
    if (!target.ok) {
      // Resolver outages are transient infrastructure failures, not unsafe
      // destinations. Keep retrying within the bounded attempt budget; only
      // fail-closed policy violations (private/mixed answers, invalid hosts)
      // should permanently block and dead-letter the job.
      const transientDnsFailure = target.reason === "dns_failure" || target.reason === "dns_timeout" || target.reason === "dns_not_found";
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
    if (signal?.aborted) { attempts.push(cutOff(attempt)); break; }
    const timestamp = Math.floor((options.now ? options.now() : Date.now()) / 1000);
    const result = await send({
      signal,
      url: checked.url, address: target.address, family: target.family, body,
      timeoutMs: options.timeoutMs || WEBHOOK_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "EduOS-Webhooks/1",
        "X-EduOS-Event": eventType,
        "X-EduOS-Delivery": deliveryId,
        "X-EduOS-Timestamp": String(timestamp),
        "X-EduOS-Signature": signatureHeader(signingSecrets, timestamp, body)
      }
    });
    attempts.push({ attempt, outcome: result.outcome, statusCode: result.statusCode ?? null, durationMs: result.durationMs ?? 0,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(Number.isFinite(result.retryAfterSeconds) ? { retryAfterSeconds: result.retryAfterSeconds } : {}) });
    if (!retryable(result) || attempt === maxAttempts) break;
    const wait = Math.max(backoff[Math.min(attempt - 1, backoff.length - 1)], (result.retryAfterSeconds ?? 0) * 1000);
    if (wait > maxInlineWaitMs) break;
    await sleep(wait);
  }
  return attempts;
}
