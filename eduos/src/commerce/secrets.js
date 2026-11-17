// EduOS 37.7.1: a district's payment-processor credentials at rest.
// AES-256-GCM under a key derived from COMMERCE_SECRETS_KEY, bound to the
// district and processor (associated data), so a stored blob can't be copied
// to another district or processor row and decrypted there. Same scheme as
// connector secrets (src/integrations/secrets.js), separate key.
// Secrets are write-only: no route ever returns them, only which are set.
import crypto from "node:crypto";

const VERSION = "c1";
const keyFrom = master => crypto.createHash("sha256").update(`eduos-commerce-secrets:${master}`).digest();
const aad = (districtId, processor) => Buffer.from(`commerce:${districtId}:${processor}`);

export class SecretsKeyMissing extends Error { constructor() { super("commerce_secrets_key_missing"); this.code = "commerce_secrets_key_missing"; } }

/** Encrypt an object of secret fields. Returns null for an empty object. */
export function sealSecrets(master, districtId, processor, secrets) {
  const keys = Object.keys(secrets || {}).filter(k => typeof secrets[k] === "string" && secrets[k] !== "");
  if (!keys.length) return null;
  if (!master) throw new SecretsKeyMissing();
  const body = JSON.stringify(Object.fromEntries(keys.sort().map(k => [k, secrets[k]])));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyFrom(master), iv);
  c.setAAD(aad(districtId, processor));
  const ct = Buffer.concat([c.update(body, "utf8"), c.final()]);
  return [VERSION, iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function openSecrets(master, districtId, processor, stored) {
  if (!stored) return {};
  if (!master) throw new SecretsKeyMissing();
  const [v, iv, tag, ct] = String(stored).split(".");
  if (v !== VERSION || !iv || !tag || ct === undefined) throw new Error("commerce_secrets_unreadable");
  const d = crypto.createDecipheriv("aes-256-gcm", keyFrom(master), Buffer.from(iv, "base64url"));
  d.setAAD(aad(districtId, processor));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8"));
}
