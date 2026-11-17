// EduOS 37.6.0 enrollment funnel (deck p47). PURE: no I/O. The same status
// machine is enforced in SQL (eduos_enrollment_transition_ok in db/016).
export const STAGES = ["inquiry", "applied", "documents", "review", "offered", "accepted", "enrolled"];
export const SIDE = ["waitlisted", "declined", "withdrawn"];
export const STATUSES = [...STAGES, ...SIDE];
export const TERMINAL = new Set(["enrolled", "declined", "withdrawn"]);
export const LABELS = { inquiry: "Inquiry", applied: "Application", documents: "Documents", review: "Review", offered: "Offer",
  accepted: "Accepted", enrolled: "Enrolled", waitlisted: "Waitlist", declined: "Declined", withdrawn: "Withdrawn" };
const STAFF = [["inquiry", "applied"], ["applied", "documents"], ["applied", "review"], ["documents", "review"], ["review", "documents"],
  ["review", "offered"], ["review", "waitlisted"], ["review", "declined"], ["waitlisted", "offered"], ["waitlisted", "declined"],
  ["offered", "accepted"], ["offered", "declined"], ["offered", "waitlisted"], ["accepted", "enrolled"]];
const FAMILY = [["inquiry", "applied"], ["documents", "review"], ["offered", "accepted"], ["offered", "declined"]];
const WITHDRAWABLE = new Set(["inquiry", "applied", "documents", "review", "waitlisted", "offered", "accepted"]);
export function canTransition(from, to, { family = false } = {}) {
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) return false;
  if (from === to) return false;
  if (to === "withdrawn") return WITHDRAWABLE.has(from);
  return (family ? FAMILY : STAFF).some(([a, b]) => a === from && b === to);
}
export function nextActions(status, { family = false } = {}) {
  return STATUSES.filter(to => canTransition(status, to, { family }));
}
/** Seats: {seats|null, committed, waitlisted} -> {available|null, full} */
export function seatState({ seats, committed }) {
  if (seats == null) return { available: null, full: false };
  const available = Math.max(0, seats - committed);
  return { available, full: available === 0 };
}
export const DOC_KINDS = ["proof_of_residence", "birth_certificate", "immunization_record", "prior_school_records", "custody_document", "other"];
export const DOC_LABELS = { proof_of_residence: "Proof of residence", birth_certificate: "Birth certificate", immunization_record: "Immunization record",
  prior_school_records: "Prior school records", custody_document: "Custody document", other: "Other" };
export const DOC_MAX_BYTES = 2 * 1024 * 1024;
/** Magic-byte sniffing; the declared type must match the bytes. */
export function sniffDocument(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  return null;
}
export function safeFilename(name, mime) {
  const ext = { "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg" }[mime] || "";
  let base = String(name || "document").replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[^A-Za-z0-9 ._()-]+/g, "_").replace(/^[ ._-]+/, "").slice(0, 100);
  if (!base) base = "document";
  return base + ext;
}
export const SCHOOL_YEAR = /^\d{4}-\d{2}$/;
export const GRADE = /^(PK|K|[0-9]{1,2})$/;
