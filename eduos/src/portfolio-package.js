// TEACH-05: the portable teacher package. Its manifest is canonical JSON,
// hashed with SHA-256 and, when PORTFOLIO_SIGNING_SECRET (32+ characters) is
// set, signed with this deployment's Ed25519 key (derived from the secret;
// no private key is stored). Any EduOS can check the hash and the signature;
// a district still reviews what it lets in.
import crypto from "node:crypto";
import { canonical, sha256, signBytes, verifyBytes } from "./eden/crypto.js";

export const FORMAT = "EDUOS-PORTFOLIO-1";
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export function signingKeys(secret = process.env.PORTFOLIO_SIGNING_SECRET || "") {
  if (!secret) return null;
  if (secret.length < 32) throw new Error("PORTFOLIO_SIGNING_SECRET must be at least 32 characters");
  const seed = crypto.createHmac("sha256", secret).update("eduos-portfolio-signing-v1").digest();
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  return {
    private: priv.export({ type: "pkcs8", format: "der" }).toString("base64"),
    public: crypto.createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64")
  };
}

/** Hash and (if keys are given) sign a manifest. */
export function seal(manifest, keys = signingKeys()) {
  if (manifest?.format !== FORMAT) throw new TypeError("not a portfolio manifest");
  const text = canonical(manifest);
  return { sha256: sha256(text), signature: keys ? signBytes(keys.private, text) : null, publicKey: keys ? keys.public : null };
}

/** Check a manifest against its hash and, if signed, its signature. */
export function check(manifest, { sha256: hash, signature = null, publicKey = null }) {
  let text; try { text = canonical(manifest); } catch { return { ok: false, signed: false }; }
  if (manifest?.format !== FORMAT || sha256(text) !== hash) return { ok: false, signed: false };
  if (!signature) return { ok: true, signed: false };
  return { ok: Boolean(publicKey) && verifyBytes(publicKey, text, signature), signed: true };
}

/** Plain text of an item, for the student-name check. */
export function itemText(item) {
  const b = item.body || {};
  if (item.kind === "lesson") return [item.title, b.objective, b.content].join("\n");
  if (item.kind === "unit") return [item.title, b.summary, ...(b.lessons || []).flatMap(l => [l.title, l.objective, l.content])].join("\n");
  return [item.title, b.summary, ...(b.items || []).flatMap(i => [i.title, i.description, i.equipment])].filter(Boolean).join("\n");
}
