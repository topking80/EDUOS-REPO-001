// EduOS 32.7.0 EDEN: signed node identity under one trust root.
//
// This is NOT X.509 and NOT mutual TLS. It is a small, explicit certificate
// format (canonical JSON signed with Ed25519) with a three-level chain:
//
//   root (offline, src/eden/authority-cli.js)  ->  district hub  ->  school node
//
// Every node pins the root certificate. Each certificate carries an Ed25519
// signing key and (for hubs and nodes) an X25519 key used to seal DECN
// continuity packages to a partner node. Requests between tiers are signed
// (see signRequest/verifyRequest); transport encryption is TLS in production
// (plain HTTP only inside the local docker simulation network).
import crypto from "node:crypto";

export const CERT_VERSION = "EDEN-CERT-1";
export const SEAL_VERSION = "EDEN-SEAL-1";
export const BUNDLE_VERSION = "EDEN-BUNDLE-1";
const KINDS = new Set(["root", "district", "node"]);
const ISSUER_OF = { root: "root", district: "root", node: "district" };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Deterministic JSON: object keys sorted at every level; no undefined. */
export function canonical(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("non-finite number");
    if (value === undefined) throw new TypeError("undefined is not canonical");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}
export const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
const b64 = buf => Buffer.from(buf).toString("base64");
const unb64 = s => Buffer.from(String(s), "base64");

export function generateIdentityKeys({ box = true } = {}) {
  const sign = crypto.generateKeyPairSync("ed25519");
  const out = {
    signPrivate: b64(sign.privateKey.export({ type: "pkcs8", format: "der" })),
    signPublic: b64(sign.publicKey.export({ type: "spki", format: "der" }))
  };
  if (box) {
    const bx = crypto.generateKeyPairSync("x25519");
    out.boxPrivate = b64(bx.privateKey.export({ type: "pkcs8", format: "der" }));
    out.boxPublic = b64(bx.publicKey.export({ type: "spki", format: "der" }));
  }
  return out;
}
const privKey = der => crypto.createPrivateKey({ key: unb64(der), format: "der", type: "pkcs8" });
const pubKey = der => crypto.createPublicKey({ key: unb64(der), format: "der", type: "spki" });
export function signBytes(signPrivate, data) { return b64(crypto.sign(null, Buffer.from(data), privKey(signPrivate))); }
export function verifyBytes(signPublic, data, signature) {
  try {
    const key = pubKey(signPublic);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return crypto.verify(null, Buffer.from(data), key, unb64(signature));
  } catch { return false; }
}
export function publicKeyFingerprint(der) { return sha256(unb64(der)).slice(0, 32); }
/** Proof that the caller holds the private half of a signing key. */
export function proofOfPossession(signPrivate, challenge) { return signBytes(signPrivate, `EDEN-POP\n${challenge}`); }
export function checkProofOfPossession(signPublic, challenge, proof) { return verifyBytes(signPublic, `EDEN-POP\n${challenge}`, proof); }

/** Issue a certificate. `issuer` is null for the self-signed root. */
export function issueCertificate({ kind, id, name, districtId = null, schoolId = null, signPublic, boxPublic = null,
  days = 365, issuer = null, issuerPrivate, now = new Date() }) {
  if (!KINDS.has(kind)) throw new TypeError("kind must be root, district or node");
  if (!ID.test(String(id))) throw new TypeError("invalid certificate subject id");
  if (kind === "root" && issuer) throw new TypeError("the root certificate is self-signed");
  if (kind !== "root" && issuer?.subject?.kind !== ISSUER_OF[kind]) throw new TypeError(`a ${kind} certificate must be issued by a ${ISSUER_OF[kind]} certificate`);
  if (kind !== "root" && (!districtId || !UUID.test(districtId))) throw new TypeError("districtId is required");
  if (kind === "node" && (!schoolId || !UUID.test(schoolId))) throw new TypeError("a node certificate names its school");
  if (kind === "node" && issuer.subject.districtId !== districtId) throw new TypeError("a district may only issue node certificates for itself");
  const body = {
    v: CERT_VERSION,
    serial: crypto.randomUUID(),
    subject: { kind, id: String(id), name: String(name || id).slice(0, 120), districtId: districtId || null, schoolId: schoolId || null },
    keys: { sign: signPublic, box: boxPublic || null },
    issuer: issuer ? { kind: issuer.subject.kind, id: issuer.subject.id, serial: issuer.serial } : { kind: "root", id: String(id), serial: null },
    notBefore: new Date(now.getTime() - 5 * 60_000).toISOString(),
    notAfter: new Date(now.getTime() + days * 86_400_000).toISOString()
  };
  return { ...body, sig: signBytes(issuerPrivate, canonical(body)) };
}
export const certificateFingerprint = cert => sha256(canonical(cert));
function certBody(cert) { const { sig: _s, ...body } = cert; return body; }
function checkShape(cert) {
  return cert && cert.v === CERT_VERSION && typeof cert.sig === "string" && KINDS.has(cert?.subject?.kind) &&
    typeof cert?.keys?.sign === "string" && typeof cert.notBefore === "string" && typeof cert.notAfter === "string";
}
function inWindow(cert, now) {
  const nb = Date.parse(cert.notBefore), na = Date.parse(cert.notAfter);
  return Number.isFinite(nb) && Number.isFinite(na) && now >= nb && now <= na;
}

