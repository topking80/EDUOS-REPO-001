// FED-10: an integrity check of Master Control's stored state, for after a
// restore (or any time): the audit hash chain, the authority model, every
// district's chain of signed policy bundles, and every exchange delivery.
import { verifyAudit } from "./audit.js";
import { loadModel } from "./model.js";
import { validateAuthorityModel } from "../federation/authority.js";
import { canonical, sha256, parsePublicKey, verifyBundle } from "../federation/policy-bundle.js";

const iso = v => v instanceof Date ? v.toISOString() : String(v);

export async function verifyIntegrity(db, { configuredKey = null } = {}) {
  const report = { audit: await verifyAudit(db) };
  const model = validateAuthorityModel(await loadModel(db));
  report.model = { ok: model.ok, errors: model.errors.slice(0, 50) };

  const { rows: keys } = await db.query("SELECT fingerprint, public_key FROM signing_keys");
  const keyOf = new Map(keys.map(k => [k.fingerprint, parsePublicKey(k.public_key)]));
  if (configuredKey && !keyOf.has(configuredKey.fingerprint)) keyOf.set(configuredKey.fingerprint, parsePublicKey(configuredKey.public));
  const { rows: restores } = await db.query("SELECT recorded_at, version_skip FROM restore_events ORDER BY recorded_at");
  const { rows: bundles } = await db.query("SELECT id, district_node_id, version, sha256, issued_at, bundle FROM policy_bundles ORDER BY district_node_id, version");
  const problems = [], warnings = [];
  let prev = null;
  for (const b of bundles) {
    const where = { bundle: b.id, district: b.district_node_id, version: b.version };
    if (prev?.district_node_id !== b.district_node_id) prev = null;
    const fp = b.bundle?.signature?.keyFingerprint, key = keyOf.get(fp);
    if (key) {
      const v = verifyBundle(b.bundle, key);
      if (!v.ok) problems.push({ ...where, problem: v.reason });
      else if (v.sha256 !== b.sha256) problems.push({ ...where, problem: "sha256_mismatch" });
    } else {
      const { signature, ...body } = b.bundle || {};
      if (!signature || sha256(canonical(body)) !== b.sha256) problems.push({ ...where, problem: "altered" });
      else warnings.push({ ...where, warning: "signing_key_not_in_registry" });
    }
    if (b.bundle?.version !== b.version) problems.push({ ...where, problem: "version_mismatch" });
    if (prev) {
      if ((b.bundle?.previous_sha256 || null) !== prev.sha256) problems.push({ ...where, problem: "chain_broken" });
      const skip = restores.filter(r => r.recorded_at > prev.issued_at && r.recorded_at <= b.issued_at).reduce((n, r) => n + r.version_skip, 0);
      if (b.version !== prev.version + 1 + skip) problems.push({ ...where, problem: "unexpected_version", expected: prev.version + 1 + skip });
    } else if (b.bundle?.previous_sha256) warnings.push({ ...where, warning: "first_kept_bundle_has_a_predecessor" });
    prev = b;
  }
  report.bundles = { checked: bundles.length, problems, warnings };

  const { rows: deliveries } = await db.query("SELECT id, agreement_id, sha256, envelope FROM exchange_deliveries ORDER BY delivered_at, id");
  const dproblems = [];
  for (const d of deliveries) {
    const { signature, ...body } = d.envelope || {};
    let h = null; try { h = sha256(canonical(body)); } catch { h = null; }
    if (!signature || h !== d.sha256 || signature.sha256 !== d.sha256) dproblems.push({ delivery: d.id, agreement: d.agreement_id, problem: "altered" });
  }
  report.deliveries = { checked: deliveries.length, problems: dproblems };
  report.restores = restores.map(r => ({ recordedAt: iso(r.recorded_at), versionSkip: r.version_skip }));
  report.ok = report.audit.ok && report.model.ok && !problems.length && !dproblems.length;
  return report;
}
