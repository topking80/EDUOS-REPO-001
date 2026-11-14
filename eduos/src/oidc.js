import crypto from "node:crypto";
import { config } from "./config.js";

const discoveryUrl = new URL(".well-known/openid-configuration",
  config.oidcIssuer.endsWith("/") ? config.oidcIssuer : `${config.oidcIssuer}/`);
let metadata;
let jwks;

export async function getOidcMetadata() {
  if (metadata) return metadata;
  const response = await fetch(discoveryUrl, {
    headers: { accept: "application/json" }, signal: AbortSignal.timeout(config.oidcHttpTimeoutMs)
  });
  if (!response.ok) throw new Error(`OIDC discovery failed (${response.status})`);
  // Validate into locals first: untrusted metadata is never cached.
  const discovered = await response.json();
  const configuredIssuer = config.oidcIssuer.replace(/\/$/, "");
  const discoveredIssuer = String(discovered?.issuer || "").replace(/\/$/, "");
  if (discoveredIssuer !== configuredIssuer) throw new Error("OIDC issuer mismatch");
  // 32.1.0: the bundled local development provider (dev/dev-idp.js) signs in
  // anyone; it can never be used in production.
  if (discovered.eduos_dev_idp === true && config.nodeEnv === "production")
    throw new Error("Refusing the local development OIDC provider with NODE_ENV=production");
  if (!discovered.authorization_endpoint || !discovered.token_endpoint || !discovered.jwks_uri) {
    throw new Error("OIDC provider metadata is incomplete");
  }
  const { createRemoteJWKSet } = await import("jose");
  const keySet = createRemoteJWKSet(new URL(discovered.jwks_uri), { timeoutDuration: config.oidcHttpTimeoutMs });
  jwks = keySet;
  metadata = discovered;
  return metadata;
}

export function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function validateAuthorizedParty(payload, clientId = config.oidcClientId) {
  // OIDC Core: when multiple audiences are present, azp is required; whenever
  // present, it must identify this client.
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if ((audiences.length > 1 && payload.azp !== clientId) ||
      (payload.azp !== undefined && payload.azp !== clientId)) {
    throw new Error("OIDC authorized-party mismatch");
  }
  return true;
}

export async function verifyIdToken(idToken, expectedNonce) {
  const meta = await getOidcMetadata();
  const { jwtVerify } = await import("jose");
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: meta.issuer,
    audience: config.oidcClientId,
    algorithms: ["RS256", "ES256"]
  });
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("OIDC subject is missing");
  validateAuthorizedParty(payload);
  if (expectedNonce && payload.nonce !== expectedNonce) throw new Error("OIDC nonce mismatch");
  // Identity is issuer + subject; email verification is NOT required to sign in
  // (Microsoft Entra ID, for example, does not emit email_verified).
  return payload;
}

/**
 * The email address the IdP vouches for, or null. Used only to match guardian
 * invitations; see OIDC_EMAIL_VERIFICATION in config.js.
 */
export function verifiedEmailFromClaims(claims, mode = config.oidcEmailVerification) {
  const email = typeof claims?.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  if (claims.email_verified === true) return email;
  if (mode === "entra" && claims.xms_edov === true) return email;
  if (mode === "trusted") return email;
  return null;
}
