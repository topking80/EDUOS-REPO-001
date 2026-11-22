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
export function makeHint(key, payload, now = Date.now(), ttlMs = HINT_TTL_MS) {
  // lti_message_hint is sent to the external tool in the browser URL. Encrypt
  // the tenant/user launch context; an HMAC alone would expose internal IDs.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key.hintKey, iv);
  const plaintext = Buffer.from(JSON.stringify({ ...payload, exp: now + ttlMs }));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `v1.${b64u(iv)}.${b64u(ciphertext)}.${b64u(cipher.getAuthTag())}`;
}
export function readHint(key, hint, now = Date.now()) {
  if (typeof hint !== "string" || hint.length > 4096) return null;
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

/**
 * Browser binding for a launch: a random value set as an HttpOnly cookie when
 * the user starts the launch, whose hash travels inside the encrypted hint.
 */
export function newBrowserBinding() {
  const value = crypto.randomBytes(32).toString("base64url");
  return { value, hash: crypto.createHash("sha256").update(value).digest("base64url") };
}
export function browserBindingMatches(cookieValue, expectedHash) {
  if (typeof cookieValue !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(cookieValue) ||
      typeof expectedHash !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(expectedHash)) return false;
  const got = crypto.createHash("sha256").update(cookieValue).digest();
  return crypto.timingSafeEqual(got, Buffer.from(expectedHash, "base64url"));
}
/** One cookie per launch, so launches in two tabs don't overwrite each other. */
export function bindingCookieName(launchId) {
  return `eduos_lti_${String(launchId).replace(/[^0-9a-f]/gi, "").slice(0, 32)}`;
}
export const AUTO_SUBMIT_SCRIPT = 'document.getElementById("lti").submit()';
export const AUTO_SUBMIT_SCRIPT_HASH = `sha256-${crypto.createHash("sha256").update(AUTO_SUBMIT_SCRIPT).digest("base64")}`;

/** A stable per-app course identifier, like pairwiseSub. */
export function pairwiseContext(key, appId, courseId) {
  return crypto.createHmac("sha256", key.subjectKey || key.hintKey).update(`ctx\0${appId}\0${courseId}`).digest("base64url").slice(0, 32);
}

/** A stable per-app pseudonymous subject so tools cannot correlate users across apps. */
export function pairwiseSub(key, appId, userId) {
  return crypto.createHmac("sha256", key.subjectKey || key.hintKey).update(`sub\0${appId}\0${userId}`).digest("base64url").slice(0, 32);
}

// LTI Core currently supports only no identity or basic identity claims.
// Roster, grade and attendance scopes remain unsupported until their
// separately governed Advantage services exist.
const SCOPE_RANK = Object.freeze({ none: 0, identity: 1, roster_basic: 2 });
/** Data scopes an LTI tool may be approved for. roster_basic (class lists) needs NRPS registered. */
export const LTI_SCOPES = Object.freeze(["none", "identity", "roster_basic"]);
export const NRPS_SCOPE = "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly";
// LTI-04: a tool may read its activity's line item and post scores. It can't
// create, change or delete line items, or read results.
export const AGS_SCORE_SCOPE = "https://purl.imsglobal.org/spec/lti-ags/scope/score";
export const AGS_LINEITEM_READ_SCOPE = "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly";
/** Build id_token claims, limited by the app's data-sharing scope. */
export function launchClaims({ key, issuer, app, launch, user, school, nonce, deepLinking = null, content = null, context = null, nrps = null, ags = null, now = Math.floor(Date.now() / 1000) }) {
  const cfg = app.integration_config || {};
  // roster_basic counts only for a tool registered for NRPS; otherwise it fails closed.
  const rank = app.data_sharing_scope === "roster_basic" && cfg.namesRoles !== true ? 0 : SCOPE_RANK[app.data_sharing_scope] ?? 0;
  const claims = {
    iss: issuer, aud: cfg.clientId, azp: cfg.clientId, sub: pairwiseSub(key, app.id, user.id),
    iat: now, exp: now + 300, nonce,
    "https://purl.imsglobal.org/spec/lti/claim/message_type": deepLinking ? "LtiDeepLinkingRequest" : "LtiResourceLinkRequest",
    "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
    "https://purl.imsglobal.org/spec/lti/claim/deployment_id": cfg.deploymentId,
    "https://purl.imsglobal.org/spec/lti/claim/target_link_uri": deepLinking ? cfg.deepLinkingUrl : content ? content.url : cfg.targetLinkUri,
    "https://purl.imsglobal.org/spec/lti/claim/roles": LTI_ROLE[launch.role] || [],
    "https://purl.imsglobal.org/spec/lti/claim/tool_platform": { guid: crypto.createHash("sha256").update(`eduos-lti-platform\0${issuer}`).digest("hex"), product_family_code: "eduos", name: "EduOS" }
  };
  if (deepLinking) {
    // LTI Deep Linking 2.0: resource links only, returned to EduOS, signed by the tool.
    claims["https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings"] = {
      deep_link_return_url: deepLinking.returnUrl, accept_types: ["ltiResourceLink"],
      accept_presentation_document_targets: ["window"], accept_multiple: true, auto_create: false,
      title: deepLinking.title, data: deepLinking.data };
  } else if (content) {
    // A link placed on an assignment by Deep Linking: its own stable resource link.
    claims["https://purl.imsglobal.org/spec/lti/claim/resource_link"] = { id: content.id, title: content.title };
    if (content.custom && Object.keys(content.custom).length) claims["https://purl.imsglobal.org/spec/lti/claim/custom"] = content.custom;
    // LTI-04: this activity's own line item, for posting scores (when grade passback is on for it).
    if (ags) claims["https://purl.imsglobal.org/spec/lti-ags/claim/endpoint"] = { scope: [AGS_LINEITEM_READ_SCOPE, AGS_SCORE_SCOPE], lineitem: ags.lineitem };
  } else {
    claims["https://purl.imsglobal.org/spec/lti/claim/resource_link"] = { id: app.id };
  }
  if (context) {
    // An EduOS course, under an identifier that differs per tool (tools can't correlate courses).
    claims["https://purl.imsglobal.org/spec/lti/claim/context"] = { id: pairwiseContext(key, app.id, context.id), title: context.title,
      type: ["http://purl.imsglobal.org/vocab/lis/v2/course#CourseOffering"] };
    if (nrps) claims["https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice"] = { context_memberships_url: nrps.url, service_versions: ["2.0"] };
  }
  if (rank >= 1) { claims.name = user.display_name; claims.email = user.email; }
  // School records are not LTI course contexts. Never disclose school IDs or
  // names as a substitute for an approved course mapping, even for identity scope.
  return claims;
}

export function ltiConfigFingerprint(cfg, dataSharingScope) {
  if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.redirectUris) ||
      !LTI_SCOPES.includes(dataSharingScope) || (dataSharingScope === "roster_basic" && cfg.namesRoles !== true))
    throw new TypeError("invalid LTI registration configuration or data-sharing scope");
  // The approved fingerprint covers every setting that changes the student
  // data exposed to a tool, not just its OIDC endpoints and client identity.
  const registration = [cfg.clientId, cfg.deploymentId, cfg.loginUrl, [...cfg.redirectUris], cfg.targetLinkUri, dataSharingScope];
  // Deep Linking (LTI-02) settings are covered when present; registrations
  // without them keep the fingerprint (and approval) they already had.
  if (cfg.deepLinkingUrl || cfg.jwksUrl || cfg.namesRoles || cfg.assignmentGrades) registration.push({ deepLinkingUrl: cfg.deepLinkingUrl, jwksUrl: cfg.jwksUrl,
    ...(cfg.namesRoles ? { namesRoles: true } : {}), ...(cfg.assignmentGrades ? { assignmentGrades: true } : {}) });
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
    cfg.redirectUris.every(url) && url(cfg.targetLinkUri) &&
    // Deep Linking is optional, and needs both its launch URL and the tool's public keys.
    // Services that verify the tool's own signatures need its public keys:
    // Deep Linking (LTI-02) and Names and Role Provisioning (LTI-03).
    (cfg.deepLinkingUrl === undefined || url(cfg.deepLinkingUrl)) &&
    (cfg.namesRoles === undefined || typeof cfg.namesRoles === "boolean") &&
    (cfg.assignmentGrades === undefined || typeof cfg.assignmentGrades === "boolean") &&
    (cfg.jwksUrl === undefined ? cfg.deepLinkingUrl === undefined && cfg.namesRoles !== true && cfg.assignmentGrades !== true
      : url(cfg.jwksUrl) && (cfg.deepLinkingUrl !== undefined || cfg.namesRoles === true || cfg.assignmentGrades === true));
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

