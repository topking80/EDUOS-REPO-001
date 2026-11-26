// Master Control's own OIDC client (authorization code + PKCE). Separate from
// EduOS's sign-in: a different issuer configuration and client, and only
// operators registered in Master Control can sign in.
import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

export const randomSecret = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = v => crypto.createHash("sha256").update(v).digest("hex");

/**
 * One OIDC client for one trusted provider:
 * {issuer, clientId, clientSecret, scopes, redirectUri, timeoutMs, nodeEnv}.
 */
export function createOidc(p) {
  const cfg = { oidcIssuer: p.issuer.replace(/\/$/, ""), oidcClientId: p.clientId, oidcClientSecret: p.clientSecret, oidcScopes: p.scopes,
    oidcRedirectUri: p.redirectUri, oidcHttpTimeoutMs: p.timeoutMs, nodeEnv: p.nodeEnv };
  let meta = null, jwks = null;
  async function metadata() {
    if (meta) return meta;
    const res = await fetch(`${cfg.oidcIssuer}/.well-known/openid-configuration`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(cfg.oidcHttpTimeoutMs) });
    if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
    const d = await res.json();
    if (String(d?.issuer || "").replace(/\/$/, "") !== cfg.oidcIssuer) throw new Error("OIDC issuer mismatch");
    if (d.eduos_dev_idp === true && cfg.nodeEnv === "production") throw new Error("Refusing the development OIDC provider in production");
    if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) throw new Error("OIDC provider metadata is incomplete");
    jwks = createRemoteJWKSet(new URL(d.jwks_uri), { timeoutDuration: cfg.oidcHttpTimeoutMs });
    meta = d;
    return meta;
  }
  return {
    metadata,
    async authorizationUrl({ state, nonce, verifier }) {
      const m = await metadata();
      const url = new URL(m.authorization_endpoint);
      url.search = new URLSearchParams({ response_type: "code", client_id: cfg.oidcClientId, redirect_uri: cfg.oidcRedirectUri,
        scope: cfg.oidcScopes.join(" "), state, nonce, code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256" }).toString();
      return url.toString();
    },
    async exchange(code, verifier, nonce) {
      const m = await metadata();
      const res = await fetch(m.token_endpoint, { method: "POST", signal: AbortSignal.timeout(cfg.oidcHttpTimeoutMs),
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: cfg.oidcRedirectUri,
          client_id: cfg.oidcClientId, client_secret: cfg.oidcClientSecret, code_verifier: verifier }) });
      if (!res.ok) throw Object.assign(new Error("token exchange failed"), { status: 401 });
      const tokens = await res.json();
      if (!tokens.id_token) throw Object.assign(new Error("no ID token"), { status: 401 });
      const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: m.issuer, audience: cfg.oidcClientId, algorithms: ["RS256", "ES256"] });
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if ((aud.length > 1 || payload.azp !== undefined) && payload.azp !== cfg.oidcClientId) throw new Error("OIDC authorized-party mismatch");
      if (payload.nonce !== nonce) throw new Error("OIDC nonce mismatch");
      if (typeof payload.sub !== "string" || !payload.sub) throw new Error("OIDC subject is missing");
      return { issuer: m.issuer.replace(/\/$/, ""), subject: payload.sub, claims: payload };
    },
  };
}
