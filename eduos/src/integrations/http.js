// Outbound HTTP for connectors, with the same destination rules as webhooks
// (src/webhooks.js): HTTPS only, public addresses only (checked after DNS and
// pinned for the connection), optional host allowlist, no redirects, bounded
// time and size. Only GETs of roster data and the OAuth token request.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { validateWebhookUrl, resolveWebhookTarget } from "../webhooks.js";

export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const TIMEOUT_MS = 30_000;

export class IntegrationError extends Error {
  constructor(code, detail = null) { super(code); this.code = code; this.detail = detail; }
}

export function checkUrl(raw, options) {
  const v = validateWebhookUrl(raw, options);
  if (!v.ok) throw new IntegrationError("connector_url_not_allowed", v.reason);
  return v.url;
}

async function request(raw, { method = "GET", headers = {}, body = null, options = {} }) {
  const url = checkUrl(raw, options);
  const target = await resolveWebhookTarget(url, options);
  if (!target.ok) throw new IntegrationError(target.reason === "address_not_allowed" ? "connector_url_not_allowed" : "connector_unreachable", target.reason);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const pinned = (_h, o, cb) => { const done = typeof o === "function" ? o : cb; if (o && o.all) done(null, [{ address: target.address, family: target.family }]); else done(null, target.address, target.family); };
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request({
      protocol: url.protocol, hostname: host, port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search, method, agent: false, lookup: pinned, servername: net.isIP(host) ? undefined : host,
      headers: { accept: "application/json", "user-agent": "EduOS-Integrations/1", ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) },
      timeout: options.timeoutMs || TIMEOUT_MS,
    }, (res) => {
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > MAX_RESPONSE_BYTES) { req.destroy(new IntegrationError("connector_response_too_large")); return; } chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new IntegrationError("connector_timeout")));
    req.on("error", (e) => reject(e instanceof IntegrationError ? e : new IntegrationError("connector_unreachable", e.code || null)));
    if (body) req.write(body);
    req.end();
  });
}

const parse = (r, what) => {
  if (r.status === 401 || r.status === 403) throw new IntegrationError("connector_auth_failed", `${what}: HTTP ${r.status}`);
  if (r.status < 200 || r.status > 299) throw new IntegrationError("connector_http_error", `${what}: HTTP ${r.status}`);
  try { return JSON.parse(r.text); } catch { throw new IntegrationError("connector_bad_response", `${what}: not JSON`); }
};

/** OAuth 2.0 client credentials (HTTP Basic client authentication). Returns the access token. */
export async function clientCredentialsToken({ tokenUrl, clientId, clientSecret, scope, options }) {
  const form = new URLSearchParams({ grant_type: "client_credentials", ...(scope ? { scope } : {}) }).toString();
  const basic = Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64");
  const r = await request(tokenUrl, { method: "POST", body: form, options,
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" } });
  const j = parse(r, "token");
  if (typeof j?.access_token !== "string" || !j.access_token) throw new IntegrationError("connector_auth_failed", "token: no access_token");
  return j.access_token;
}

export async function getJson(url, token, options) {
  return parse(await request(url, { headers: { authorization: `Bearer ${token}` }, options }), new URL(url).pathname.split("/").pop());
}
