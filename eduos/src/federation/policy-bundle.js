// FED-05: signed, versioned policy bundles from Master Control to a district.
//
// Master Control signs one bundle per district per release (Ed25519 over
// canonical JSON, key derived from MC_POLICY_SIGNING_SECRET). A district's
// EduOS checks it against the public key it was given (MC_POLICY_PUBLIC_KEY)
// and that it is addressed to that district. Pure functions; no I/O.
import crypto from "node:crypto";

export const BUNDLE_FORMAT = "eduos-policy-bundle-1";
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const LABEL = "eduos-master-control-policy-signing-v1";

export function canonical(v) {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) throw new TypeError("non-finite number");
    return JSON.stringify(v ?? null);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
export const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
export const fingerprintOf = spkiB64 => sha256(Buffer.from(spkiB64, "base64")).slice(0, 32);

/** Signing keys from the secret, or null when it isn't set. */
export function bundleKeys(secret) {
  if (!secret) return null;
  if (secret.length < 32) throw new Error("MC_POLICY_SIGNING_SECRET must be at least 32 characters");
  const seed = crypto.createHmac("sha256", secret).update(LABEL).digest();
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
  return { private: priv, public: pub, fingerprint: fingerprintOf(pub) };
}

export function signBundle(body, keys) {
  if (body?.format !== BUNDLE_FORMAT) throw new TypeError("not a policy bundle");
  if (!keys) throw new Error("policy_signing_not_configured");
  const text = canonical(body);
  return { ...body, signature: { alg: "Ed25519", keyFingerprint: keys.fingerprint, sha256: sha256(text),
    value: crypto.sign(null, Buffer.from(text), keys.private).toString("base64") } };
}

/** Parse a configured public key: base64 SPKI DER, or PEM. */
export function parsePublicKey(text) {
  if (!text) return null;
  try {
    const key = /BEGIN PUBLIC KEY/.test(text) ? crypto.createPublicKey(text) : crypto.createPublicKey({ key: Buffer.from(text.trim(), "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return null;
    const spki = key.export({ type: "spki", format: "der" }).toString("base64");
    return { key, spki, fingerprint: fingerprintOf(spki) };
  } catch { return null; }
}

/**
 * Check a bundle against the trusted public key. Returns {ok, body} or
 * {ok:false, reason}: not_a_policy_bundle, malformed, altered, wrong_key,
 * bad_signature.
 */
export function verifyBundle(pkg, trusted) {
  if (!pkg || typeof pkg !== "object" || pkg.format !== BUNDLE_FORMAT) return { ok: false, reason: "not_a_policy_bundle" };
  const { signature, ...body } = pkg;
  if (!signature || signature.alg !== "Ed25519" || typeof signature.value !== "string" || typeof signature.sha256 !== "string") return { ok: false, reason: "malformed" };
  let text; try { text = canonical(body); } catch { return { ok: false, reason: "malformed" }; }
  if (sha256(text) !== signature.sha256) return { ok: false, reason: "altered" };
  if (!trusted || signature.keyFingerprint !== trusted.fingerprint) return { ok: false, reason: "wrong_key" };
  let good = false;
  try { good = crypto.verify(null, Buffer.from(text), trusted.key, Buffer.from(signature.value, "base64")); } catch { good = false; }
  if (!good) return { ok: false, reason: "bad_signature" };
  const ok = Number.isInteger(body.version) && body.version >= 1 && typeof body.bundle_id === "string" && body.district && typeof body.district.tenant_ref === "string"
    && Array.isArray(body.policies) && body.policies.every(p => p && typeof p.id === "string" && Object.hasOwn(p, "value"));
  return ok ? { ok: true, body, sha256: signature.sha256 } : { ok: false, reason: "malformed" };
}
