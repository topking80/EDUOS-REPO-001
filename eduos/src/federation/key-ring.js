// FED-08: a ring of trusted Ed25519 public keys, so a signing key can be
// rotated without a gap and revoked when it is compromised.
//
// In EduOS, MC_POLICY_PUBLIC_KEY may list several Master Control keys
// (base64 SPKI separated by commas or spaces, or several PEM blocks). During
// a rotation it holds the old key and the new one; after the overlap the old
// one is removed. MC_POLICY_REVOKED_KEYS lists fingerprints that are never
// trusted again, even if still listed: anything signed with them is refused
// (key_revoked), and bundles already received under them stop being followed.
import { parsePublicKey } from "./policy-bundle.js";

const FP = /^[0-9a-f]{32}$/;

export function parseKeyRing(keysText = "", revokedText = "") {
  const revoked = new Set(String(revokedText || "").split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(s => FP.test(s)));
  const text = String(keysText || "");
  const parts = /BEGIN PUBLIC KEY/.test(text) ? text.match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/g) || [] : text.split(/[\s,]+/);
  const keys = [];
  for (const p of parts) {
    const k = parsePublicKey(p.trim());
    if (k && !revoked.has(k.fingerprint) && !keys.some(x => x.fingerprint === k.fingerprint)) keys.push(k);
  }
  return { keys, revoked, fingerprints: keys.map(k => k.fingerprint), get configured() { return keys.length > 0; } };
}

/** The ring from the environment (read each time, so a change takes effect on restart or reload). */
export function mcKeyRing(env = process.env) { return parseKeyRing(env.MC_POLICY_PUBLIC_KEY, env.MC_POLICY_REVOKED_KEYS); }

/**
 * Check a signed package with whichever ring key signed it. `verify` is
 * verifyBundle or verifyTerms, (pkg, key, ...rest) => {ok, reason}.
 * A package signed with a revoked key is refused as key_revoked (after the
 * format and tamper checks).
 */
export function verifyWithRing(verify, pkg, ring, ...rest) {
  const fp = pkg?.signature?.keyFingerprint;
  if (typeof fp === "string" && ring.revoked.has(fp)) {
    const r = verify(pkg, null, ...rest);
    return r.reason === "wrong_key" ? { ok: false, reason: "key_revoked" } : r;
  }
  return verify(pkg, ring.keys.find(k => k.fingerprint === fp) || ring.keys[0] || null, ...rest);
}