/**
 * Verify a certificate against the pinned root. `chain` holds the
 * intermediate (district) certificate for node certificates.
 * Returns { ok, reason, subject }.
 */
export function verifyCertificate(cert, { root, chain = [], now = Date.now(), revokedSerials = new Set() } = {}) {
  const fail = reason => ({ ok: false, reason });
  if (!checkShape(root) || root.subject.kind !== "root") return fail("no_pinned_root");
  if (!verifyBytes(root.keys.sign, canonical(certBody(root)), root.sig)) return fail("root_signature_invalid");
  if (!inWindow(root, now)) return fail("root_expired");
  if (!checkShape(cert)) return fail("malformed_certificate");
  if (revokedSerials.has(cert.serial)) return fail("revoked");
  if (cert.subject.kind === "root") {
    return certificateFingerprint(cert) === certificateFingerprint(root) ? { ok: true, subject: cert.subject } : fail("unknown_root");
  }
  let issuer;
  if (cert.subject.kind === "district") issuer = root;
  else {
    issuer = chain.find(c => checkShape(c) && c.subject.kind === "district" && c.serial === cert.issuer.serial);
    if (!issuer) return fail("issuer_not_in_chain");
    const up = verifyCertificate(issuer, { root, now, revokedSerials });
    if (!up.ok) return fail(`issuer_${up.reason}`);
    if (issuer.subject.districtId !== cert.subject.districtId) return fail("district_mismatch");
  }
  if (cert.issuer.kind !== issuer.subject.kind || cert.issuer.id !== issuer.subject.id || (cert.issuer.serial ?? null) !== (issuer.subject.kind === "root" ? root.serial : issuer.serial)) return fail("issuer_mismatch");
  if (!verifyBytes(issuer.keys.sign, canonical(certBody(cert)), cert.sig)) return fail("signature_invalid");
  if (!inWindow(cert, now)) return fail("expired_or_not_yet_valid");
  return { ok: true, subject: cert.subject };
}

// ---------------------------------------------------------------------------
// Signed requests (node -> hub). Replay-protected by timestamp + nonce.
// ---------------------------------------------------------------------------
export const REQUEST_SKEW_MS = 5 * 60_000;
export function requestSigningString({ method, path, timestamp, nonce, body }) {
  return `EDEN1\n${String(method).toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${sha256(body || "")}`;
}
export function signRequest({ nodeId, signPrivate, method, path, body = "", now = Date.now() }) {
  const timestamp = String(Math.floor(now / 1000)), nonce = crypto.randomBytes(16).toString("hex");
  return {
    "X-Eden-Node": nodeId, "X-Eden-Timestamp": timestamp, "X-Eden-Nonce": nonce,
    "X-Eden-Signature": signBytes(signPrivate, requestSigningString({ method, path, timestamp, nonce, body }))
  };
}
/** Checks the signature and clock window; the caller records the nonce. */
export function verifyRequestSignature({ signPublic, method, path, body, headers, now = Date.now() }) {
  const ts = String(headers["x-eden-timestamp"] || ""), nonce = String(headers["x-eden-nonce"] || ""), sig = String(headers["x-eden-signature"] || "");
  if (!/^\d{9,12}$/.test(ts) || !/^[0-9a-f]{32}$/.test(nonce) || !sig) return { ok: false, reason: "missing_signature" };
  if (Math.abs(now - Number(ts) * 1000) > REQUEST_SKEW_MS) return { ok: false, reason: "clock_skew" };
  if (!verifyBytes(signPublic, requestSigningString({ method, path, timestamp: ts, nonce, body }), sig)) return { ok: false, reason: "bad_signature" };
  return { ok: true, nonce, timestamp: Number(ts) };
}

