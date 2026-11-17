// EduOS 37.6.0 Wallet: W3C Verifiable Credentials 2.0 / 1EdTech Open Badges 3.0
// documents signed with the W3C Data Integrity "eddsa-jcs-2022" cryptosuite
// (W3C Recommendation "Data Integrity EdDSA Cryptosuites v1.0", May 2025).
// PURE apart from node:crypto: no I/O, no network.
//
// Honest profile statement (also in docs/CREDENTIALS-WALLET.md):
//   * The credential is a real OB 3.0 OpenBadgeCredential (VC Data Model 2.0
//     contexts, AchievementSubject, Achievement, hashed IdentityObject).
//   * It is signed with eddsa-jcs-2022 (JSON Canonicalization Scheme), which is
//     a valid W3C Data Integrity proof. The OB 3.0 spec's own examples use
//     eddsa-rdfc-2022 or VC-JWT, so this is a PARTIAL profile: not 1EdTech
//     certified, no credentialStatus/status list (revocation is checked at the
//     issuing district's verify endpoint), no refreshService.
//   * The issuer is a did:key per school, derived from WALLET_ISSUER_SECRET.
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// base58btc + multibase + multicodec
// ---------------------------------------------------------------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58btcEncode(bytes) {
  const buf = Buffer.from(bytes);
  let zeros = 0; while (zeros < buf.length && buf[zeros] === 0) zeros++;
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return "1".repeat(zeros) + out;
}
export function base58btcDecode(text) {
  if (typeof text !== "string" || !/^[1-9A-HJ-NP-Za-km-z]*$/.test(text)) throw new Error("invalid base58btc");
  let zeros = 0; while (zeros < text.length && text[zeros] === "1") zeros++;
  let n = 0n;
  for (const ch of text) n = n * 58n + BigInt(B58.indexOf(ch));
  let hex = n === 0n ? "" : n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, "hex")]);
}
const ED25519_PUB = Buffer.from([0xed, 0x01]);
const ED25519_PRIV = Buffer.from([0x80, 0x26]);
export const multibasePublicKey = pub => "z" + base58btcEncode(Buffer.concat([ED25519_PUB, pub]));
export const multibaseSecretKey = seed => "z" + base58btcEncode(Buffer.concat([ED25519_PRIV, seed]));
export function publicKeyFromMultibase(mb) {
  if (typeof mb !== "string" || mb[0] !== "z") throw new Error("expected base58btc multibase");
  const raw = base58btcDecode(mb.slice(1));
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) throw new Error("not an Ed25519 multikey");
  return raw.subarray(2);
}
export function seedFromMultibase(mb) {
  const raw = base58btcDecode(String(mb).slice(1));
  if (raw.length !== 34 || raw[0] !== 0x80 || raw[1] !== 0x26) throw new Error("not an Ed25519 secret multikey");
  return raw.subarray(2);
}
export const didKeyFromPublic = pub => `did:key:${multibasePublicKey(pub)}`;
export function verificationMethodFor(pub) { const mb = multibasePublicKey(pub); return `did:key:${mb}#${mb}`; }
/** did:key:z6Mk...#z6Mk... -> raw public key (the only DID method this verifier resolves). */
export function resolveDidKey(vm) {
  const m = /^did:key:(z6Mk[1-9A-HJ-NP-Za-km-z]+)(#(z6Mk[1-9A-HJ-NP-Za-km-z]+))?$/.exec(String(vm || ""));
  if (!m || (m[3] && m[3] !== m[1])) throw new Error("unsupported verification method (did:key Ed25519 only)");
  return publicKeyFromMultibase(m[1]);
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
export function keyPairFromSeed(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(crypto.createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  return { privateKey, publicKey: pub, did: didKeyFromPublic(pub) };
}
function publicKeyObject(pub) {
  return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pub).toString("base64url") }, format: "jwk" });
}
/** Per-school issuer key, derived (HKDF-SHA256) from the deployment secret: no private key is stored. */
export function deriveIssuerSeed(secret, districtId, schoolId) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("WALLET_ISSUER_SECRET must be at least 32 characters");
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from(String(districtId), "utf8"),
    Buffer.from(`eduos-wallet-issuer:v1:${schoolId}`, "utf8"), 32));
}

