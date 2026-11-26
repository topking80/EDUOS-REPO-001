// FED-06: the exchange gateway's minimization and envelope checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { DATASETS, ENVELOPE_FORMAT, minimize, exchangeKeys, signEnvelope, checkEnvelope } from "../src/federation/exchange.js";

const keys = exchangeKeys(crypto.randomBytes(24).toString("hex"));
const agreement = { id: "xa-0123456789abcdef", producer_tenant_ref: "district-1", dataset: "enrollment_by_grade", fields: DATASETS.enrollment_by_grade.fields,
  purpose: "state_reporting", min_cell_size: 10, effective_from: "2026-08-01", effective_to: "2027-07-31", producer_public_key: keys.public };
const raw = [
  { school_id: "s1", school_name: "Elm", grade_level: "3", student_count: 42, display_name: "should never leave" },
  { school_id: "s1", school_name: "Elm", grade_level: "4", student_count: 7 },
  { school_id: "s1", school_name: "Elm", grade_level: "5", student_count: 30 },
  { school_id: "s1", school_name: "Elm", grade_level: "6", student_count: 55 },
  { school_id: "s2", school_name: "Oak", grade_level: "3", student_count: 3 },
  { school_id: "s2", school_name: "Oak", grade_level: "4", student_count: 4 }];
const envelope = (rows, extra = {}) => signEnvelope({ format: ENVELOPE_FORMAT, agreement_id: agreement.id, producer: { tenant_ref: "district-1", name: "D1" },
  dataset: "enrollment_by_grade", fields: agreement.fields, purpose: "state_reporting", period: { from: "2026-10-01", to: "2026-10-01" },
  suppression: { min_cell_size: 10, suppressed_cells: rows.filter(r => r.suppressed).length, secondary: true }, generated_at: "2026-11-26", rows, ...extra }, keys);

test("minimizing keeps only agreed fields and hides small cells, plus the next-smallest when one alone would show", () => {
  const rows = minimize("enrollment_by_grade", raw, agreement.fields, 10);
  assert.ok(rows.every(r => !("display_name" in r)), "fields outside the agreement are dropped");
  assert.deepEqual(rows.map(r => [r.school_id, r.grade_level, r.student_count, !!r.suppressed]), [
    ["s1", "3", 42, false], ["s1", "4", null, true], ["s1", "5", null, true], ["s1", "6", 55, false], ["s2", "3", null, true], ["s2", "4", null, true]]);
  assert.throws(() => minimize("enrollment_by_grade", raw, agreement.fields, 3), /min_cell_too_small/);
  assert.throws(() => minimize("student_list", raw, agreement.fields, 10), /unknown_dataset/);
  assert.ok(Object.values(DATASETS).every(ds => !ds.fields.some(f => /student_id|name_of|display|birth|email|address/.test(f) && f !== "school_name")), "no student fields in any dataset");
});

test("a minimized, signed envelope checks out against its agreement", () => {
  const pkg = envelope(minimize("enrollment_by_grade", raw, agreement.fields, 10));
  const v = checkEnvelope(pkg, agreement);
  assert.equal(v.ok, true, v.reason); assert.equal(v.body.rows.length, 6);
});

test("anything not agreed, not minimized, altered or from another key is refused", () => {
  const good = minimize("enrollment_by_grade", raw, agreement.fields, 10);
  const reason = (pkg, a = agreement) => checkEnvelope(pkg, a).reason;
  assert.equal(reason(envelope(raw.map(({ display_name, ...r }) => r))), "not_minimized", "a raw count of 7 under a minimum of 10");
  assert.equal(reason(envelope([{ ...good[0], student_id: "u-1" }, ...good.slice(1)])), "field_not_agreed");
  const lone = good.map(r => ({ ...r })); lone[2] = { ...raw[2] }; delete lone[2].suppressed;
  assert.equal(reason(envelope(lone)), "not_minimized", "secondary suppression missing");
  assert.equal(reason(envelope(good, { purpose: "research_aggregate" })), "wrong_purpose");
  assert.equal(reason(envelope(good, { agreement_id: "xa-ffffffffffffffff" })), "wrong_agreement");
  assert.equal(reason(envelope(good, { producer: { tenant_ref: "district-2" } })), "wrong_producer");
  assert.equal(reason(envelope(good, { period: { from: "2027-08-01", to: "2027-08-02" } })), "outside_agreement_period");
  assert.equal(reason(envelope(good, { suppression: { min_cell_size: 5, suppressed_cells: 4 } })), "wrong_min_cell_size");
  assert.equal(reason(envelope(good, { fields: ["school_id", "grade_level", "student_count"] })), "wrong_fields");
  const changed = envelope(good); changed.rows[0].student_count = 41;
  assert.equal(reason(changed), "altered");
  assert.equal(reason(signEnvelope({ ...envelope(good), signature: undefined }, exchangeKeys(crypto.randomBytes(24).toString("hex")))), "wrong_key");
  assert.equal(reason({ hello: 1 }), "not_an_exchange_envelope");
});
