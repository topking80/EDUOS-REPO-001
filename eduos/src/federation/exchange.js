// FED-06: the cross-tenant exchange gateway's data contract. Aggregates only.
//
// A district's EduOS builds an aggregate report for one exchange agreement,
// minimizes it (allow-listed fields, small-cell suppression with secondary
// suppression) and signs it. Master Control checks it against the agreement
// (parties, dataset, fields, purpose, period, minimum cell size, signature)
// before the recipient can read it. No dataset here can carry a student
// identifier or a per-student row, and the checker refuses anything outside
// the allow-list.
import crypto from "node:crypto";
import { canonical, sha256, fingerprintOf, parsePublicKey } from "./policy-bundle.js";

export const ENVELOPE_FORMAT = "eduos-exchange-1";
export const TERMS_FORMAT = "eduos-exchange-terms-1";
export const MIN_CELL_FLOOR = 5;       // no agreement may allow smaller cells
export const DEFAULT_MIN_CELL = 10;
export const MAX_ROWS = 5000;
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const LABEL = "eduos-exchange-signing-v1";

/**
 * The aggregate datasets the gateway can carry. `group` is the field rows
 * are grouped by for secondary suppression; `count` is the suppressible
 * measure. Every field is a school-level dimension or a count.
 */
export const DATASETS = {
  enrollment_by_grade: { name: "Enrollment by school and grade", fields: ["school_id", "school_name", "grade_level", "student_count"],
    required: ["school_id", "grade_level", "student_count"], group: "school_id", count: "student_count" },
  sports_participation: { name: "Students on sports rosters, by school", fields: ["school_id", "school_name", "participant_count"],
    required: ["school_id", "participant_count"], group: null, count: "participant_count" },
};
export const PURPOSES = { state_reporting: "Required state reporting", operations_planning: "Operations and planning", research_aggregate: "Approved research (aggregate)" };

/**
 * Minimize rows: keep only the agreed fields; suppress any count below the
 * minimum cell size; then, within each group, if exactly one cell is
 * suppressed, suppress the next-smallest too, so it can't be worked out
 * from a known total.
 */
export function minimize(datasetId, rows, fields, minCell) {
  const ds = DATASETS[datasetId];
  if (!ds) throw new Error("unknown_dataset");
  if (!Number.isInteger(minCell) || minCell < MIN_CELL_FLOOR) throw new Error("min_cell_too_small");
  const keep = fields.filter(f => ds.fields.includes(f));
  const out = rows.map(r => {
    const row = Object.fromEntries(keep.map(f => [f, r[f] ?? null]));
    if (Number.isInteger(row[ds.count]) && row[ds.count] < minCell) { row[ds.count] = null; row.suppressed = true; }
    return row;
  });
  if (ds.group) {
    const groups = new Map();
    for (const r of out) (groups.get(r[ds.group]) || groups.set(r[ds.group], []).get(r[ds.group])).push(r);
    for (const g of groups.values()) {
      if (g.filter(r => r.suppressed).length !== 1) continue;
      const next = g.filter(r => !r.suppressed).sort((a, b) => a[ds.count] - b[ds.count])[0];
      if (next) { next[ds.count] = null; next.suppressed = true; }
    }
  }
  return out;
}

export function exchangeKeys(secret) {
  if (!secret) return null;
  if (secret.length < 32) throw new Error("EXCHANGE_SIGNING_SECRET must be at least 32 characters");
  const seed = crypto.createHmac("sha256", secret).update(LABEL).digest();
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
  return { private: priv, public: pub, fingerprint: fingerprintOf(pub) };
}

export function signEnvelope(body, keys) {
  if (body?.format !== ENVELOPE_FORMAT) throw new TypeError("not an exchange envelope");
  if (!keys) throw new Error("exchange_signing_not_configured");
  const text = canonical(body);
  return { ...body, signature: { alg: "Ed25519", keyFingerprint: keys.fingerprint, sha256: sha256(text), value: crypto.sign(null, Buffer.from(text), keys.private).toString("base64") } };
}

/**
 * Check an envelope against its agreement. `agreement` = {id, producer_tenant_ref,
 * dataset, fields, purpose, min_cell_size, effective_from, effective_to,
 * producer_public_key}. Returns {ok, body, sha256} or {ok:false, reason, detail?}.
 */
