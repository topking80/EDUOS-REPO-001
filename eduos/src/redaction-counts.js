// SEC-06 (docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md §4.1): for every AI call
// that leaves the server, what redaction removed, as kinds and counts only,
// never the text. It goes on the call's usage row (ai_usage.redactions) and
// in its audit event, as evidence for the district that redaction ran,
// without creating a new store of personal data.
//
// The kinds are fixed. db/184_ai_redaction_counts.sql allows exactly these
// keys with whole-number values, so nothing else can be written there.
export const REDACTION_KINDS = Object.freeze([
  "student_name", "student_number", "titled_name", "email", "phone", "address",
  "birth_date", "url", "id_number", "long_number", "secret",
]);

/** A fresh tally for redact(), redactContent() and outboundHelpFields(). */
export const newTally = () => ({});

/** The tally as a plain object of known kinds and whole counts (unknown kinds are dropped). */
export function countsOf(tally) {
  const out = {};
  for (const kind of REDACTION_KINDS) {
    const n = tally?.[kind];
    if (Number.isInteger(n) && n > 0) out[kind] = Math.min(n, 999999);
  }
  return out;
}

/** "email:1,student_name:2", or "none": the audit detail form. */
export function countsDetail(tally) {
  const c = countsOf(tally);
  const parts = Object.keys(c).sort().map(k => `${k}:${c[k]}`);
  return parts.length ? parts.join(",") : "none";
}
