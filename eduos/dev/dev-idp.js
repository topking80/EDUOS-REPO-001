// EduOS local development OpenID Connect provider (32.1.0).
//
// LOCAL EVALUATION ONLY. It signs in anyone who clicks a name, so:
//  - it refuses to start when NODE_ENV=production;
//  - its discovery document carries "eduos_dev_idp": true, and the EduOS API
//    refuses such a provider when NODE_ENV=production (src/oidc.js);
//  - it ships only in the "devtools" image target, never in the "app" image.
//
// It implements the subset of OIDC that EduOS uses: authorization code flow
// with PKCE (S256), client_secret_post, RS256 ID tokens with nonce, and JWKS.
// The browser-facing authorize URL (DEV_IDP_PUBLIC_URL) may differ from the
// issuer the API reaches over the container network (DEV_IDP_ISSUER).
import crypto from "node:crypto";
import http from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { demoAccounts } from "./demo-fixture.js";

const env = process.env;
if ((env.NODE_ENV || "development") === "production") {
  console.error("dev-idp: refusing to start with NODE_ENV=production (local evaluation only)");
  process.exit(1);
}
const PORT = Number(env.PORT || 9400);
const ISSUER = (env.DEV_IDP_ISSUER || `http://localhost:${PORT}`).replace(/\/$/, "");
const PUBLIC_URL = (env.DEV_IDP_PUBLIC_URL || ISSUER).replace(/\/$/, "");
const CLIENT_ID = env.DEV_IDP_CLIENT_ID || "";
const CLIENT_SECRET = env.DEV_IDP_CLIENT_SECRET || "";
const REDIRECT_URIS = (env.DEV_IDP_REDIRECT_URIS || "").split(",").map(x => x.trim()).filter(Boolean);
if (!CLIENT_ID || CLIENT_SECRET.length < 16 || !REDIRECT_URIS.length) {
  console.error("dev-idp: DEV_IDP_CLIENT_ID, DEV_IDP_CLIENT_SECRET (16+ chars) and DEV_IDP_REDIRECT_URIS are required");
  process.exit(1);
}

const { publicKey, privateKey } = await generateKeyPair("RS256");
const kid = crypto.randomBytes(8).toString("hex");
const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
const codes = new Map(); // code -> { sub, name, email, nonce, challenge, redirectUri, exp }
const CODE_TTL_MS = 60_000;
const SUBJECT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sha256b64url = v => crypto.createHash("sha256").update(v).digest("base64url");
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function send(res, status, body, type = "application/json", extra = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action *; frame-ancestors 'none'", ...extra });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
async function readForm(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 16_384) throw new Error("body too large"); }
  return Object.fromEntries(new URLSearchParams(raw));
}
function validateAuthorize(p) {
  if (p.response_type !== "code") return "unsupported_response_type";
  if (p.client_id !== CLIENT_ID) return "unknown client_id";
  if (!REDIRECT_URIS.includes(p.redirect_uri)) return "redirect_uri is not registered";
  if (p.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge || "")) return "PKCE S256 is required";
  if (!p.state || !p.nonce) return "state and nonce are required";
  if (!String(p.scope || "").split(" ").includes("openid")) return "scope must include openid";
  return null;
}
const PASS = ["response_type", "client_id", "redirect_uri", "scope", "state", "nonce", "code_challenge", "code_challenge_method"];

