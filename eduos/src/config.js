import { validateAiProviderUrl } from "./ai/provider-egress.js";

// dotenv is a convenience for local development; production environments may
// inject variables directly and need not load the optional helper at import time.
try { await import("dotenv/config"); } catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const PLACEHOLDER_SECRETS = new Set(["change-this", "changeme", "change-me", "replace-me", "password", "postgres"]);

/** True when a database host is only reachable on a local/private network. */
export function isPrivateDatabaseHost(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return false;
  if (host === "localhost" || /^127\./.test(host) || host === "::1") return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  // Single-label names (for example the compose service "db") resolve only on
  // the container network; anything with a dot is treated as remote.
  return /^[a-z0-9-]+$/.test(host) && !/^\d+$/.test(host);
}

/**
 * Native app redirect URIs: a private-use scheme in reverse-domain form
 * (RFC 8252 section 7.1, e.g. org.eduos.app:/oauth2redirect) or an https app
 * link. Anything else is a configuration error, so a typo can't widen redirects.
 */
export function parseNativeRedirectUris(value) {
  const uris = String(value).split(",").map(x => x.trim()).filter(Boolean);
  for (const uri of uris) {
    let url;
    try { url = new URL(uri); } catch { throw new Error(`NATIVE_APP_REDIRECT_URIS: not a URI: ${uri}`); }
    const scheme = url.protocol.slice(0, -1);
    const privateUse = /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+$/.test(scheme);
    if (!(privateUse || scheme === "https")) throw new Error(`NATIVE_APP_REDIRECT_URIS: use a reverse-domain scheme (org.example.app:/path) or https: ${uri}`);
    if (url.search || url.hash || url.username || url.password) throw new Error(`NATIVE_APP_REDIRECT_URIS: no query, fragment or credentials: ${uri}`);
    if (uri.length > 200) throw new Error(`NATIVE_APP_REDIRECT_URIS: longer than 200 characters: ${uri}`);
  }
  return uris;
}

const ltiPrivateKey = process.env.LTI_PLATFORM_PRIVATE_KEY || "";
const ltiPreviousPrivateKey = process.env.LTI_PLATFORM_PRIVATE_KEY_PREVIOUS || "";
const ltiSubjectKey = process.env.LTI_PLATFORM_SUBJECT_KEY || "";
if (ltiPreviousPrivateKey && !ltiPrivateKey) throw new Error("LTI_PLATFORM_PRIVATE_KEY is required when a previous signing key is configured");
if ((process.env.NODE_ENV || "development") === "production" && ltiPrivateKey && Buffer.byteLength(ltiSubjectKey) < 32)
  throw new Error("Production LTI requires LTI_PLATFORM_SUBJECT_KEY with at least 32 bytes");

