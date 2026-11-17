// 37.6.0 Credentials Wallet settings. Kept in its own module (not config.js)
// so the Wallet stays an independent change.
//   WALLET_ISSUER_SECRET   >= 32 chars. Per-school Ed25519 issuer keys are
//                          DERIVED from it (HMAC-SHA256); no private key is
//                          stored in the database. Unset = export disabled.
//   WALLET_SHARE_MAX_DAYS  longest share link a holder may create (1-365, default 90).
//   PUBLIC_VERIFY_RATE_LIMIT_PER_MIN  public verify page limit per IP (default 60).
export function walletSettings(env = process.env) {
  const secret = env.WALLET_ISSUER_SECRET || "";
  if (secret && secret.length < 32) throw new Error("WALLET_ISSUER_SECRET must be at least 32 characters");
  const int = (name, def, min, max) => {
    const v = Number(env[name] ?? def);
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return v;
  };
  return {
    issuerSecret: secret,
    shareMaxDays: int("WALLET_SHARE_MAX_DAYS", 90, 1, 365),
    publicVerifyRateLimit: int("PUBLIC_VERIFY_RATE_LIMIT_PER_MIN", 60, 1, 100000)
  };
}
export const wallet = walletSettings();
