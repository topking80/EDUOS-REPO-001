// TEACH-06: a package file for approved storage. The package (its manifest,
// hash and signature) is encrypted to one approved storage device: X25519
// with an ephemeral key, HKDF-SHA256, AES-256-GCM over the gzipped package,
// with the file's header as associated data. Only that device's unlock code
// (its private key, given out once when district IT approves the device)
// opens it, so a copy on an unapproved drive can't be read.
import crypto from "node:crypto";
import zlib from "node:zlib";

export const FILE_FORMAT = "EDUOS-PORTFOLIO-FILE-1";
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const INFO = Buffer.from("eduos-portfolio-file-v1");
const b64 = b => Buffer.from(b).toString("base64");
// Unlock codes are base32 (A-Z, 2-7): no dashes of their own, any case, easy to read off a label.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CODE_RE = /^[A-Z2-7]{52}$/;
function toBase32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function fromBase32(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of str) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}

/** A new device key pair: the public key (stored) and the unlock code (given out once). */
export function newDeviceKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const raw = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  return { publicKey: b64(publicKey.export({ format: "der", type: "spki" })), code: toBase32(raw) };
}
/** The code as people read it: groups of four. */
export const formatCode = code => code.match(/.{1,4}/g).join("-");
export const normalizeCode = s => String(s || "").replace(/[\s-]/g, "").toUpperCase();
export const keyFingerprint = pub => crypto.createHash("sha256").update(Buffer.from(pub, "base64")).digest("hex").slice(0, 16);

const header = f => Buffer.from(JSON.stringify([f.format, f.deviceId, f.deviceName, f.epk, f.salt, f.iv]));

export function encryptForDevice({ deviceId, deviceName, publicKey }, payload) {
  const devicePub = crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
  const eph = crypto.generateKeyPairSync("x25519");
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = Buffer.from(crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: devicePub }), salt, INFO, 32));
  const f = { format: FILE_FORMAT, deviceId, deviceName, epk: b64(eph.publicKey.export({ format: "der", type: "spki" })), salt: b64(salt), iv: b64(iv) };
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header(f));
  const ct = Buffer.concat([cipher.update(zlib.gzipSync(JSON.stringify(payload))), cipher.final()]);
  return { ...f, tag: b64(cipher.getAuthTag()), ct: b64(ct) };
}

/** Opens a file with the device's unlock code. Throws "wrong_code_or_damaged_file" otherwise. */
export function decryptWithCode(file, code) {
  const c = normalizeCode(code);
  if (!file || file.format !== FILE_FORMAT || !CODE_RE.test(c)) throw new Error("wrong_code_or_damaged_file");
  try {
    const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, fromBase32(c)]), format: "der", type: "pkcs8" });
    const epk = crypto.createPublicKey({ key: Buffer.from(file.epk, "base64"), format: "der", type: "spki" });
    const key = Buffer.from(crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey: priv, publicKey: epk }), Buffer.from(file.salt, "base64"), INFO, 32));
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "base64"));
    d.setAAD(header(file)); d.setAuthTag(Buffer.from(file.tag, "base64"));
    const gz = Buffer.concat([d.update(Buffer.from(file.ct, "base64")), d.final()]);
    return JSON.parse(zlib.gunzipSync(gz, { maxOutputLength: 8_000_000 }).toString("utf8"));
  } catch { throw new Error("wrong_code_or_damaged_file"); }
}
