// External AI egress: validate the configured origin, resolve every DNS
// answer, reject any non-public address, then connect to the vetted address.
// TLS SNI/certificate verification still use the configured hostname.
import dns from "node:dns/promises";
import https from "node:https";
import http from "node:http";
import net from "node:net";
import { validateWebhookUrl, resolveWebhookTarget } from "../webhooks.js";

export function validateAiProviderUrl(raw, allowedHosts = [], { allowInsecureLoopback = false } = {}) {
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0)
    return { ok: false, reason: "ai_provider_allowlist_required" };
  const checked = validateWebhookUrl(raw, { allowedHosts, allowInsecureLoopback });
  if (!checked.ok) return checked;
  if (checked.url.protocol !== "https:" && !(allowInsecureLoopback && checked.loopbackTarget && checked.url.protocol === "http:"))
    return { ok: false, reason: "https_required" };
  if (checked.url.search)
    return { ok: false, reason: "provider_url_query_not_allowed" };
  return checked;
}

export async function postAiProviderJson({ url, allowedHosts, headers, body, timeoutMs, lookup = dns.lookup, allowInsecureLoopback = false }) {
  const checked = validateAiProviderUrl(url, allowedHosts, { allowInsecureLoopback });
  if (!checked.ok) throw new Error(`AI provider destination blocked: ${checked.reason}`);
  const target = await resolveWebhookTarget(checked.url, { lookup, dnsTimeoutMs: Math.min(timeoutMs, 5000), allowInsecureLoopback });
  if (!target.ok) throw new Error(`AI provider DNS blocked: ${target.reason}`);
  const host = checked.host;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const pinnedLookup = (_hostname, options, callback) => {
      const cb = typeof options === "function" ? options : callback;
      if (options && options.all) cb(null, [{ address: target.address, family: target.family }]);
      else cb(null, target.address, target.family);
    };
    const transport = checked.url.protocol === "https:" ? https : http;
    const request = transport.request({
      protocol: checked.url.protocol, hostname: host, port: checked.url.port || (checked.url.protocol === "https:" ? 443 : 80),
      path: `${checked.url.pathname.replace(/\/+$/, "")}/chat/completions`, method: "POST", agent: false,
      lookup: pinnedLookup, ...(checked.url.protocol === "https:" && !net.isIP(host) ? { servername: host } : {}),
      headers: { ...headers, "content-length": Buffer.byteLength(body) },
    }, response => {
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) response.destroy(new Error("AI provider response exceeds 1 MiB"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode >= 300 && response.statusCode < 400)
          return reject(new Error("AI provider redirects are not allowed"));
        const raw = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300)
          return reject(new Error(`AI provider HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(raw)); } catch { reject(new Error("AI provider returned invalid JSON")); }
      });
      response.on("aborted", () => reject(new Error("AI provider response aborted")));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("AI provider request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}