function loginPage(params) {
  const hidden = PASS.map(k => `<input type="hidden" name="${k}" value="${esc(params[k])}">`).join("");
  const groups = {};
  for (const a of demoAccounts()) (groups[a.role] ||= []).push(a);
  const order = ["superintendent", "it_admin", "principal", "teacher", "parent", "pupil", "driver"];
  const label = { superintendent: "District leadership", it_admin: "District IT", principal: "Principals", teacher: "Teachers", parent: "Parents and guardians", pupil: "Students", driver: "Transport (32.4.0 mobile app)" };
  const cards = order.filter(r => groups[r]).map(r => `<h2>${label[r]}</h2><div class="grid">${groups[r].map(a =>
    `<form method="post" action="/authorize/approve">${hidden}<input type="hidden" name="sub" value="${esc(a.sub)}">
      <button type="submit" data-sub="${esc(a.sub)}"><b>${esc(a.name)}</b><span>${esc(a.role)} · ${esc(a.school)}</span>${a.note ? `<small>${esc(a.note)}</small>` : ""}</button></form>`).join("")}</div>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EduOS local sign-in (development only)</title><style>
body{margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#eef3f8;color:#15263a}
.warn{background:#7a3e00;color:#fff;font-weight:700;text-align:center;padding:8px 12px}
main{max-width:980px;margin:0 auto;padding:22px}h1{font-size:22px;margin:6px 0}h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:#36608c;margin:20px 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}form{margin:0}
button{width:100%;text-align:left;border:1px solid #cfdbe7;background:#fff;border-radius:10px;padding:12px 14px;cursor:pointer;font:inherit;color:inherit}
button:hover{border-color:#3f86c8;box-shadow:0 4px 14px #1b3a5a1a}button b{display:block;font-size:15px}button span{display:block;color:#4d6680;font-size:12px}
button small{display:block;color:#7a5a1c;font-size:11px;margin-top:4px}fieldset{border:1px solid #cfdbe7;border-radius:10px;background:#fff;padding:12px 14px;margin-top:20px}
input[type=text],input[type=email]{padding:8px;border:1px solid #c7d4e2;border-radius:8px;margin:4px 8px 4px 0;font:inherit}
.custom button{width:auto;display:inline-block;padding:8px 14px;background:#113155;color:#fff}</style></head><body>
<div class="warn" role="note">Local development identity provider. Anyone can sign in as anyone. Never use in production.</div>
<main><h1>Sign in to EduOS (local evaluation)</h1><p>Choose a synthetic demo account. EduOS still performs the full OpenID Connect
code flow (PKCE, nonce, signed ID token), and only accounts provisioned in EduOS can sign in.</p>${cards}
<fieldset class="custom"><legend>Another provisioned account</legend><form method="post" action="/authorize/approve">${hidden}
<label>Subject <input type="text" name="sub" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" placeholder="e.g. new-teacher"></label>
<label>Name <input type="text" name="name" maxlength="120"></label><label>Email <input type="email" name="email" maxlength="320"></label>
<button type="submit">Sign in</button></form><p><small>Use the subject an administrator entered when creating the user in EduOS.</small></p></fieldset></main></body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, PUBLIC_URL);
    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return send(res, 200, {
        issuer: ISSUER, authorization_endpoint: `${PUBLIC_URL}/authorize`, token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`, response_types_supported: ["code"], subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"], scopes_supported: ["openid", "profile", "email"],
        eduos_dev_idp: true
      });
    }
    if (req.method === "GET" && url.pathname === "/jwks") return send(res, 200, { keys: [jwk] });
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok", devOnly: true });
    if (req.method === "GET" && url.pathname === "/accounts") return send(res, 200, { data: demoAccounts() });
    if (req.method === "GET" && url.pathname === "/authorize") {
      const p = Object.fromEntries(url.searchParams);
      const problem = validateAuthorize(p);
      if (problem) return send(res, 400, `<p>Invalid authorization request: ${esc(problem)}</p>`, "text/html; charset=utf-8");
      return send(res, 200, loginPage(p), "text/html; charset=utf-8");
    }
    if (req.method === "POST" && url.pathname === "/authorize/approve") {
      const p = await readForm(req);
      const problem = validateAuthorize(p);
      if (problem || !SUBJECT_RE.test(p.sub || "")) return send(res, 400, `<p>Invalid sign-in: ${esc(problem || "subject")}</p>`, "text/html; charset=utf-8");
      const known = demoAccounts().find(a => a.sub === p.sub);
      const name = known?.name || String(p.name || p.sub).slice(0, 120);
      const email = known?.email || (String(p.email || "").trim().toLowerCase().slice(0, 320) || undefined);
      const code = crypto.randomBytes(32).toString("base64url");
      codes.set(code, { sub: p.sub, name, email, nonce: p.nonce, challenge: p.code_challenge, redirectUri: p.redirect_uri, exp: Date.now() + CODE_TTL_MS });
      const back = new URL(p.redirect_uri);
      back.searchParams.set("code", code); back.searchParams.set("state", p.state);
      res.writeHead(302, { location: back.toString(), "cache-control": "no-store" });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const p = await readForm(req);
      const entry = codes.get(p.code || "");
      codes.delete(p.code || "");
      if (p.grant_type !== "authorization_code") return send(res, 400, { error: "unsupported_grant_type" });
      if (p.client_id !== CLIENT_ID || !safeEqual(p.client_secret || "", CLIENT_SECRET)) return send(res, 401, { error: "invalid_client" });
      if (!entry || entry.exp < Date.now() || entry.redirectUri !== p.redirect_uri ||
          !safeEqual(sha256b64url(p.code_verifier || ""), entry.challenge)) return send(res, 400, { error: "invalid_grant" });
      const claims = { nonce: entry.nonce, name: entry.name };
      if (entry.email) Object.assign(claims, { email: entry.email, email_verified: true });
      const idToken = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(ISSUER).setAudience(CLIENT_ID).setSubject(entry.sub).setIssuedAt().setExpirationTime("5m").sign(privateKey);
      return send(res, 200, { access_token: crypto.randomBytes(24).toString("base64url"), token_type: "Bearer", expires_in: 300, id_token: idToken });
    }
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 400, { error: "bad_request", message: error.message });
  }
});
setInterval(() => { const now = Date.now(); for (const [k, v] of codes) if (v.exp < now) codes.delete(k); }, 30_000).unref();
server.listen(PORT, env.DEV_IDP_BIND || "0.0.0.0", () =>
  console.log(`dev-idp (LOCAL DEVELOPMENT ONLY) issuer=${ISSUER} authorize=${PUBLIC_URL}/authorize`));