export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 8080),
  databaseUrl: required("DATABASE_URL"),
  databaseSsl: process.env.DATABASE_SSL === "true",
  publicOrigin: required("PUBLIC_ORIGIN"),
  databaseSslAllowPrivateNetwork: process.env.DATABASE_SSL_ALLOW_PRIVATE_NETWORK === "true",
  // Cookies are Secure whenever the public origin is HTTPS, in any NODE_ENV.
  secureCookies: String(process.env.PUBLIC_ORIGIN || "").startsWith("https://"),
  cookieName: process.env.SESSION_COOKIE_NAME ||
    (String(process.env.PUBLIC_ORIGIN || "").startsWith("https://") ? "__Host-eduos_session" : "eduos_session"),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 8),
  // Sessions unused for this many minutes are rejected (idle timeout).
  sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES || 30),
  // How often a long-lived connection (the operations event stream) re-checks
  // its session while idle; it is also checked before every event it sends.
  streamSessionRecheckMs: Number(process.env.STREAM_SESSION_RECHECK_MS || 15_000),
  // Concurrent active sessions per user; the oldest are revoked beyond this.
  sessionMaxPerUser: Number(process.env.SESSION_MAX_PER_USER || 5),
  // Optional in-process session-validation cache. 0 (default) = disabled:
  // every authenticated request re-validates against the database, so revoked
  // or expired sessions are rejected immediately. A positive value is the
  // staleness window (ms) a deployment accepts in exchange for fewer DB
  // round-trips on hot sessions; logout and CSRF rotation evict in-process.
  sessionCacheTtlMs: Math.max(0, Number(process.env.SESSION_CACHE_TTL_MS || 0)),
  oidcIssuer: required("OIDC_ISSUER"),
  oidcClientId: required("OIDC_CLIENT_ID"),
  oidcClientSecret: required("OIDC_CLIENT_SECRET"),
  oidcRedirectUri: required("OIDC_REDIRECT_URI"),
  oidcScopes: (process.env.OIDC_SCOPES || "openid profile email").split(/\s+/),
  oidcHttpTimeoutMs: Number(process.env.OIDC_HTTP_TIMEOUT_MS || 10000),
  // How an ID token's email is treated as IdP-verified (used for guardian
  // invitation matching only; login identity is always issuer + subject):
  //   claim   - email_verified === true (default; Google, Okta, Keycloak, ...)
  //   entra   - email_verified === true OR xms_edov === true (Microsoft Entra ID;
  //             add the optional xms_edov claim in the app registration)
  //   trusted - every email claim from this issuer is district-managed
  oidcEmailVerification: process.env.OIDC_EMAIL_VERIFICATION || "claim",
  // Synthetic persona/localStorage demo UI. Off unless explicitly enabled; never in production.
  demoMode: process.env.EDUOS_DEMO_MODE === "true",
  // Outbound webhooks are disabled unless WEBHOOK_SIGNING_KEY (32+ chars) is set.
  webhookSigningKey: process.env.WEBHOOK_SIGNING_KEY || "",
  // Signing-key rotation: while set, deliveries carry a second signature made
  // with the previous key, so receivers keep verifying until they switch to the
  // new per-subscription secret (docs/WEBHOOKS.md, "Rotating the signing key").
  webhookPreviousSigningKey: process.env.WEBHOOK_SIGNING_KEY_PREVIOUS || "",
  webhookAllowedHosts: (process.env.WEBHOOK_ALLOWED_HOSTS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean),
  // In production an empty WEBHOOK_ALLOWED_HOSTS must be a decision, not an
  // omission: set this to "true" to allow any public HTTPS receiver.
  webhookAllowAnyPublicHost: process.env.WEBHOOK_ALLOW_ANY_PUBLIC_HOST === "true",
  // The API drains the webhook outbox for every district on this interval, so
  // queued webhooks and their retries go out in a quiet district without cron.
  // 0 turns it off (then run src/webhook-dispatch.js on a schedule).
  webhookDispatchIntervalSeconds: Number(process.env.WEBHOOK_DISPATCH_INTERVAL_SECONDS ?? 60),
  // Development aid only: permits http:// to a loopback receiver. Ignored in production.
  webhookAllowInsecureLoopback: process.env.WEBHOOK_ALLOW_INSECURE_LOOPBACK === "true" && (process.env.NODE_ENV || "development") !== "production",
  // Staff AI gateway (src/ai/). Local templates by default: no network. An
  // external OpenAI-compatible model is used only when AI_PROVIDER=openai_compatible
  // AND AI_ALLOW_EXTERNAL_PROVIDER=true; identifiers are redacted first.
  aiProvider: (process.env.AI_PROVIDER || "local").trim(),
  aiAllowExternal: process.env.AI_ALLOW_EXTERNAL_PROVIDER === "true",
  aiProviderUrl: (process.env.AI_PROVIDER_URL || "").trim(),
  // Explicit egress allowlist for external AI provider origins (exact hosts or parent domains).
  aiProviderAllowedHosts: (process.env.AI_PROVIDER_ALLOWED_HOSTS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean),
  aiProviderModel: (process.env.AI_PROVIDER_MODEL || "").trim(),
  aiProviderApiKey: process.env.AI_PROVIDER_API_KEY || "",
  aiProviderTimeoutMs: Number(process.env.AI_PROVIDER_TIMEOUT_MS || 20000),
  // Development and tests only: allows an http:// provider on loopback (to
  // capture exactly what would be sent). Ignored in production.
  aiAllowInsecureLoopback: process.env.AI_ALLOW_INSECURE_LOOPBACK === "true" && (process.env.NODE_ENV || "development") !== "production",
  // External integrations (OneRoster, Ed-Fi) are off unless INTEGRATIONS_KEY
  // (32+ chars) is set: it encrypts connector client secrets at rest.
  integrationsKey: process.env.INTEGRATIONS_KEY || "",
  // Global operational kill switch for scheduled roster jobs; manual sync remains available.
  sisSyncDispatchEnabled: process.env.SIS_SYNC_DISPATCH_ENABLED !== "false",
  // MEDIA-01: private S3-compatible storage and ClamAV for history photos.
  // Photos stay off until both are set (and the superintendent turns them on).
  mediaS3: { endpoint: process.env.MEDIA_S3_ENDPOINT || "", region: process.env.MEDIA_S3_REGION || "", bucket: process.env.MEDIA_S3_BUCKET || "",
    accessKeyId: process.env.MEDIA_S3_ACCESS_KEY_ID || "", secretAccessKey: process.env.MEDIA_S3_SECRET_ACCESS_KEY || "", pathStyle: process.env.MEDIA_S3_PATH_STYLE === "true" },
  clamav: { host: process.env.CLAMAV_HOST || "", port: Number(process.env.CLAMAV_PORT || 3310) },
  // SAFE-04: National Weather Service alerts. NWS requires a User-Agent with a
  // contact (e.g. "EduOS (it@district.org)"); unset, the sweep doesn't run.
  weatherAlertsUserAgent: (process.env.WEATHER_ALERTS_USER_AGENT || "").trim(),
  weatherAlertsIntervalSeconds: Number(process.env.WEATHER_ALERTS_INTERVAL_SECONDS ?? 120),
  apiRateLimitPerMinute: Number(process.env.API_RATE_LIMIT_PER_MINUTE ?? 1200),
  // Bounded in-memory PowerSchool roster ceiling; larger districts need staged ingestion.
  powerschoolMaxStudents: Number(process.env.POWERSCHOOL_MAX_STUDENTS || 200_000),
  integrationsAllowedHosts: (process.env.INTEGRATIONS_ALLOWED_HOSTS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean),
  // Development and tests only: permits http:// to a loopback server. Ignored in production.
  integrationsAllowInsecureLoopback: process.env.INTEGRATIONS_ALLOW_INSECURE_LOOPBACK === "true" && (process.env.NODE_ENV || "development") !== "production",
  // 37.7.1 commerce: each district picks its own payment processors.
  // COMMERCE_SECRETS_KEY (32+ chars) encrypts their credentials at rest;
  // without it no credential can be saved (the built-in sandbox still works).
  commerceSecretsKey: process.env.COMMERCE_SECRETS_KEY || "",
  // Global kill switch: no district takes live payments unless this is "true".
  commerceLivePaymentsEnabled: process.env.COMMERCE_LIVE_PAYMENTS_ENABLED === "true",
  // Self-hosted processors (BTCPay Server): the hosts a district may point at.
  commerceAllowedHosts: (process.env.COMMERCE_ALLOWED_HOSTS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean),
  // Development and tests only: send every processor API call to this
  // loopback mock (http://127.0.0.1:PORT). Ignored in production.
  commerceTestApiBase: (process.env.NODE_ENV || "development") !== "production" && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(process.env.COMMERCE_TEST_API_BASE || "")
    ? process.env.COMMERCE_TEST_API_BASE : "",
  // Finishing processor calls cut off midway (crash, deploy): how often the
  // API looks (0 = off) and how long a call must be in flight to count.
  commerceReconcileIntervalSeconds: Number(process.env.COMMERCE_RECONCILE_INTERVAL_SECONDS ?? 60),
  commerceReconcileStaleSeconds: Number(process.env.COMMERCE_RECONCILE_STALE_SECONDS ?? 90),
  // Time Capsules: how often the API releases capsules whose date has come
  // (0 = off, e.g. when cron runs src/capsule-release-cli.js instead).
  capsuleReleaseIntervalSeconds: Number(process.env.CAPSULE_RELEASE_INTERVAL_SECONDS ?? 300),
  // Native mobile app sign-in (RFC 8252). Comma-separated redirect URIs the
  // EduOS app may return to after district sign-in, e.g.
  // "org.eduos.app:/oauth2redirect". Empty (default) disables native sign-in.
  nativeAppRedirectUris: parseNativeRedirectUris(process.env.NATIVE_APP_REDIRECT_URIS || ""),
  // 32.1.0: GET /metrics is served only when this is set (Bearer token).
  metricsToken: process.env.METRICS_TOKEN || "",
  // Sign-in requests (/auth/login + /auth/callback) per client IP per 15 minutes.
  loginRateLimit: Number(process.env.LOGIN_RATE_LIMIT_PER_15M || 600),
  // 32.2.0: no product caps; these are per-request safety bounds (see docs/LIMITS.md).
  pageSizeDefault: Number(process.env.PAGE_SIZE_DEFAULT || 200),
  pageSizeMax: Number(process.env.PAGE_SIZE_MAX || 1000),
  jsonBodyLimit: process.env.JSON_BODY_LIMIT || "256kb",
  sisImportMaxBytes: Number(process.env.SIS_IMPORT_MAX_MB || 50) * 1024 * 1024,
  guardianInviteRateLimit: Number(process.env.GUARDIAN_INVITE_RATE_LIMIT_PER_HOUR || 1000),
  guardianAcceptRateLimit: Number(process.env.GUARDIAN_ACCEPT_RATE_LIMIT_PER_15M || 10),
  flowEventRateLimit: Number(process.env.FLOW_EVENT_RATE_LIMIT_PER_MIN || 120),
  webhookAdminRateLimit: Number(process.env.WEBHOOK_ADMIN_RATE_LIMIT_PER_15M || 200),
  webhookMaxInFlight: Number(process.env.WEBHOOK_MAX_IN_FLIGHT || 16),
  // 37.7.0 audit: deliveries in flight across the whole deployment (every API
  // replica plus the dispatcher), enforced in PostgreSQL. 0 = per-process only.
  webhookGlobalMaxInFlight: Number(process.env.WEBHOOK_GLOBAL_MAX_IN_FLIGHT ?? 64),
  sessionCacheMax: Number(process.env.SESSION_CACHE_MAX || 5000),
  // 32.3.0 school branding: mascot upload size and the public (sign-in page) branding endpoints.
  brandingUploadMaxBytes: Number(process.env.BRANDING_UPLOAD_MAX_KB || 2048) * 1024,
  publicBrandingRateLimit: Number(process.env.PUBLIC_BRANDING_RATE_LIMIT_PER_MIN || 300),
  ltiPlatformKey: ltiPrivateKey,
  // Publish the previous platform public key during rotation so relying parties
  // can validate still-live tokens. Keep the subject HMAC key stable across
  // signing-key rotations to preserve pairwise subject identifiers.
  ltiPlatformPreviousKey: ltiPreviousPrivateKey,
  ltiSubjectKey,
  trustedProxyIps: (process.env.TRUSTED_PROXY_IPS || "").split(",").map(x => x.trim()).filter(Boolean),
  // 32.4.0 role apps. Christie runs the local deterministic tutor unless an
  // external provider is explicitly configured AND allowed; external
  // notification channels are off unless an adapter is named.
  christieProvider: (process.env.CHRISTIE_PROVIDER || "local").trim(),
  christieProviderUrl: (process.env.CHRISTIE_PROVIDER_URL || "").trim(),
  christieProviderModel: (process.env.CHRISTIE_PROVIDER_MODEL || "").trim(),
  christieProviderApiKey: process.env.CHRISTIE_PROVIDER_API_KEY || "",
  christieAllowExternal: process.env.CHRISTIE_ALLOW_EXTERNAL_PROVIDER === "true",
  christieProviderTimeoutMs: Number(process.env.CHRISTIE_PROVIDER_TIMEOUT_MS || 8000),
  christieRateLimit: Number(process.env.CHRISTIE_RATE_LIMIT_PER_MIN || 60),
  commsRateLimit: Number(process.env.COMMS_RATE_LIMIT_PER_MIN || 60),
  transportCheckinRateLimit: Number(process.env.TRANSPORT_CHECKIN_RATE_LIMIT_PER_MIN || 300),
  notifyEmailAdapter: (process.env.NOTIFY_EMAIL_ADAPTER || "off").trim(),
  notifySmsAdapter: (process.env.NOTIFY_SMS_ADAPTER || "off").trim(),
  notifyPushAdapter: (process.env.NOTIFY_PUSH_ADAPTER || "off").trim(),
  notifySmtpHost: (process.env.NOTIFY_SMTP_HOST || "").trim(),
  notifySmtpPort: Number(process.env.NOTIFY_SMTP_PORT || 465),
  notifySmtpUsername: process.env.NOTIFY_SMTP_USERNAME || "",
  notifySmtpPassword: process.env.NOTIFY_SMTP_PASSWORD || "",
  notifySmtpFrom: (process.env.NOTIFY_SMTP_FROM || "").trim(),
  notifySmtpEhlo: (process.env.NOTIFY_SMTP_EHLO || "eduos.local").trim(),
  notifySmtpTimeoutMs: Number(process.env.NOTIFY_SMTP_TIMEOUT_MS || 15000),
  twilioAccountSid: (process.env.TWILIO_ACCOUNT_SID || "").trim(),
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
  twilioVerifyServiceSid: (process.env.TWILIO_VERIFY_SERVICE_SID || "").trim(),
  twilioMessagingServiceSid: (process.env.TWILIO_MESSAGING_SERVICE_SID || "").trim(),
  twilioFromNumber: (process.env.TWILIO_FROM_NUMBER || "").trim(),
  twilioTimeoutMs: Number(process.env.TWILIO_TIMEOUT_MS || 10000),
  // 32.5.0 SafetyOS and car pick-up.
  safetyTeachersMayInitiate: process.env.SAFETY_TEACHERS_MAY_INITIATE !== "false",
  safetyRateLimit: Number(process.env.SAFETY_RATE_LIMIT_PER_MIN || 120),
  pickupVerifyRateLimit: Number(process.env.PICKUP_VERIFY_RATE_LIMIT_PER_MIN || 30),
  // 32.7.0 EDEN / DECN. EDUOS_NODE_TIER: "" (classic single deployment),
  // "district" (district hub: enrolls nodes, receives gated aggregates,
  // publishes signed bundles, authorizes failover) or "school" (local school
  // node: works offline, sends only gate output upward).
  nodeTier: (process.env.EDUOS_NODE_TIER || "").trim(),
  edenRootCert: process.env.EDEN_ROOT_CERT || "",
  edenDistrictCert: process.env.EDEN_DISTRICT_CERT || "",
  edenDistrictKey: process.env.EDEN_DISTRICT_KEY || "",
  edenHubUrl: (process.env.EDEN_HUB_URL || "").trim().replace(/\/+$/, ""),
  edenIdentityFile: process.env.EDEN_IDENTITY_FILE || "/var/lib/eduos/eden-identity.json",
  edenEnrollmentToken: process.env.EDEN_ENROLLMENT_TOKEN || "",
  edenNodeName: process.env.EDEN_NODE_NAME || "",
  edenDistrictId: (process.env.EDEN_DISTRICT_ID || "").trim(),
  edenSchoolId: (process.env.EDEN_SCHOOL_ID || "").trim(),
  edenSyncIntervalMs: Math.max(2, Number(process.env.EDEN_SYNC_INTERVAL_SECONDS || 30)) * 1000,
  edenHttpTimeoutMs: Number(process.env.EDEN_HTTP_TIMEOUT_MS || 8000),
  edenNodeOfflineAfterMs: Math.max(5, Number(process.env.EDEN_NODE_OFFLINE_AFTER_SECONDS || 90)) * 1000,
  edenFailoverMaxHours: Math.min(72, Math.max(1, Number(process.env.EDEN_FAILOVER_MAX_HOURS || 24))),
  // Consent-gated exceptions to the aggregate-only rule: OFF unless "on".
  edenConsentExceptions: process.env.EDEN_CONSENT_EXCEPTIONS === "on",
  edenSyncNowPerMinute: Math.min(60, Math.max(1, Number(process.env.EDEN_SYNC_NOW_PER_MINUTE || 6))),
  edenAllowInsecureHub: process.env.EDEN_ALLOW_INSECURE_HUB === "true" && (process.env.NODE_ENV || "development") !== "production"
};

