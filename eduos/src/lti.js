// 32.2.0: minimal LTI 1.3 platform (IMS LTI 1.3 Core, resource-link launch).
//
// EduOS acts as the platform. The tool registers in the district catalog with
// integration_config { clientId, deploymentId, loginUrl, redirectUris[],
// targetLinkUri }. A launch is:
//   1. POST /api/apps/:id/launch (session + CSRF) records the launch, claims a
//      seat and returns the tool's OIDC login-initiation URL with a signed,
//      short-lived lti_message_hint.
//   2. The tool redirects the browser to GET /lti/authorize (OIDC auth request).
//   3. EduOS checks the hint, client_id and registered redirect_uri, and
//      form-posts an RS256 id_token to the tool.
// Claims are limited to the launching user and the app's data_sharing_scope.
// No roster, grade or attendance data is sent by EduOS (no NRPS/AGS).
// Disabled (503) unless LTI_PLATFORM_PRIVATE_KEY (PEM RSA private key) is set.
import crypto from "node:crypto";

export const LTI_ROLE = Object.freeze({
  pupil: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
  teacher: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"],
  parent: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Mentor"],
  principal: ["http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator"],
  superintendent: ["http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator"],
  it_admin: ["http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator"]
});
const HINT_TTL_MS = 5 * 60_000;
const b64u = buf => Buffer.from(buf).toString("base64url");

export function assertPlatformRsaKey(privateKey) {
  if (privateKey?.asymmetricKeyType !== "rsa") throw new Error("LTI platform signing keys must be RSA");
  if ((privateKey.asymmetricKeyDetails?.modulusLength || 0) < 2048)
    throw new Error("LTI platform RSA keys must be at least 2048 bits");
  return privateKey;
}

export function loadPlatformKey(pem, previousPem = "", subjectSecret = "") {
  if (!pem) return null;
  const loadRsa = value => {
    const privateKey = crypto.createPrivateKey(value.replace(/\\n/g, "\n"));
    assertPlatformRsaKey(privateKey);
    const publicJwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
    const kid = crypto.createHash("sha256").update(JSON.stringify({ e: publicJwk.e, kty: publicJwk.kty, n: publicJwk.n })).digest("base64url").slice(0, 22);
    return { privateKey, publicJwk, kid };
  };
  const current = loadRsa(pem);
  const previous = previousPem ? loadRsa(previousPem) : null;
  if (previous && previous.kid === current.kid) throw new Error("LTI previous signing key must differ from the active key");
  if (previous && !subjectSecret) throw new Error("LTI_PLATFORM_SUBJECT_KEY is required during signing-key rotation");
  if (subjectSecret && Buffer.byteLength(subjectSecret) < 32) throw new Error("LTI_PLATFORM_SUBJECT_KEY must contain at least 32 bytes");
  const hintKey = crypto.createHash("sha256").update("eduos-lti-hint\\0").update(current.privateKey.export({ type: "pkcs8", format: "der" })).digest();
  const subjectKey = subjectSecret ? crypto.createHash("sha256").update("eduos-lti-subject\\0").update(subjectSecret).digest() : hintKey;
  const jwk = key => ({ kty: "RSA", n: key.publicJwk.n, e: key.publicJwk.e, alg: "RS256", use: "sig", kid: key.kid });
  return {
    privateKey: current.privateKey, kid: current.kid, previousKid: previous?.kid || null,
    jwks: { keys: [jwk(current), ...(previous ? [jwk(previous)] : [])] },
    hintKey, subjectKey
  };
}

