// SPORT-05: eligibility attestations: consented athletes only, minimal
// fields, signed, expiring.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { exchangeKeys } from "../src/federation/exchange.js";
import { parsePublicKey } from "../src/federation/policy-bundle.js";
import { buildAttestation, signAttestation, verifyAttestation, athleteRef, ruleVersion, statusOf } from "../src/federation/eligibility.js";

const secret = crypto.randomBytes(24).toString("hex"), keys = exchangeKeys(secret), key = parsePublicKey(keys.public);
const policy = { minCoursePercent: 60, minAttendancePercent: 90, windowDays: 30, minRecords: 5 };
const team = { students: [
  { studentId: "s-1", name: "Zoe Z", grade: "10", jersey: 4, status: "eligible", reasons: [] },
  { studentId: "s-2", name: "Amy A", grade: "11", jersey: 9, status: "not_enough_records", reasons: [{ rule: "records", text: "Not enough records" }] },
  { studentId: "s-3", name: "Bo B", grade: "9", jersey: 1, status: "not_eligible", reasons: [{ rule: "grades", text: "Below the district minimum in 1 course: Algebra" }] }] };
const build = (over = {}) => buildAttestation({ id: "11111111-1111-4111-8111-111111111111", agreement: { id: "ag-1", association_ref: "uil-tx", association_name: "UIL", purpose: "eligibility_verification" },
  district: { id: "d-1", name: "Lakeside ISD" }, school: { name: "Lakeside High" }, activity: { title: "Varsity Soccer" }, team, policy, consented: new Set(["s-1", "s-2", "s-3"]),
  secret, asOf: "2026-11-26", attestedBy: { name: "Pat AD" }, ...over });

test("only consented athletes, with only a reference, name, grade and status", () => {
  const b = build({ consented: new Set(["s-1", "s-3"]) });
  assert.deepEqual(b.athletes.map(a => [a.name, a.grade, a.status]), [["Bo B", "9", "not_eligible"], ["Zoe Z", "10", "eligible"]]);
  assert.equal(b.withheld, 1);
  for (const a of b.athletes) assert.deepEqual(Object.keys(a).sort(), ["athlete_ref", "grade", "name", "status"]);
  const text = JSON.stringify(b);
  for (const x of ["s-1", "s-3", "Algebra", "reasons", "jersey", "Amy"]) assert.ok(!text.includes(x), x);
  assert.equal(statusOf("not_enough_records"), "pending");
  assert.equal(b.expires_on, "2026-12-10");
  assert.throws(() => build({ validDays: 31 }), RangeError);
});

test("athlete references are stable per agreement and differ between agreements", () => {
  assert.equal(athleteRef(secret, "ag-1", "s-1"), athleteRef(secret, "ag-1", "s-1"));
  assert.notEqual(athleteRef(secret, "ag-1", "s-1"), athleteRef(secret, "ag-2", "s-1"));
  assert.match(athleteRef(secret, "ag-1", "s-1"), /^[0-9a-f]{20}$/);
  assert.notEqual(ruleVersion(policy), ruleVersion({ ...policy, minCoursePercent: 70 }));
});

test("the association verifies the signature and the dates", () => {
  const env = signAttestation(build(), keys);
  assert.equal(verifyAttestation(env, key, "2026-11-26").ok, true);
  assert.equal(verifyAttestation(env, key, "2026-12-11").reason, "expired");
  assert.equal(verifyAttestation(env, key, "2026-11-25").reason, "not_yet_valid");
  const changed = structuredClone(env); changed.athletes[0].status = "eligible";
  assert.equal(verifyAttestation(changed, key, "2026-11-26").reason, "altered");
  assert.equal(verifyAttestation(env, parsePublicKey(exchangeKeys(crypto.randomBytes(24).toString("hex")).public), "2026-11-26").reason, "wrong_key");
  assert.equal(verifyAttestation({ format: "x" }, key).reason, "not_an_attestation");
});