if (!["", "district", "school"].includes(config.nodeTier)) throw new Error('EDUOS_NODE_TIER must be "", "district" or "school"');
if (config.nodeTier === "school" && config.edenHubUrl && !config.edenHubUrl.startsWith("https://") && !config.edenAllowInsecureHub)
  throw new Error("EDEN_HUB_URL must use HTTPS (EDEN_ALLOW_INSECURE_HUB=true is accepted only outside production, for the local simulation)");
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}
if (!Number.isInteger(config.sessionTtlHours) || config.sessionTtlHours < 1 || config.sessionTtlHours > 24) {
  throw new Error("SESSION_TTL_HOURS must be between 1 and 24");
}
if (config.nodeEnv === "production" && !config.publicOrigin.startsWith("https://")) {
  throw new Error("PUBLIC_ORIGIN must use HTTPS in production");
}
// 32.1.0: a production identity provider is always reached over TLS (this also
// keeps the plain-HTTP local development provider out of production).
if (config.nodeEnv === "production" && !config.oidcIssuer.startsWith("https://")) {
  throw new Error("OIDC_ISSUER must use HTTPS in production");
}

let databaseUrl;
try { databaseUrl = new URL(config.databaseUrl); } catch { throw new Error("DATABASE_URL must be a valid URL"); }
if (PLACEHOLDER_SECRETS.has(decodeURIComponent(databaseUrl.password).toLowerCase())) {
  throw new Error("DATABASE_URL uses a placeholder password; set a real database password");
}
if (config.nodeEnv === "production" && !config.databaseSsl &&
    !(config.databaseSslAllowPrivateNetwork && isPrivateDatabaseHost(databaseUrl.hostname))) {
  throw new Error("DATABASE_SSL=true is required in production (DATABASE_SSL_ALLOW_PRIVATE_NETWORK=true permits a non-TLS database only on a private/loopback host such as the compose service)");
}
if (config.cookieName.startsWith("__Host-") && !config.secureCookies) {
  throw new Error("__Host- session cookies require an https:// PUBLIC_ORIGIN");
}
if (!Number.isInteger(config.streamSessionRecheckMs) || config.streamSessionRecheckMs < 1000 || config.streamSessionRecheckMs > 300_000) {
  throw new Error("STREAM_SESSION_RECHECK_MS must be an integer between 1000 and 300000");
}
if (!Number.isInteger(config.sessionIdleMinutes) || config.sessionIdleMinutes < 5 || config.sessionIdleMinutes > 1440) {
  throw new Error("SESSION_IDLE_MINUTES must be between 5 and 1440");
}
if (!Number.isInteger(config.sessionMaxPerUser) || config.sessionMaxPerUser < 1 || config.sessionMaxPerUser > 1000) {
  throw new Error("SESSION_MAX_PER_USER must be between 1 and 1000");
}
if (!Number.isInteger(config.oidcHttpTimeoutMs) || config.oidcHttpTimeoutMs < 1000 || config.oidcHttpTimeoutMs > 60000) {
  throw new Error("OIDC_HTTP_TIMEOUT_MS must be between 1000 and 60000");
}
if (!["claim", "entra", "trusted"].includes(config.oidcEmailVerification)) {
  throw new Error("OIDC_EMAIL_VERIFICATION must be claim, entra or trusted");
}
if (config.demoMode && config.nodeEnv === "production") {
  throw new Error("EDUOS_DEMO_MODE cannot be enabled in production");
}

