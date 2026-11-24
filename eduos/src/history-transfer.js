// TC-06: the signed history transfer package (pure; shared by the sending and
// receiving sides and their tests).
//
// When a student moves to another district, the old district's records office
// makes a package of the student's eligible history and sends it through its
// usual records channel; the new district's records office checks and accepts
// it (TC-06b). The package is canonical JSON signed with this deployment's
// Ed25519 transfer key, derived from HISTORY_TRANSFER_SIGNING_SECRET (or
// PORTFOLIO_SIGNING_SECRET); no private key is stored. The receiving side
// shows the key's fingerprint so it can be confirmed with the sending district
// before anything is accepted.
import crypto from "node:crypto";
import { canonical, sha256, signBytes, verifyBytes, publicKeyFingerprint } from "./eden/crypto.js";

export const TRANSFER_FORMAT = "eduos-history-transfer-1";
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** The deployment's transfer signing keys, or null when no secret is set (transfers then stay off). */
export function transferKeys(secret = process.env.HISTORY_TRANSFER_SIGNING_SECRET || process.env.PORTFOLIO_SIGNING_SECRET || "") {
  if (!secret) return null;
  if (secret.length < 32) throw new Error("HISTORY_TRANSFER_SIGNING_SECRET must be at least 32 characters");
  const seed = crypto.createHmac("sha256", secret).update("eduos-history-transfer-signing-v1").digest();
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
  return { private: priv.export({ type: "pkcs8", format: "der" }).toString("base64"), public: pub, fingerprint: publicKeyFingerprint(pub) };
}

/** Sign a package body. */
export function signTransfer(body, keys) {
  if (body?.format !== TRANSFER_FORMAT) throw new TypeError("not a transfer package");
  if (!keys) throw new Error("transfer_signing_not_configured");
  const text = canonical(body);
  return { ...body, signature: { alg: "Ed25519", publicKey: keys.public, keyFingerprint: keys.fingerprint, sha256: sha256(text), value: signBytes(keys.private, text) } };
}

/** Check a package: format, hash and signature. Returns the body and the signer's fingerprint. */
export function verifyTransfer(pkg) {
  if (!pkg || typeof pkg !== "object" || pkg.format !== TRANSFER_FORMAT || !pkg.signature) return { ok: false, reason: "not_a_transfer_package" };
  const { signature, ...body } = pkg;
  let text; try { text = canonical(body); } catch { return { ok: false, reason: "malformed" }; }
  if (signature.alg !== "Ed25519" || typeof signature.publicKey !== "string" || typeof signature.value !== "string") return { ok: false, reason: "malformed" };
  if (sha256(text) !== signature.sha256) return { ok: false, reason: "altered" };
  let fp; try { fp = publicKeyFingerprint(signature.publicKey); } catch { return { ok: false, reason: "malformed" }; }
  if (fp !== signature.keyFingerprint) return { ok: false, reason: "altered" };
  let valid = false; try { valid = verifyBytes(signature.publicKey, text, signature.value); } catch { valid = false; }
  return valid ? { ok: true, body, fingerprint: fp } : { ok: false, reason: "bad_signature" };
}

/** Which kinds go on the records office's authority, and which need the family's agreement. */
export const RECORD_KINDS = ["official_record", "teacher_artifact", "system_milestone"];
export const FAMILY_KINDS = ["family_memory", "student_portfolio"];
export const TRANSFER_BASES = ["enrollment_request", "records_request", "family_request", "other"];

const ENTRY_TYPES = ["achievement", "project", "coursework", "reflection", "event", "portfolio_artifact", "educator_note", "system_milestone"];
const SOURCES = ["student", "guardian", "teacher", "school", "district", "sis", "system", "other"];
const AUDIENCES = ["student", "family", "classroom", "school"];
const str = (v, max, min = 0) => typeof v === "string" && v.trim().length >= min && v.length <= max;
const isDate = v => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
export const MAX_TRANSFER_ITEMS = 2000;

/**
 * The receiving side's reading of a verified package body: what it says about
 * the sender and the student, and each item ready to be added if accepted.
 * Anything that doesn't fit the format is refused as a whole (it was signed
 * that way, so it isn't something to repair here).
 */
export function readTransfer(body) {
  const b = body || {}, src = b.source || {}, st = b.student || {};
  if (!str(b.packageId, 64, 1) || !isDate(b.createdAt) || !str(src.districtName, 200, 1) || !str(String(src.districtId ?? ""), 64, 1)
      || !str(st.name, 200, 1) || !Array.isArray(b.items) || b.items.length > MAX_TRANSFER_ITEMS) return { ok: false, reason: "malformed" };
  const items = [];
  for (const i of b.items) {
    if (!i || typeof i !== "object" || !str(i.sourceEntryId, 64, 1) || !Number.isInteger(i.revision) || i.revision < 1
        || !ENTRY_TYPES.includes(i.type) || ![...RECORD_KINDS, ...FAMILY_KINDS].includes(i.kind) || !str(i.title, 180, 1)
        || !(i.body === undefined || i.body === null || typeof i.body === "string") || !isDate(i.occurredAt)
        || !(i.schoolYear === undefined || i.schoolYear === null || str(i.schoolYear, 32))
        || !(i.photos === undefined || Array.isArray(i.photos))) return { ok: false, reason: "malformed" };
    if (FAMILY_KINDS.includes(i.kind) && b.includes?.familyItems !== true) return { ok: false, reason: "malformed" };
    // Photos aren't in the file; keep what they showed with the item.
    const photos = (i.photos || []).map(p => [p?.description, p?.caption].filter(x => typeof x === "string" && x.trim()).join(": ").slice(0, 300)).filter(Boolean);
    let text = typeof i.body === "string" ? i.body : "";
    if (photos.length) text += `${text ? "\n\n" : ""}Photos (not transferred): ${photos.join("; ")}`;
    items.push({ sourceEntryId: i.sourceEntryId, revision: i.revision, type: i.type, kind: i.kind, title: i.title.trim(),
      body: text.slice(0, 12000), occurredAt: new Date(i.occurredAt).toISOString(), schoolYear: i.schoolYear?.trim() || null,
      source: SOURCES.includes(i.source) ? i.source : "other", audience: AUDIENCES.includes(i.audience) ? i.audience : null,
      author: str(i.author, 200, 1) ? i.author.trim() : null });
  }
  const meta = { packageId: b.packageId, packagedAt: new Date(b.createdAt).toISOString(), sourceDistrictId: String(src.districtId),
    sourceDistrictName: src.districtName.trim(), sourceSchoolName: str(src.schoolName, 200) ? src.schoolName.trim() : "",
    addressedTo: str(b.receiving?.name, 200, 1) ? b.receiving.name.trim() : null,
    basis: str(b.basis?.kind, 40, 1) ? b.basis.kind : "other", basisNote: str(b.basis?.note, 500) ? b.basis.note.trim() : "",
    includesFamily: b.includes?.familyItems === true, studentName: st.name.trim(),
    studentNumber: str(st.localStudentNumber, 100, 1) ? st.localStudentNumber.trim() : null,
    studentGrade: st.gradeLevel === null || st.gradeLevel === undefined ? null : String(st.gradeLevel).slice(0, 20) };
  return { ok: true, meta, items };
}