export function signJwt(key, claims) {
  const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid }));
  const body = b64u(JSON.stringify(claims));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${body}`), key.privateKey);
  return `${header}.${body}.${b64u(sig)}`;
}

/** Signed, expiring launch hint: binds the launch to one user, app and tenant. */
export function makeHint(key, payload, now = Date.now()) {
  // lti_message_hint is sent to the external tool in the browser URL. Encrypt
  // the tenant/user launch context; an HMAC alone would expose internal IDs.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key.hintKey, iv);
  const plaintext = Buffer.from(JSON.stringify({ ...payload, exp: now + HINT_TTL_MS }));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `v1.${b64u(iv)}.${b64u(ciphertext)}.${b64u(cipher.getAuthTag())}`;
}
export function readHint(key, hint, now = Date.now()) {
  if (typeof hint !== "string" || hint.length > 2048) return null;
  const match = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/.exec(hint);
  if (!match) return null;
  try {
    const [, ivPart, ciphertextPart, tagPart] = match;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key.hintKey, Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextPart, "base64url")), decipher.final()]);
    const payload = JSON.parse(plaintext.toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        !Number.isSafeInteger(payload.exp) || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

// One-time use of each launch hint within its lifetime (per process).
const usedHints = new Map();
export function consumeHint(launchId, now = Date.now()) {
  for (const [id, exp] of usedHints) if (exp < now) usedHints.delete(id);
  if (usedHints.has(launchId)) return false;
  usedHints.set(launchId, now + HINT_TTL_MS);
  return true;
}

/** A stable per-app pseudonymous subject so tools cannot correlate users across apps. */
export function pairwiseSub(key, appId, userId) {
  return crypto.createHmac("sha256", key.subjectKey || key.hintKey).update(`sub\0${appId}\0${userId}`).digest("base64url").slice(0, 32);
}

// LTI Core currently supports only no identity or basic identity claims.
// Roster, grade and attendance scopes remain unsupported until their
// separately governed Advantage services exist.
const SCOPE_RANK = Object.freeze({ none: 0, identity: 1 });
/** Build id_token claims, limited by the app's data-sharing scope. */
export function launchClaims({ key, issuer, app, launch, user, school, nonce, now = Math.floor(Date.now() / 1000) }) {
  const cfg = app.integration_config || {};
  const rank = SCOPE_RANK[app.data_sharing_scope] ?? 0;
  const claims = {
    iss: issuer, aud: cfg.clientId, azp: cfg.clientId, sub: pairwiseSub(key, app.id, user.id),
    iat: now, exp: now + 300, nonce,
    "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiResourceLinkRequest",
    "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
    "https://purl.imsglobal.org/spec/lti/claim/deployment_id": cfg.deploymentId,
    "https://purl.imsglobal.org/spec/lti/claim/target_link_uri": cfg.targetLinkUri,
    "https://purl.imsglobal.org/spec/lti/claim/resource_link": { id: app.id },
    "https://purl.imsglobal.org/spec/lti/claim/roles": LTI_ROLE[launch.role] || [],
    "https://purl.imsglobal.org/spec/lti/claim/tool_platform": { guid: crypto.createHash("sha256").update(`eduos-lti-platform\0${issuer}`).digest("hex"), product_family_code: "eduos", name: "EduOS" }
  };
  if (rank >= 1) { claims.name = user.display_name; claims.email = user.email; }
  // School records are not LTI course contexts. Never disclose school IDs or
  // names as a substitute for an approved course mapping, even for identity scope.
  return claims;
}

export function ltiConfigFingerprint(cfg) {
  if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.redirectUris))
    throw new TypeError("invalid LTI registration configuration");
  const registration = [cfg.clientId, cfg.deploymentId, cfg.loginUrl, [...cfg.redirectUris], cfg.targetLinkUri];
  return crypto.createHash("sha256").update(JSON.stringify(registration)).digest("base64url");
}

export function validLtiConfig(cfg, { allowInsecureLoopback = process.env.NODE_ENV !== "production" } = {}) {
  // Development may use HTTP only for literal loopback hosts. Production
  // requires HTTPS everywhere; credentials and fragments are never valid.
  const url = value => {
    if (typeof value !== "string" || value.length > 2048 || /\s/.test(value)) return false;
    let parsed;
    try { parsed = new URL(value); } catch { return false; }
    if (parsed.username || parsed.password || parsed.hash) return false;
    if (parsed.protocol === "https:") return true;
    return allowInsecureLoopback && parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  };
  return cfg && typeof cfg.clientId === "string" && /^[\w.:\/-]{1,200}$/.test(cfg.clientId) &&
    typeof cfg.deploymentId === "string" && /^[\w.:\/-]{1,200}$/.test(cfg.deploymentId) &&
    url(cfg.loginUrl) && Array.isArray(cfg.redirectUris) && cfg.redirectUris.length >= 1 && cfg.redirectUris.length <= 10 &&
    cfg.redirectUris.every(url) && url(cfg.targetLinkUri);
}

/**
 * Atomically consume a launch hint in PostgreSQL. Call only inside
 * withTenantTransaction(actor, ...), so app.district_id is transaction-scoped.
 * The database function enforces tenant equality and serializes competing
 * consumers across every API instance.
 */
export async function consumeHintDurably(client, districtId, launchId, expiresAt) {
  if (!client || typeof client.query !== "function" ||
      typeof districtId !== "string" || !districtId ||
      typeof launchId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(launchId) ||
      !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 6 * 60_000) {
    throw new TypeError("invalid durable LTI launch claim");
  }
  const result = await client.query(
    "SELECT eduos_lti_consume_launch($1::uuid, $2::text, $3::timestamptz) AS consumed",
    [districtId, launchId, expiresAt]
  );
  return result.rows?.[0]?.consumed === true;
}