// ---- LTI-02 Deep Linking 2.0 ----------------------------------------------

export const DEEP_LINK_TTL_MS = 30 * 60_000; // time a teacher has to choose content in the tool
const MAX_ITEMS = 20;
const b64json = part => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/** Header and claims of a compact JWT, unverified (to find the key and our data claim). */
export function decodeJwt(jwt) {
  if (typeof jwt !== "string" || jwt.length > 60_000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) return null;
  try { const [h, p] = jwt.split("."); const header = b64json(h), payload = b64json(p);
    return header && typeof header === "object" && payload && typeof payload === "object" && !Array.isArray(payload) ? { header, payload } : null; } catch { return null; }
}

/**
 * Verify a tool-signed JWT (RS256 only) against the tool's JWKS and the
 * registration: issuer = client ID, audience includes the platform issuer,
 * current time window. Returns the payload or throws an Error with .code.
 */
export function verifyToolJwt(jwt, jwks, { clientId, issuer, audiences = [issuer], requireNonce = true, now = Math.floor(Date.now() / 1000), skew = 60 }) {
  const bad = code => Object.assign(new Error(code), { code });
  const decoded = decodeJwt(jwt);
  if (!decoded) throw bad("jwt_malformed");
  const { header, payload } = decoded;
  if (header.alg !== "RS256" || (header.typ && header.typ !== "JWT")) throw bad("jwt_algorithm_not_allowed");
  const keys = (jwks?.keys || []).filter(k => k?.kty === "RSA" && (!k.use || k.use === "sig") && (!k.alg || k.alg === "RS256"));
  const candidates = header.kid ? keys.filter(k => k.kid === header.kid) : keys;
  if (!candidates.length) throw bad("jwt_key_not_found");
  const [h, p, sig] = jwt.split(".");
  const ok = candidates.some(k => {
    try {
      const pub = crypto.createPublicKey({ key: { kty: "RSA", n: k.n, e: k.e }, format: "jwk" });
      if ((pub.asymmetricKeyDetails?.modulusLength || 0) < 2048) return false;
      return crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), pub, Buffer.from(sig, "base64url"));
    } catch { return false; }
  });
  if (!ok) throw bad("jwt_signature_invalid");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== clientId) throw bad("jwt_issuer_mismatch");
  if (!aud.some(x => audiences.includes(x)) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== undefined && !audiences.includes(payload.azp))) throw bad("jwt_audience_mismatch");
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= now - skew) throw bad("jwt_expired");
  if (!Number.isSafeInteger(payload.iat) || payload.iat > now + skew || payload.iat < now - 3600) throw bad("jwt_iat_invalid");
  if (requireNonce && (typeof payload.nonce !== "string" || !payload.nonce || payload.nonce.length > 256)) throw bad("jwt_nonce_missing");
  return payload;
}

