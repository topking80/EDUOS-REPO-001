// 37.6.0 Credentials Wallet: the signer against the W3C test vector, the
// Open Badges 3.0 shape, holder name choices, tamper detection and settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as vc from "../src/wallet/vc.js";
import { walletSettings } from "../src/wallet/config.js";

// W3C "Data Integrity EdDSA Cryptosuites v1.0", eddsa-jcs-2022 test vector.
const W3C_SECRET = "z3u2en7t5LR2WtQH5PfFqMqwVHBeXouLzo6haApm8XHqvjxq";
const W3C_PUBLIC = "z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2";
const W3C_DOC = {
  "@context": ["https://www.w3.org/ns/credentials/v2", "https://www.w3.org/ns/credentials/examples/v2"],
  id: "urn:uuid:58172aac-d8ba-11ed-83dd-0b3aef56cc33", type: ["VerifiableCredential", "AlumniCredential"],
  name: "Alumni Credential", description: "A minimum viable example of an Alumni Credential.",
  issuer: "https://vc.example/issuers/5678", validFrom: "2023-01-01T00:00:00Z",
  credentialSubject: { id: "did:example:abcdefgh", alumniOf: "The School of Examples" }
};
const W3C_PROOF_VALUE = "z2HnFSSPPBzR36zdDgK8PbEHeXbR56YF24jwMpt3R1eHXQzJDMWS93FCzpvJpwTWd3GAVFuUfjoJdcnTMuVor51aX";

test("key encoding matches the W3C test vector", () => {
  const seed = vc.seedFromMultibase(W3C_SECRET);
  assert.equal(vc.multibasePublicKey(vc.keyPairFromSeed(Buffer.from(seed)).publicKey), W3C_PUBLIC);
});

test("eddsa-jcs-2022 signing reproduces the W3C test vector exactly", () => {
  const seed = Buffer.from(vc.seedFromMultibase(W3C_SECRET));
  const signed = vc.signDataIntegrity(W3C_DOC, { seed, created: "2023-02-24T23:36:38Z" });
  assert.equal(signed.proof.proofValue, W3C_PROOF_VALUE);
  assert.equal(signed.proof.verificationMethod, `did:key:${W3C_PUBLIC}#${W3C_PUBLIC}`);
  assert.equal(vc.verifyDataIntegrity(signed).verified, true);
});

test("the verifier accepts the W3C secured document, which carries @context in the proof", () => {
  const secured = { ...W3C_DOC, proof: { type: "DataIntegrityProof", cryptosuite: "eddsa-jcs-2022", created: "2023-02-24T23:36:38Z",
    verificationMethod: `did:key:${W3C_PUBLIC}#${W3C_PUBLIC}`, proofPurpose: "assertionMethod", "@context": W3C_DOC["@context"], proofValue: W3C_PROOF_VALUE } };
  assert.equal(vc.verifyDataIntegrity(secured).verified, true);
  const tampered = structuredClone(secured); tampered.credentialSubject.alumniOf = "Another School";
  assert.equal(vc.verifyDataIntegrity(tampered).reason, "signature_invalid");
});

const secret = "x".repeat(40);
const D = "d1000000-0000-4000-8000-000000000001", S = "51000000-0000-4000-8000-000000000001", S2 = "52000000-0000-4000-8000-000000000002";
function badge(nameDisplay) {
  const seed = vc.deriveIssuerSeed(secret, D, S);
  const did = vc.keyPairFromSeed(seed).did;
  const b = vc.buildOpenBadge({ credential: { id: "c0000000-0000-4000-8000-0000000000aa", kind: "course_completion", title: "Algebra I", issuedAt: "2026-06-01T12:00:00Z", edalEntryHash: "ab".repeat(32) },
    learner: { fullName: "Ava Marie Lopez", salt: "s".repeat(32) }, school: { did, name: "Maple Elementary", url: "https://eduos.example/verify/?d=" + D }, nameDisplay });
  return { signed: vc.signOpenBadge(b, seed), did };
}

test("per-school issuer keys are derived, distinct per school, and stable", () => {
  const a = vc.keyPairFromSeed(vc.deriveIssuerSeed(secret, D, S)).did;
  assert.equal(a, vc.keyPairFromSeed(vc.deriveIssuerSeed(secret, D, S)).did);
  assert.notEqual(a, vc.keyPairFromSeed(vc.deriveIssuerSeed(secret, D, S2)).did);
  assert.match(a, /^did:key:z6Mk/);
  assert.throws(() => vc.deriveIssuerSeed("short", D, S));
});

