import crypto from "node:crypto";
import { config } from "./config.js";

function encryptionKey(cfg = config) {
  const key = Buffer.from(cfg.fcmTokenEncryptionKey || "", "base64");
  if (key.length !== 32) throw new Error("FCM token encryption key is not configured");
  return key;
}

export function hashPushToken(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 4096 || /\s/.test(token))
    throw new TypeError("invalid FCM registration token");
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function encryptPushToken(token, cfg = config) {
  hashPushToken(token);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(cfg), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptPushToken(value, cfg = config) {
  if (typeof value !== "string") throw new TypeError("invalid encrypted token");
  const [ivText, tagText, cipherText, extra] = value.split(".");
  if (!ivText || !tagText || !cipherText || extra !== undefined) throw new TypeError("invalid encrypted token");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(cfg), Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(cipherText, "base64")), decipher.final()]).toString("utf8");
}
