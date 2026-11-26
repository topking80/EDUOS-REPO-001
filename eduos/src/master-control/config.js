// FED-03 Master Control configuration. Separate from EduOS's config: Master
// Control has its own database login, its own OIDC client and its own port,
// and never reads EduOS settings.
const env = process.env;
const req = name => { const v = env[name]; if (!v) throw new Error(`${name} is required for Master Control`); return v; };

export function loadConfig() {
  const origin = (env.MC_PUBLIC_ORIGIN || "http://localhost:3100").replace(/\/$/, "");
  const cfg = {
    nodeEnv: env.NODE_ENV || "development",
    port: Number(env.MC_PORT || env.PORT || 3100),
    databaseUrl: req("MC_DATABASE_URL"),
    schema: "master_control",
    publicOrigin: origin,
    secureCookies: origin.startsWith("https://"),
    oidcIssuer: req("MC_OIDC_ISSUER").replace(/\/$/, ""),
    oidcClientId: req("MC_OIDC_CLIENT_ID"),
    oidcClientSecret: req("MC_OIDC_CLIENT_SECRET"),
    oidcRedirectUri: env.MC_OIDC_REDIRECT_URI || `${origin}/mc/auth/callback`,
    oidcScopes: (env.MC_OIDC_SCOPES || "openid profile email").split(/\s+/).filter(Boolean),
    oidcHttpTimeoutMs: Number(env.MC_OIDC_HTTP_TIMEOUT_MS || 10000),
    sessionHours: Math.min(Math.max(Number(env.MC_SESSION_HOURS || 8), 1), 24),
    rateLimitPerMinute: Number(env.MC_RATE_LIMIT_PER_MINUTE || 300),
  };
  if (cfg.nodeEnv === "production" && !cfg.secureCookies) throw new Error("MC_PUBLIC_ORIGIN must be https in production");
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error("MC_PORT is invalid");
  return cfg;
}
