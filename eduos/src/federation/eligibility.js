// SPORT-05: signed athlete eligibility attestations from a district to its
// state athletic association. PURE: no I/O.
//
// An attestation is a snapshot: on `as_of`, by the district's own rules, each
// listed athlete was eligible, not eligible, or pending (not enough records
// to decide). It lists only athletes whose parent or guardian agreed to share
// with that association, and for each only a reference, name, grade and
// status. No grades, courses, attendance, reasons, health or contact details.
// It is signed with the district's EduOS exchange key (FED-06) and expires.
import crypto from "node:crypto";
import { canonical, sha256 } from "./policy-bundle.js";

export const ATTESTATION_FORMAT = "eduos-eligibility-attestation-1";
export const STATUSES = ["eligible", "not_eligible", "pending"];
export const MAX_VALID_DAYS = 30;
export const DEFAULT_VALID_DAYS = 14;
const ATHLETE_FIELDS = ["athlete_ref", "name", "grade", "status"];

/** Status from the district evaluation (sports-eligibility.js). */
export const statusOf = s => s === "eligible" ? "eligible" : s === "not_eligible" ? "not_eligible" : "pending";

/**
 * A stable reference for one athlete under one agreement, so an association
 * can follow an athlete across attestations without a student ID, and two
 * associations can't link their lists.
 */
export function athleteRef(secret, agreementId, studentId) {
  return crypto.createHmac("sha256", String(secret)).update(`eduos-athlete-ref-1\u0000${agreementId}\u0000${studentId}`).digest("hex").slice(0, 20);
}

/** The district rule set the statuses come from, as a short version string. */
export function ruleVersion(policy) {
  const p = { minCoursePercent: Number(policy.minCoursePercent), minAttendancePercent: Number(policy.minAttendancePercent), windowDays: Number(policy.windowDays), minRecords: Number(policy.minRecords || 5) };
  return `district-${sha256(canonical(p)).slice(0, 16)}`;
}

const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/**
 * Build the body. `team` is evaluateTeam(...) output; `consented` a Set of
 * student IDs with an open consent for this agreement.
 */
export function buildAttestation({ id, agreement, district, school, activity, team, policy, consented, secret, asOf, validDays = DEFAULT_VALID_DAYS, attestedBy }) {
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > MAX_VALID_DAYS) throw new RangeError("valid_days");
  const shared = team.students.filter(s => consented.has(s.studentId));
  return {
    format: ATTESTATION_FORMAT, attestation_id: id,
    agreement: { id: agreement.id, association_ref: agreement.association_ref, association_name: agreement.association_name, purpose: agreement.purpose },
    district: { tenant_ref: district.id, name: district.name }, school: { name: school.name }, activity: { title: activity.title },
    as_of: asOf, expires_on: addDays(asOf, validDays),
    rule: { version: ruleVersion(policy), basis: "The district's academic and attendance eligibility rules on the date above. Association rules are applied by the association." },
    athletes: shared.map(s => ({ athlete_ref: athleteRef(secret, agreement.id, s.studentId), name: s.name, grade: s.grade ?? null, status: statusOf(s.status) }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.athlete_ref.localeCompare(b.athlete_ref)),
    withheld: team.students.length - shared.length,
    attested_by: { name: attestedBy.name, role: "athletic_director" },
  };
}

export function signAttestation(body, keys) {
  if (body?.format !== ATTESTATION_FORMAT) throw new TypeError("not an attestation");
  if (!keys) throw new Error("exchange_signing_not_configured");
  const text = canonical(body);
  return { ...body, signature: { alg: "Ed25519", keyFingerprint: keys.fingerprint, sha256: sha256(text), value: crypto.sign(null, Buffer.from(text), keys.private).toString("base64") } };
}

/**
 * For the association: check an attestation file against the district's
 * public key (parsePublicKey output) on day `on`. Returns {ok, body, sha256}
 * or {ok:false, reason}: not_an_attestation, malformed, altered, wrong_key,
 * bad_signature, not_yet_valid, expired.
 */
export function verifyAttestation(pkg, key, on = new Date().toISOString().slice(0, 10)) {
  if (!pkg || typeof pkg !== "object" || pkg.format !== ATTESTATION_FORMAT) return { ok: false, reason: "not_an_attestation" };
  const { signature, ...body } = pkg;
  if (!signature || signature.alg !== "Ed25519" || typeof signature.value !== "string") return { ok: false, reason: "malformed" };
  let text; try { text = canonical(body); } catch { return { ok: false, reason: "malformed" }; }
  if (sha256(text) !== signature.sha256) return { ok: false, reason: "altered" };
  if (!key || signature.keyFingerprint !== key.fingerprint) return { ok: false, reason: "wrong_key" };
  let good = false; try { good = crypto.verify(null, Buffer.from(text), key.key, Buffer.from(signature.value, "base64")); } catch { good = false; }
  if (!good) return { ok: false, reason: "bad_signature" };
  if (!Array.isArray(body.athletes) || body.athletes.some(a => !a || Object.keys(a).some(k => !ATHLETE_FIELDS.includes(k)) || !STATUSES.includes(a.status)))
    return { ok: false, reason: "malformed" };
  if (on < body.as_of) return { ok: false, reason: "not_yet_valid" };
  if (on > body.expires_on) return { ok: false, reason: "expired" };
  return { ok: true, body, sha256: signature.sha256 };
}
