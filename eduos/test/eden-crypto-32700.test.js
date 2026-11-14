// 32.7.0 EDEN: signed node identity under one trust root, signed bundles,
// sealed DECN packages, and the single egress point.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { generateIdentityKeys, issueCertificate, verifyCertificate, signRequest, verifyRequestSignature, signBundle, verifyBundle, seal, open, canonical, proofOfPossession, checkProofOfPossession } from "../src/eden/crypto.js";

const D = "00000000-0000-4000-8000-000000000001", S = "00000000-0000-4000-8000-000000000101";
const rk = generateIdentityKeys({ box: false });
const root = issueCertificate({ kind: "root", id: "eden-root", name: "Root", signPublic: rk.signPublic, issuerPrivate: rk.signPrivate, days: 3650 });
const dk = generateIdentityKeys();
const district = issueCertificate({ kind: "district", id: `district-${D}`, name: "D", districtId: D, signPublic: dk.signPublic, boxPublic: dk.boxPublic, issuer: root, issuerPrivate: rk.signPrivate });
const nk = generateIdentityKeys(), pk = generateIdentityKeys();
const node = issueCertificate({ kind: "node", id: "00000000-0000-4000-8000-00000000aaaa", name: "A", districtId: D, schoolId: S, signPublic: nk.signPublic, boxPublic: nk.boxPublic, issuer: district, issuerPrivate: dk.signPrivate });
const partner = issueCertificate({ kind: "node", id: "00000000-0000-4000-8000-00000000bbbb", name: "B", districtId: D, schoolId: "00000000-0000-4000-8000-000000000102", signPublic: pk.signPublic, boxPublic: pk.boxPublic, issuer: district, issuerPrivate: dk.signPrivate });