// ---------------------------------------------------------------------------
// Signed, versioned bundles (root/district -> down the tree).
// ---------------------------------------------------------------------------
export const BUNDLE_KINDS = Object.freeze(["catalog", "branding", "lessons", "content", "revocations"]);
export function signBundle({ kind, version, payload, signerCert, signPrivate, scope = "district", now = new Date() }) {
  if (!BUNDLE_KINDS.includes(kind)) throw new TypeError("unknown bundle kind");
  if (!Number.isInteger(version) || version < 1) throw new TypeError("bundle version must be a positive integer");
  const body = { v: BUNDLE_VERSION, kind, version, scope, issuedAt: now.toISOString(), signer: { kind: signerCert.subject.kind, id: signerCert.subject.id, serial: signerCert.serial },
    payloadSha256: sha256(canonical(payload)), payload };
  return { ...body, sig: signBytes(signPrivate, canonical(body)) };
}
/** Verify a bundle's signature and chain; `minVersion` enforces monotonic versions. */
export function verifyBundle(bundle, { root, chain = [], minVersion = 0, now = Date.now() } = {}) {
  if (!bundle || bundle.v !== BUNDLE_VERSION || !BUNDLE_KINDS.includes(bundle.kind)) return { ok: false, reason: "malformed_bundle" };
  if (!Number.isInteger(bundle.version) || bundle.version <= minVersion) return { ok: false, reason: "stale_version" };
  const signer = bundle.signer?.kind === "root" ? root : chain.find(c => c?.serial === bundle.signer?.serial);
  if (!signer) return { ok: false, reason: "unknown_signer" };
  const v = verifyCertificate(signer, { root, chain, now });
  if (!v.ok) return { ok: false, reason: `signer_${v.reason}` };
  if (signer.subject.kind === "node") return { ok: false, reason: "nodes_cannot_sign_bundles" };
  const { sig, ...body } = bundle;
  if (sha256(canonical(bundle.payload)) !== bundle.payloadSha256) return { ok: false, reason: "payload_hash_mismatch" };
  if (!verifyBytes(signer.keys.sign, canonical(body), sig)) return { ok: false, reason: "bad_signature" };
  return { ok: true, signer: signer.subject };
}

// ---------------------------------------------------------------------------
// Sealed boxes for DECN continuity and return packages: X25519 ECDH with an
// ephemeral key, HKDF-SHA256, AES-256-GCM, signed by the sender. The district
// hub stores and relays the ciphertext but holds no key that can open it.
// ---------------------------------------------------------------------------
export function seal({ plaintext, recipientBoxPublic, senderId, senderSignPrivate, recipientId, purpose, ref }) {
  const eph = crypto.generateKeyPairSync("x25519");
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubKey(recipientBoxPublic) });
  const epk = b64(eph.publicKey.export({ type: "spki", format: "der" }));
  const header = { v: SEAL_VERSION, from: senderId, to: recipientId, purpose, ref: ref || null, epk, createdAt: new Date().toISOString() };
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(epk), Buffer.from(`EDEN-SEAL ${purpose}`), 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(canonical(header)));
  const ct = Buffer.concat([cipher.update(Buffer.from(typeof plaintext === "string" ? plaintext : canonical(plaintext))), cipher.final()]);
  const sealed = { ...header, iv: b64(iv), ct: b64(ct), tag: b64(cipher.getAuthTag()) };
  return { ...sealed, sig: signBytes(senderSignPrivate, canonical(sealed)) };
}
/** Opens a sealed box after checking the sender signature. Throws on any failure. */
export function open(box, { recipientBoxPrivate, senderSignPublic, expectPurpose }) {
  if (!box || box.v !== SEAL_VERSION) throw new Error("not an EDEN sealed box");
  if (expectPurpose && box.purpose !== expectPurpose) throw new Error("unexpected sealed box purpose");
  const { sig, ...sealed } = box;
  if (!verifyBytes(senderSignPublic, canonical(sealed), sig)) throw new Error("sealed box sender signature is invalid");
  const header = { v: box.v, from: box.from, to: box.to, purpose: box.purpose, ref: box.ref, epk: box.epk, createdAt: box.createdAt };
  const shared = crypto.diffieHellman({ privateKey: privKey(recipientBoxPrivate), publicKey: pubKey(box.epk) });
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(box.epk), Buffer.from(`EDEN-SEAL ${box.purpose}`), 32));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, unb64(box.iv));
  decipher.setAAD(Buffer.from(canonical(header)));
  decipher.setAuthTag(unb64(box.tag));
  return Buffer.concat([decipher.update(unb64(box.ct)), decipher.final()]).toString("utf8");
}

/** Env helpers: certificates and keys travel as base64(JSON) / base64(DER). */
export const encodeCert = cert => Buffer.from(JSON.stringify(cert)).toString("base64");
export function decodeCert(s) { if (!s) return null; try { return JSON.parse(Buffer.from(String(s), "base64").toString("utf8")); } catch { return null; } }