/**
 * Content items a tool returned, reduced to what EduOS accepts: LTI resource
 * links to the tool's own host (that of its registered target link URI), with
 * bounded titles, text and custom parameters. Anything else is counted, not kept.
 */
export function acceptContentItems(items, cfg, { allowInsecureLoopback = false } = {}) {
  if (items === undefined) items = [];
  if (!Array.isArray(items)) throw Object.assign(new Error("content_items_invalid"), { code: "content_items_invalid" });
  if (items.length > MAX_ITEMS) throw Object.assign(new Error("too_many_content_items"), { code: "too_many_content_items" });
  const toolHost = new URL(cfg.targetLinkUri).host;
  const accepted = [], skipped = [];
  for (const it of items) {
    if (!it || typeof it !== "object" || it.type !== "ltiResourceLink") { skipped.push("type_not_accepted"); continue; }
    let url;
    try { url = new URL(it.url ?? cfg.targetLinkUri); } catch { skipped.push("url_invalid"); continue; }
    const scheme = url.protocol === "https:" || (allowInsecureLoopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    if (!scheme || url.username || url.password || url.hash || url.host !== toolHost || url.href.length > 2048) { skipped.push("url_not_allowed"); continue; }
    const title = (typeof it.title === "string" ? it.title : "").trim().slice(0, 180) || "Activity";
    const text = typeof it.text === "string" ? it.text.trim().slice(0, 1000) : "";
    let custom = {};
    if (it.custom !== undefined) {
      const entries = it.custom && typeof it.custom === "object" && !Array.isArray(it.custom) ? Object.entries(it.custom) : null;
      if (!entries || entries.length > 20 || entries.some(([k, v]) => !/^[A-Za-z0-9_.-]{1,64}$/.test(k) || typeof v !== "string" || v.length > 256)) { skipped.push("custom_invalid"); continue; }
      custom = Object.fromEntries(entries);
    }
    // AGS isn't implemented: a line item (gradebook column) request is not honoured.
    accepted.push({ title, text, url: url.href, custom, lineItemIgnored: it.lineItem !== undefined });
  }
  return { accepted, skipped };
}

// ---- LTI-03 service access (OAuth 2.0 client credentials, private_key_jwt) --

export const SERVICE_TOKEN_TTL_MS = 60 * 60_000;

/**
 * A tool's client assertion (RFC 7523): signed by the tool, iss = sub = its
 * client ID, audience = this registration's token URL, short-lived, with a jti
 * (the caller records it so it can't be replayed).
 */
export function verifyClientAssertion(jwt, jwks, { clientId, tokenUrl, now = Math.floor(Date.now() / 1000) }) {
  const payload = verifyToolJwt(jwt, jwks, { clientId, audiences: [tokenUrl], requireNonce: false, now });
  const bad = code => Object.assign(new Error(code), { code });
  if (payload.sub !== clientId) throw bad("assertion_subject_mismatch");
  if (payload.exp <= payload.iat || payload.exp - payload.iat > 600 || payload.exp > now + 600) throw bad("assertion_lifetime_too_long");
  if (typeof payload.jti !== "string" || !/^[\x21-\x7e]{8,200}$/.test(payload.jti)) throw bad("assertion_jti_missing");
  return payload;
}