test("certificate chain: root -> district -> node verifies under the pinned root", () => {
  assert.equal(verifyCertificate(district, { root }).ok, true);
  assert.equal(verifyCertificate(node, { root, chain: [district] }).ok, true);
});
test("a certificate signed by another root, a tampered one, or a revoked one is refused", () => {
  const ok2 = generateIdentityKeys({ box: false });
  const other = issueCertificate({ kind: "root", id: "eden-root", name: "Evil", signPublic: ok2.signPublic, issuerPrivate: ok2.signPrivate });
  assert.equal(verifyCertificate(district, { root: other }).ok, false);
  assert.equal(verifyCertificate({ ...node, subject: { ...node.subject, schoolId: "00000000-0000-4000-8000-000000000102" } }, { root, chain: [district] }).reason, "signature_invalid");
  assert.equal(verifyCertificate(node, { root, chain: [district], revokedSerials: new Set([node.serial]) }).reason, "revoked");
  assert.equal(verifyCertificate(node, { root, chain: [] }).reason, "issuer_not_in_chain");
  assert.equal(verifyCertificate(node, { root, chain: [district], now: Date.parse(node.notAfter) + 1000 }).ok, false);
});
test("a node cannot issue certificates and a district cannot issue for another district", () => {
  assert.throws(() => issueCertificate({ kind: "node", id: "x", districtId: D, schoolId: S, signPublic: nk.signPublic, issuer: node, issuerPrivate: nk.signPrivate }));
  assert.throws(() => issueCertificate({ kind: "node", id: "x", districtId: "00000000-0000-4000-8000-000000000002", schoolId: S, signPublic: nk.signPublic, issuer: district, issuerPrivate: dk.signPrivate }));
});
test("signed requests: body, path and method are covered; old timestamps are refused", () => {
  const body = canonical({ a: 1 });
  const h = Object.fromEntries(Object.entries(signRequest({ nodeId: node.subject.id, signPrivate: nk.signPrivate, method: "POST", path: "/api/eden/v1/messages", body })).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(verifyRequestSignature({ signPublic: nk.signPublic, method: "POST", path: "/api/eden/v1/messages", body, headers: h }).ok, true);
  assert.equal(verifyRequestSignature({ signPublic: nk.signPublic, method: "POST", path: "/api/eden/v1/messages", body: canonical({ a: 2 }), headers: h }).reason, "bad_signature");
  assert.equal(verifyRequestSignature({ signPublic: nk.signPublic, method: "POST", path: "/api/eden/v1/heartbeat", body, headers: h }).reason, "bad_signature");
  assert.equal(verifyRequestSignature({ signPublic: pk.signPublic, method: "POST", path: "/api/eden/v1/messages", body, headers: h }).reason, "bad_signature");
  assert.equal(verifyRequestSignature({ signPublic: nk.signPublic, method: "POST", path: "/api/eden/v1/messages", body, headers: h, now: Date.now() + 10 * 60_000 }).reason, "clock_skew");
});
test("proof of possession binds the enrollment token to the node's keys", () => {
  const proof = proofOfPossession(nk.signPrivate, "tokenhash\nbox");
  assert.equal(checkProofOfPossession(nk.signPublic, "tokenhash\nbox", proof), true);
  assert.equal(checkProofOfPossession(pk.signPublic, "tokenhash\nbox", proof), false);
});
test("bundles: signed, versioned (monotonic), and never signed by a node", () => {
  const b = signBundle({ kind: "catalog", version: 3, payload: { apps: [{ name: "Reading Room" }] }, signerCert: district, signPrivate: dk.signPrivate });
  assert.equal(verifyBundle(b, { root, chain: [district], minVersion: 2 }).ok, true);
  assert.equal(verifyBundle(b, { root, chain: [district], minVersion: 3 }).reason, "stale_version");
  assert.equal(verifyBundle({ ...b, payload: { apps: [] } }, { root, chain: [district] }).reason, "payload_hash_mismatch");
  const forged = signBundle({ kind: "catalog", version: 9, payload: {}, signerCert: node, signPrivate: nk.signPrivate });
  assert.equal(verifyBundle(forged, { root, chain: [district, node] }).ok, false);
  const rootBundle = signBundle({ kind: "content", version: 1, payload: { standards: [] }, signerCert: root, signPrivate: rk.signPrivate });
  assert.equal(verifyBundle(rootBundle, { root }).ok, true);
});
test("sealed DECN package: only the partner opens it; the district cannot; tampering is detected", () => {
  const env = seal({ plaintext: canonical({ students: [{ name: "Ava Morgan" }] }), recipientBoxPublic: pk.boxPublic, senderId: node.subject.id, senderSignPrivate: nk.signPrivate,
    recipientId: partner.subject.id, purpose: "decn_continuity", ref: S });
  assert.ok(!JSON.stringify(env).includes("Ava"));
  assert.match(open(env, { recipientBoxPrivate: pk.boxPrivate, senderSignPublic: nk.signPublic, expectPurpose: "decn_continuity" }), /Ava Morgan/);
  assert.throws(() => open(env, { recipientBoxPrivate: dk.boxPrivate, senderSignPublic: nk.signPublic }));
  assert.throws(() => open({ ...env, ref: "other" }, { recipientBoxPrivate: pk.boxPrivate, senderSignPublic: nk.signPublic }));
  assert.throws(() => open(env, { recipientBoxPrivate: pk.boxPrivate, senderSignPublic: pk.signPublic }));
  assert.throws(() => open(env, { recipientBoxPrivate: pk.boxPrivate, senderSignPublic: nk.signPublic, expectPurpose: "decn_return" }));
});

// ---- static checks: ONE egress point ----------------------------------------
const files = dir => readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: true }).filter(f => f.endsWith(".js")).map(f => `${dir}/${f}`);
const src = f => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
test("only src/eden/egress.js writes the outbox or calls the hub with a node signature", () => {
  for (const f of files("src")) {
    const s = src(f);
    if (f !== "src/eden/egress.js") assert.doesNotMatch(s, /INSERT INTO eden_outbox/i, f);
    if (!["src/eden/egress.js", "src/eden/runtime.js"].includes(f)) assert.doesNotMatch(s, /hubRequest\(/, f);
    if (!["src/eden/runtime.js", "src/eden/crypto.js"].includes(f)) assert.doesNotMatch(s, /signRequest\(/, f);
  }
  // The node's only unsigned upward call is enrollment (keys + token proof, no people).
  const node = src("src/eden/node.js");
  assert.deepEqual([...node.matchAll(/hubPost\("([^"]+)"/g)].map(m => m[1]), ["/api/eden/v1/enroll"]);
  assert.doesNotMatch(node, /\bfetch\(/);
});
test("egress re-verifies gate output at send time, and the hub re-verifies on arrival", () => {
  assert.match(src("src/eden/egress.js"), /verifyReleased\(r\.payload, \{ identifiers: ids, schoolId \}\)/);
  assert.match(src("src/eden/hub.js"), /verifyReleased\(m\.payload, \{ schoolId: req\.node\.school_id \}\)/);
});
test("consent exceptions are off by default", () => {
  assert.match(src("src/config.js"), /edenConsentExceptions: process\.env\.EDEN_CONSENT_EXCEPTIONS === "on"/);
});
test("migration 015: RLS on every new table, append-only logs, no location / face / score columns", () => {
  const sql = src("db/015_eden_local_node_decn.sql");
  const tables = [...sql.matchAll(/CREATE TABLE (\w+)/g)].map(m => m[1]);
  for (const t of tables) assert.match(sql, new RegExp(`'${t}'`), `${t} in the RLS loop`);
  for (const t of ["eden_egress_log", "eden_inbound_log", "eden_failover_events"]) assert.match(sql, new RegExp(`${t}_append_only BEFORE UPDATE OR DELETE ON ${t}`));
  assert.doesNotMatch(sql, /\b(latitude|longitude|gps|geo|face|biometric|threat|risk_score)\b/i);
  assert.match(sql, /scope_insert ON eden_failovers AS RESTRICTIVE FOR INSERT\s+WITH CHECK \(eduos_is_table_owner\(\) OR \(eduos_ctx_role\(\)='superintendent' AND authorized_by=eduos_ctx_user\(\)\)\)/);
});