test("an exported credential is an Open Badges 3.0 OpenBadgeCredential with a valid proof", () => {
  const { signed, did } = badge("initials");
  assert.deepEqual(signed["@context"], [vc.VC_V2, vc.OB_V3]);
  assert.deepEqual(signed.type, ["VerifiableCredential", "OpenBadgeCredential"]);
  assert.equal(signed.issuer.id, did);
  assert.equal(signed.credentialSubject.achievement.achievementType, "Course");
  assert.equal(signed.credentialSubject.name, "Ava L.");
  assert.equal(signed.proof.cryptosuite, "eddsa-jcs-2022");
  assert.equal(vc.verifyDataIntegrity(signed).verified, true);
  assert.equal(vc.credentialUuid(signed), "c0000000-0000-4000-8000-0000000000aa");
});

test("the holder's name choice: full, initials, or no name and no name hash", () => {
  assert.equal(badge("full").signed.credentialSubject.name, "Ava Marie Lopez");
  const none = badge("none").signed.credentialSubject;
  assert.equal(none.name, undefined);
  assert.equal(none.identifier, undefined);
  assert.equal(JSON.stringify(badge("none").signed).includes("Lopez"), false);
});

test("any change to a signed credential breaks verification", () => {
  const { signed } = badge("initials");
  for (const mutate of [c => { c.name = "Calculus"; }, c => { c.credentialSubject.name = "Someone E."; }, c => { c.validFrom = "2020-01-01T00:00:00Z"; },
    c => { c.proof.proofValue = c.proof.proofValue.slice(0, -2) + "zz"; }, c => { c.issuer.name = "Other School"; }]) {
    const copy = structuredClone(signed); mutate(copy);
    assert.equal(vc.verifyDataIntegrity(copy).verified, false);
  }
  assert.equal(vc.verifyDataIntegrity({ ...signed, proof: { ...signed.proof, verificationMethod: "did:web:evil.example#k" } }).verified, false);
  assert.equal(vc.verifyDataIntegrity(null).verified, false);
  assert.equal(vc.verifyDataIntegrity({ proof: "x" }).verified, false);
});

test("the public view shows only the minimum fields", () => {
  const view = vc.minimalView(badge("initials").signed);
  assert.deepEqual(Object.keys(view).sort(), ["achievement", "achievementType", "description", "holder", "issued", "issuer", "issuerId"]);
  assert.equal(view.holder, "Ava L.");
});

test("JCS canonical form sorts keys and drops undefined", () => {
  assert.equal(vc.jcs({ b: 1, a: [true, null, "x"], c: undefined }), '{"a":[true,null,"x"],"b":1}');
  assert.throws(() => vc.jcs({ a: NaN }));
});

test("wallet settings: off without a secret, short secrets and bad limits refused", () => {
  assert.equal(walletSettings({}).issuerSecret, "");
  assert.equal(walletSettings({}).shareMaxDays, 90);
  assert.throws(() => walletSettings({ WALLET_ISSUER_SECRET: "short" }), /32 characters/);
  assert.throws(() => walletSettings({ WALLET_SHARE_MAX_DAYS: "400" }), /WALLET_SHARE_MAX_DAYS/);
});

test("routes: holders only, CSRF on writes, no staff access, migration listed and RLS forced", () => {
  const routes = fs.readFileSync(new URL("../src/wallet-routes.js", import.meta.url), "utf8");
  assert.match(routes, /requirePermission\("wallet", "hold"\)/);
  for (const m of routes.matchAll(/app\.post\("\/api\/wallet[^"]*"([^)]*)/g)) assert.match(m[1], /requireCsrf/);
  const sql = fs.readFileSync(new URL("../db/058_credentials_wallet.sql", import.meta.url), "utf8");
  assert.match(sql, /ALTER TABLE wallet_shares FORCE ROW LEVEL SECURITY/);
  assert.match(fs.readFileSync(new URL("../src/migrate.js", import.meta.url), "utf8"), /058_credentials_wallet\.sql/);
});