// ---------------------------------------------------------------------------
// RFC 8785 JSON Canonicalization Scheme (for the JSON values credentials use).
// ---------------------------------------------------------------------------
export function jcs(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("JCS: non-finite number"); return JSON.stringify(value); }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort((a, b) => {
      // Sort by UTF-16 code units (JS default string comparison).
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return `{${keys.map(k => `${JSON.stringify(k)}:${jcs(value[k])}`).join(",")}}`;
  }
  throw new Error(`JCS: unsupported type ${typeof value}`);
}
const sha256 = text => crypto.createHash("sha256").update(text, "utf8").digest();

// ---------------------------------------------------------------------------
// eddsa-jcs-2022: create + verify a DataIntegrityProof.
// ---------------------------------------------------------------------------
export const CRYPTOSUITE = "eddsa-jcs-2022";
function hashData(document, proofConfig) {
  return Buffer.concat([sha256(jcs(proofConfig)), sha256(jcs(document))]);
}
export function signDataIntegrity(unsecured, { seed, created = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), proofPurpose = "assertionMethod" }) {
  const { privateKey, publicKey } = keyPairFromSeed(seed);
  const doc = structuredClone(unsecured);
  delete doc.proof;
  const proofConfig = { type: "DataIntegrityProof", cryptosuite: CRYPTOSUITE, created, verificationMethod: verificationMethodFor(publicKey), proofPurpose };
  if (doc["@context"]) proofConfig["@context"] = doc["@context"];
  const signature = crypto.sign(null, hashData(doc, proofConfig), privateKey);
  const proof = { ...proofConfig, proofValue: "z" + base58btcEncode(signature) };
  delete proof["@context"];
  return { ...doc, proof: { type: proof.type, cryptosuite: proof.cryptosuite, created: proof.created,
    verificationMethod: proof.verificationMethod, proofPurpose: proof.proofPurpose, proofValue: proof.proofValue } };
}
/** -> {verified, reason?, verificationMethod?} ; never throws on bad input. */
export function verifyDataIntegrity(secured, { expectedPurpose = "assertionMethod" } = {}) {
  try {
    if (!secured || typeof secured !== "object" || Array.isArray(secured)) return { verified: false, reason: "not_an_object" };
    const proof = secured.proof;
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) return { verified: false, reason: "no_proof" };
    if (proof.type !== "DataIntegrityProof" || proof.cryptosuite !== CRYPTOSUITE) return { verified: false, reason: "unsupported_proof" };
    if (proof.proofPurpose !== expectedPurpose) return { verified: false, reason: "wrong_purpose" };
    if (typeof proof.proofValue !== "string" || proof.proofValue[0] !== "z") return { verified: false, reason: "bad_proof_value" };
    const pub = resolveDidKey(proof.verificationMethod);
    const doc = { ...secured }; delete doc.proof;
    const proofConfig = { ...proof }; delete proofConfig.proofValue;
    if (proof["@context"]) {
      if (jcs(proof["@context"]) !== jcs(doc["@context"])) return { verified: false, reason: "context_mismatch" };
    } else if (doc["@context"]) proofConfig["@context"] = doc["@context"];
    const sig = base58btcDecode(proof.proofValue.slice(1));
    if (sig.length !== 64) return { verified: false, reason: "bad_proof_value" };
    const ok = crypto.verify(null, hashData(doc, proofConfig), publicKeyObject(pub), sig);
    return ok ? { verified: true, verificationMethod: proof.verificationMethod } : { verified: false, reason: "signature_invalid" };
  } catch (e) {
    return { verified: false, reason: "malformed", detail: String(e.message || e).slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------
// Open Badges 3.0 OpenBadgeCredential
// ---------------------------------------------------------------------------
export const VC_V2 = "https://www.w3.org/ns/credentials/v2";
export const OB_V3 = "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json";
export const OB_SCHEMA = "https://purl.imsglobal.org/spec/ob/v3p0/schema/json/ob_v3p0_achievementcredential_schema.json";
const KIND_LABEL = { course_completion: "Course completion", standard_mastery: "Standard mastery", award: "Award" };

/** Display name as the holder chose: initials ("Ava M."), full, or none. */
export function displayName(fullName, mode) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (mode === "full") return parts.join(" ") || null;
  if (mode === "initials") return parts.length ? (parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0]}.` : parts[0]) : null;
  return null;
}

/**
 * credential: {id, kind, title, description, issuedAt, edalEntryId, edalEntryHash?}
 * learner: {fullName, salt}  (salt: stable per learner+credential, never published alone)
 * school: {id, name, url}
 */
export function buildOpenBadge({ credential, learner, school, nameDisplay = "initials", verifyBase }) {
  const salt = learner.salt;
  const identityHash = "sha256$" + crypto.createHash("sha256").update(String(learner.fullName || "").trim().toLowerCase() + salt, "utf8").digest("hex");
  const shown = displayName(learner.fullName, nameDisplay);
  // With "none" the credential carries no name at all, not even the hashed
  // one: a salted name hash can be confirmed by anyone who guesses the name.
  const subject = {
    type: ["AchievementSubject"],
    ...(nameDisplay === "none" ? {} : { identifier: [{ type: "IdentityObject", identityHash, identityType: "name", hashed: true, salt }] }),
    achievement: {
      id: `urn:uuid:${credential.achievementId || credential.id}`,
      type: ["Achievement"],
      achievementType: credential.kind === "award" ? "Award" : credential.kind === "standard_mastery" ? "Competency" : "Course",
      name: credential.title,
      description: credential.description || `${KIND_LABEL[credential.kind] || "Achievement"} at ${school.name}`,
      criteria: { narrative: credential.criteria || `${KIND_LABEL[credential.kind] || "Achievement"} recorded by ${school.name} on its signed EduOS ledger (EDAL).` }
    }
  };
  if (shown) subject.name = shown;
  return {
    "@context": [VC_V2, OB_V3],
    id: `urn:uuid:${credential.id}`,
    type: ["VerifiableCredential", "OpenBadgeCredential"],
    name: credential.title,
    issuer: { id: school.did, type: ["Profile"], name: school.name, ...(school.url ? { url: school.url } : {}) },
    validFrom: new Date(credential.issuedAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
    credentialSubject: subject,
    credentialSchema: [{ id: OB_SCHEMA, type: "1EdTechJsonSchemaValidator2019" }],
    // Built on the EDAL ledger: the entry hash lets the issuer re-check the record.
    ...(credential.edalEntryHash ? { evidence: [{ type: ["Evidence"], name: "EduOS ledger (EDAL) entry",
      description: `EDAL entry hash ${credential.edalEntryHash}`, ...(verifyBase ? { id: `${verifyBase}#edal-${credential.edalEntryHash.slice(0, 16)}` } : {}) }] } : {})
  };
}
export function signOpenBadge(badge, seed, created) { return signDataIntegrity(JSON.parse(JSON.stringify(badge)), { seed, created }); }

/** Minimum fields for the public verify page. */
export function minimalView(vc) {
  const s = vc?.credentialSubject || {};
  return {
    achievement: s.achievement?.name || vc?.name || null,
    achievementType: s.achievement?.achievementType || null,
    description: s.achievement?.description || null,
    issuer: vc?.issuer?.name || null,
    issuerId: vc?.issuer?.id || null,
    issued: vc?.validFrom || null,
    holder: s.name || null
  };
}
export function credentialUuid(vc) {
  const m = /^urn:uuid:([0-9a-f-]{36})$/i.exec(String(vc?.id || ""));
  return m ? m[1].toLowerCase() : null;
}
