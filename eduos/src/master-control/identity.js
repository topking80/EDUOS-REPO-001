// FED-04: trusted identity providers for Master Control.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createOidc } from "./oidc.js";
import { appendAudit } from "./audit.js";

export const PRIMARY = "primary";
// amr values that show a second factor (RFC 8176), plus Entra's "mfa".
const MFA_AMR = new Set(["mfa", "otp", "hwk", "swk", "sms", "tel", "fpt", "face", "iris", "retina", "vbm", "sc", "pop"]);

/**
 * A provider's client secret: from the file named by <NAME>_FILE (so a
 * mounted secret can be rotated in place without a restart), else from the
 * environment variable <NAME>. Read on every use.
 */
export function readProviderSecret(name, env = process.env) {
  const file = env[`${name}_FILE`];
  if (file) {
    try { return readFileSync(file, "utf8").trim() || null; } catch { return null; }
  }
  return env[name] || null;
}

/**
 * One OIDC client per provider. The client is rebuilt whenever anything it
 * was built from changes: issuer, client ID, scopes or the secret itself.
 * The secret is compared through an HMAC with a key that exists only in
 * this process, so the cache never holds a reusable fingerprint of it.
 */
export function providerRegistry(cfg, { create = createOidc, env = process.env } = {}) {
  const cache = new Map(); // provider id -> { fingerprint, client }
  const key = crypto.randomBytes(32);
  return {
    client(row) {
      const secret = readProviderSecret(row.client_secret_env, env);
      if (!secret) throw Object.assign(new Error(`${row.client_secret_env} is not set`), { code: "provider_secret_missing" });
      const fingerprint = crypto.createHmac("sha256", key).update(JSON.stringify([row.issuer, row.client_id, row.scopes, secret])).digest("hex");
      const hit = cache.get(row.id);
      if (hit && hit.fingerprint === fingerprint) return hit.client;
      const client = create({ issuer: row.issuer, clientId: row.client_id, clientSecret: secret, scopes: row.scopes,
        redirectUri: cfg.oidcRedirectUri, timeoutMs: cfg.oidcHttpTimeoutMs, nodeEnv: cfg.nodeEnv });
      cache.set(row.id, { fingerprint, client });
      return client;
    },
  };
}

/**
 * Checks a provider's sign-in rules against the ID token's claims.
 * Returns null when they pass, else a reason.
 */
export function claimProblem(row, claims) {
  if (row.require_mfa) {
    const amr = Array.isArray(claims.amr) ? claims.amr : [];
    if (!amr.some(a => MFA_AMR.has(String(a).toLowerCase()))) return "mfa_required";
  }
  if (row.allowed_email_domains?.length) {
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    const domain = email.includes("@") ? email.split("@").pop() : "";
    if (claims.email_verified !== true || !row.allowed_email_domains.includes(domain)) return "email_domain_not_allowed";
  }
  return null;
}

/**
 * The MC_OIDC_* provider is "primary", scoped to the platform. Created at
 * start-up (or bootstrap) once the platform exists; operators from before
 * FED-04 are attached to it. Refuses to start if the configured issuer no
 * longer matches the stored one.
 */
export async function ensurePrimaryProvider(db, cfg) {
  return db.tx(async c => {
    if (!(await c.query("SELECT 1 FROM nodes WHERE id='platform'")).rowCount) return null;
    const { rows: [p] } = await c.query("SELECT * FROM identity_providers WHERE id=$1", [PRIMARY]);
    if (p && p.issuer !== cfg.oidcIssuer) throw new Error(`MC_OIDC_ISSUER (${cfg.oidcIssuer}) differs from the primary identity provider's issuer (${p.issuer}); change it in Master Control first`);
    if (!p) {
      await c.query(`INSERT INTO identity_providers(id, issuer, display_name, client_id, client_secret_env, scopes, scope_node_id, created_by)
        VALUES ($1,$2,'Primary sign-in',$3,'MC_OIDC_CLIENT_SECRET',$4,'platform','system')`, [PRIMARY, cfg.oidcIssuer, cfg.oidcClientId, cfg.oidcScopes]);
      await appendAudit(c, { actor: "system", action: "register_identity_provider", target_type: "identity_provider", target_id: PRIMARY, node_id: "platform",
        decision: "allowed", basis: { type: "configuration" }, detail: { issuer: cfg.oidcIssuer } });
    }
    else await c.query("UPDATE identity_providers SET client_id=$2, scopes=$3 WHERE id=$1", [PRIMARY, cfg.oidcClientId, cfg.oidcScopes]);
    await c.query("UPDATE operators SET idp_id=$1 WHERE idp_id IS NULL", [PRIMARY]);
    return PRIMARY;
  });
}