if (!Number.isInteger(config.loginRateLimit) || config.loginRateLimit < 10 || config.loginRateLimit > 100000) {
  throw new Error("LOGIN_RATE_LIMIT_PER_15M must be an integer between 10 and 100000");
}
const intIn = (name, value, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
};
intIn("PAGE_SIZE_DEFAULT", config.pageSizeDefault, 1, 100000);
intIn("PAGE_SIZE_MAX", config.pageSizeMax, 1, 100000);
if (config.pageSizeDefault > config.pageSizeMax) throw new Error("PAGE_SIZE_DEFAULT cannot exceed PAGE_SIZE_MAX");
if (!/^\d{1,6}(b|kb|mb)$/i.test(config.jsonBodyLimit)) throw new Error("JSON_BODY_LIMIT must look like 256kb or 1mb");
intIn("SIS_IMPORT_MAX_MB", config.sisImportMaxBytes / 1048576, 1, 1024);
intIn("GUARDIAN_INVITE_RATE_LIMIT_PER_HOUR", config.guardianInviteRateLimit, 1, 1000000);
intIn("GUARDIAN_ACCEPT_RATE_LIMIT_PER_15M", config.guardianAcceptRateLimit, 1, 1000);
intIn("FLOW_EVENT_RATE_LIMIT_PER_MIN", config.flowEventRateLimit, 1, 1000000);
intIn("WEBHOOK_ADMIN_RATE_LIMIT_PER_15M", config.webhookAdminRateLimit, 1, 1000000);
intIn("WEBHOOK_MAX_IN_FLIGHT", config.webhookMaxInFlight, 1, 1024);
intIn("WEBHOOK_GLOBAL_MAX_IN_FLIGHT", config.webhookGlobalMaxInFlight, 0, 16384);
intIn("SESSION_CACHE_MAX", config.sessionCacheMax, 1, 10000000);
intIn("BRANDING_UPLOAD_MAX_KB", config.brandingUploadMaxBytes / 1024, 64, 10240);
intIn("PUBLIC_BRANDING_RATE_LIMIT_PER_MIN", config.publicBrandingRateLimit, 1, 1000000);
if (!["local", "openai_compatible"].includes(config.christieProvider)) throw new Error("CHRISTIE_PROVIDER must be local or openai_compatible");
if (config.christieProvider !== "local") {
  if (!config.christieAllowExternal) throw new Error("CHRISTIE_PROVIDER=openai_compatible also requires CHRISTIE_ALLOW_EXTERNAL_PROVIDER=true");
  if (!/^https:\/\//.test(config.christieProviderUrl) && !(config.nodeEnv !== "production" && /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(config.christieProviderUrl)))
    throw new Error("CHRISTIE_PROVIDER_URL must be an https:// URL (http://localhost only outside production)");
  if (!config.christieProviderModel) throw new Error("CHRISTIE_PROVIDER_MODEL is required for an external Christie provider");
}
intIn("CHRISTIE_PROVIDER_TIMEOUT_MS", config.christieProviderTimeoutMs, 500, 60000);
intIn("CHRISTIE_RATE_LIMIT_PER_MIN", config.christieRateLimit, 1, 100000);
intIn("COMMS_RATE_LIMIT_PER_MIN", config.commsRateLimit, 1, 100000);
intIn("TRANSPORT_CHECKIN_RATE_LIMIT_PER_MIN", config.transportCheckinRateLimit, 1, 100000);
if (!["off", "log", "smtp"].includes(config.notifyEmailAdapter)) throw new Error("NOTIFY_EMAIL_ADAPTER must be off, log or smtp");
if (!["off", "log", "twilio"].includes(config.notifySmsAdapter)) throw new Error("NOTIFY_SMS_ADAPTER must be off, log or twilio");
if (config.notifySmsAdapter === "twilio") {
  if (!/^AC[0-9a-f]{32}$/i.test(config.twilioAccountSid) || !config.twilioAuthToken) throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required for Twilio");
  if (!/^VA[0-9a-f]{32}$/i.test(config.twilioVerifyServiceSid)) throw new Error("TWILIO_VERIFY_SERVICE_SID is required for Twilio SMS verification");
  if (config.twilioMessagingServiceSid && !/^MG[0-9a-f]{32}$/i.test(config.twilioMessagingServiceSid)) throw new Error("TWILIO_MESSAGING_SERVICE_SID must be a Twilio MG SID");
  if (!config.twilioMessagingServiceSid && !/^\+[1-9]\d{7,14}$/.test(config.twilioFromNumber)) throw new Error("Configure TWILIO_MESSAGING_SERVICE_SID or a valid TWILIO_FROM_NUMBER");
}
if (!["off", "log"].includes(config.notifyPushAdapter)) throw new Error("NOTIFY_PUSH_ADAPTER must be off or log (FCM is not configured yet)");
if (config.notifyEmailAdapter === "smtp") {
  if (!/^[a-z0-9.-]+$/i.test(config.notifySmtpHost)) throw new Error("NOTIFY_SMTP_HOST is required when NOTIFY_EMAIL_ADAPTER=smtp");
  if (config.notifySmtpPort !== 465) throw new Error("NOTIFY_SMTP_PORT must be 465 (implicit TLS only)");
  if (!config.notifySmtpUsername || !config.notifySmtpPassword) throw new Error("NOTIFY_SMTP_USERNAME and NOTIFY_SMTP_PASSWORD are required for SMTP");
  if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(config.notifySmtpFrom)) throw new Error("NOTIFY_SMTP_FROM must be a valid email address");
}
intIn("TWILIO_TIMEOUT_MS", config.twilioTimeoutMs, 1000, 30000);
intIn("NOTIFY_SMTP_TIMEOUT_MS", config.notifySmtpTimeoutMs, 1000, 60000);
if (config.metricsToken && config.metricsToken.length < 16) {
  throw new Error("METRICS_TOKEN must be at least 16 characters");
}
if (!["local", "openai_compatible"].includes(config.aiProvider)) throw new Error("AI_PROVIDER must be local or openai_compatible");
if (config.aiProvider !== "local") {
  if (!config.aiAllowExternal) throw new Error("AI_PROVIDER=openai_compatible also requires AI_ALLOW_EXTERNAL_PROVIDER=true");
  const checked = validateAiProviderUrl(config.aiProviderUrl, config.aiProviderAllowedHosts, { allowInsecureLoopback: config.aiAllowInsecureLoopback });
  if (!checked.ok) throw new Error(`AI_PROVIDER_URL rejected: ${checked.reason}`);
  if (!config.aiProviderModel) throw new Error("AI_PROVIDER_MODEL is required for an external AI provider");
}
intIn("AI_PROVIDER_TIMEOUT_MS", config.aiProviderTimeoutMs, 1000, 120000);
if (config.commerceSecretsKey && config.commerceSecretsKey.length < 32) {
  throw new Error("COMMERCE_SECRETS_KEY must be at least 32 characters");
}
intIn("COMMERCE_RECONCILE_INTERVAL_SECONDS", config.commerceReconcileIntervalSeconds, 0, 3600);
intIn("COMMERCE_RECONCILE_STALE_SECONDS", config.commerceReconcileStaleSeconds, 10, 86400);
intIn("CAPSULE_RELEASE_INTERVAL_SECONDS", config.capsuleReleaseIntervalSeconds, 0, 86400);
intIn("POWERSCHOOL_MAX_STUDENTS", config.powerschoolMaxStudents, 1_000, 200_000);
if (config.integrationsKey && config.integrationsKey.length < 32) {
  throw new Error("INTEGRATIONS_KEY must be at least 32 characters");
}
if (config.webhookSigningKey && config.webhookSigningKey.length < 32) {
  throw new Error("WEBHOOK_SIGNING_KEY must be at least 32 characters");
}
if (config.webhookPreviousSigningKey) {
  if (!config.webhookSigningKey) throw new Error("WEBHOOK_SIGNING_KEY_PREVIOUS needs WEBHOOK_SIGNING_KEY");
  if (config.webhookPreviousSigningKey.length < 32) throw new Error("WEBHOOK_SIGNING_KEY_PREVIOUS must be at least 32 characters");
  if (config.webhookPreviousSigningKey === config.webhookSigningKey) throw new Error("WEBHOOK_SIGNING_KEY_PREVIOUS must differ from WEBHOOK_SIGNING_KEY");
}
intIn("WEBHOOK_DISPATCH_INTERVAL_SECONDS", config.webhookDispatchIntervalSeconds, 0, 3600);
intIn("WEATHER_ALERTS_INTERVAL_SECONDS", config.weatherAlertsIntervalSeconds, 0, 3600);
intIn("API_RATE_LIMIT_PER_MINUTE", config.apiRateLimitPerMinute, 60, 100000);
if (config.nodeEnv === "production" && config.webhookSigningKey && !config.webhookAllowedHosts.length && !config.webhookAllowAnyPublicHost) {
  throw new Error("Webhooks are on in production without WEBHOOK_ALLOWED_HOSTS: list the receivers' domains, or set WEBHOOK_ALLOW_ANY_PUBLIC_HOST=true to allow any public HTTPS receiver");
}