export function checkEnvelope(pkg, agreement) {
  if (!pkg || typeof pkg !== "object" || pkg.format !== ENVELOPE_FORMAT) return { ok: false, reason: "not_an_exchange_envelope" };
  const { signature, ...body } = pkg;
  if (!signature || signature.alg !== "Ed25519" || typeof signature.value !== "string") return { ok: false, reason: "malformed" };
  let text; try { text = canonical(body); } catch { return { ok: false, reason: "malformed" }; }
  if (sha256(text) !== signature.sha256) return { ok: false, reason: "altered" };
  const key = parsePublicKey(agreement.producer_public_key || "");
  if (!key || signature.keyFingerprint !== key.fingerprint) return { ok: false, reason: "wrong_key" };
  let good = false; try { good = crypto.verify(null, Buffer.from(text), key.key, Buffer.from(signature.value, "base64")); } catch { good = false; }
  if (!good) return { ok: false, reason: "bad_signature" };
  const fail = (reason, detail) => ({ ok: false, reason, detail });
  if (body.agreement_id !== agreement.id) return fail("wrong_agreement");
  if (body.producer?.tenant_ref !== agreement.producer_tenant_ref) return fail("wrong_producer");
  if (body.dataset !== agreement.dataset || !DATASETS[body.dataset]) return fail("wrong_dataset");
  if (body.purpose !== agreement.purpose) return fail("wrong_purpose");
  if (JSON.stringify(body.fields) !== JSON.stringify(agreement.fields)) return fail("wrong_fields");
  // Snapshot reporting only: EduOS counts what it holds today, so a report
  // covers exactly one day, its as_of date, and that day must fall inside
  // the agreement's window. Nothing is labelled as covering any other period.
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const p = body.period || {};
  if (!DAY.test(body.as_of || "") || p.from !== body.as_of || p.to !== body.as_of || body.snapshot !== true) return fail("not_a_snapshot");
  if (body.as_of < agreement.effective_from || body.as_of > agreement.effective_to) return fail("outside_agreement_period");
  if (body.suppression?.min_cell_size !== agreement.min_cell_size) return fail("wrong_min_cell_size");
  const ds = DATASETS[body.dataset];
  if (!Array.isArray(body.rows) || body.rows.length > MAX_ROWS) return fail("malformed", "rows");
  const allowed = new Set([...agreement.fields, "suppressed"]);
  for (const [i, r] of body.rows.entries()) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return fail("malformed", `row ${i}`);
    const extra = Object.keys(r).filter(k => !allowed.has(k));
    if (extra.length) return fail("field_not_agreed", `row ${i}: ${extra.join(", ")}`);
    for (const f of ds.required) if (agreement.fields.includes(f) && !(f in r)) return fail("malformed", `row ${i}: ${f}`);
    for (const [k, v] of Object.entries(r)) if (v !== null && typeof v === "object") return fail("malformed", `row ${i}: ${k}`);
    const n = r[ds.count];
    if (r.suppressed === true ? n !== null : !(Number.isInteger(n) && n >= agreement.min_cell_size)) return fail("not_minimized", `row ${i}`);
  }
  if (ds.group) {
    const groups = new Map();
    for (const r of body.rows) groups.set(r[ds.group], (groups.get(r[ds.group]) || 0) + (r.suppressed ? 1 : 0));
    const lone = [...groups.entries()].filter(([g, n]) => n === 1 && body.rows.filter(r => r[ds.group] === g).length > 1);
    if (lone.length) return fail("not_minimized", `secondary suppression missing for ${lone.length} group(s)`);
  }
  return { ok: true, body, sha256: signature.sha256 };
}

// ---- Agreement terms ----------------------------------------------------------
// Master Control gives the producing district the agreement's exact terms,
// signed with its policy key (the one the district's EduOS already trusts for
// FED-05). EduOS builds a report only from verified terms, so the fields,
// purpose and minimum cell size are exactly what both sides approved.

/** Sign terms with Master Control's policy keys ({private, fingerprint}). */
export function signTerms(body, keys) {
  if (body?.format !== TERMS_FORMAT) throw new TypeError("not exchange terms");
  if (!keys) throw new Error("policy_signing_not_configured");
  const text = canonical(body);
  return { ...body, signature: { alg: "Ed25519", keyFingerprint: keys.fingerprint, sha256: sha256(text), value: crypto.sign(null, Buffer.from(text), keys.private).toString("base64") } };
}

/**
 * Check terms against the trusted Master Control key, for this district, on
 * this date. Returns {ok, terms} or {ok:false, reason}.
 */
export function verifyTerms(pkg, trusted, tenantRef, on) {
  if (!pkg || typeof pkg !== "object" || pkg.format !== TERMS_FORMAT) return { ok: false, reason: "not_exchange_terms" };
  const { signature, ...body } = pkg;
  if (!signature || signature.alg !== "Ed25519" || typeof signature.value !== "string") return { ok: false, reason: "malformed" };
  let text; try { text = canonical(body); } catch { return { ok: false, reason: "malformed" }; }
  if (sha256(text) !== signature.sha256) return { ok: false, reason: "altered" };
  if (!trusted || signature.keyFingerprint !== trusted.fingerprint) return { ok: false, reason: "wrong_key" };
  let good = false; try { good = crypto.verify(null, Buffer.from(text), trusted.key, Buffer.from(signature.value, "base64")); } catch { good = false; }
  if (!good) return { ok: false, reason: "bad_signature" };
  const ds = DATASETS[body.dataset];
  if (!ds || !Array.isArray(body.fields) || body.fields.some(f => !ds.fields.includes(f)) || ds.required.some(f => !body.fields.includes(f))
      || !PURPOSES[body.purpose] || !Number.isInteger(body.min_cell_size) || body.min_cell_size < MIN_CELL_FLOOR || !/^xa-[0-9a-f]{16}$/.test(body.agreement_id || "")
      || (body.consent_reference != null && (typeof body.consent_reference !== "string" || body.consent_reference.length > 200)))
    return { ok: false, reason: "malformed" };
  if (body.producer?.tenant_ref !== tenantRef) return { ok: false, reason: "not_for_this_district" };
  if (on < body.effective_from) return { ok: false, reason: "agreement_not_started" };
  if (on > body.effective_to) return { ok: false, reason: "agreement_ended" };
  return { ok: true, terms: body };
}
