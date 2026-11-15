// Connector client secrets at rest: AES-256-GCM under a key derived from
// INTEGRATIONS_KEY, bound to the connector and district (associated data), so a
// stored secret can't be copied onto another connector row and decrypted there.
import crypto from "node:crypto";

const VERSION = "v1";
const keyFrom = (master) => crypto.createHash("sha256").update(`eduos-integrations:${master}`).digest();
const aad = (districtId, connectorId) => Buffer.from(`${districtId}:${connectorId}`);

export function encryptSecret(master, districtId, connectorId, plaintext) {
  if (!master) throw new Error("integrations_disabled");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyFrom(master), iv);
  c.setAAD(aad(districtId, connectorId));
  const ct = Buffer.concat([c.update(String(plaintext), "utf8"), c.final()]);
  return [VERSION, iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(master, districtId, connectorId, stored) {
  const [v, iv, tag, ct] = String(stored).split(".");
  if (v !== VERSION || !iv || !tag || ct === undefined) throw new Error("secret_unreadable");
  const d = crypto.createDecipheriv("aes-256-gcm", keyFrom(master), Buffer.from(iv, "base64url"));
  d.setAAD(aad(districtId, connectorId));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
