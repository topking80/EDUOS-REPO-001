// TC-08: the preservation job's decisions, with a fake database and bucket.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createS3Storage } from "../src/s3-storage.js";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/eduos_test";
process.env.PUBLIC_ORIGIN ||= "http://localhost:8080";
process.env.OIDC_ISSUER ||= "https://identity.example.test";
process.env.OIDC_CLIENT_ID ||= "eduos-test";
process.env.OIDC_CLIENT_SECRET ||= "test-secret";
process.env.OIDC_REDIRECT_URI ||= "http://localhost:8080/auth/callback";
const { runHistoryPreservation } = await import("../src/history-preservation.js");

const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const fakeDb = due => { const calls = []; return { calls, query: async (sql, p) => {
  if (sql.includes("preservation_due")) return { rows: due };
  calls.push(p); const [, outcome, sum] = p;
  const row = due.find(d => d.asset_id === p[0]);
  return { rows: [{ r: outcome === "ok" && row.sha256 && row.sha256 !== sum ? "mismatch" : outcome === "archived" && sum !== row.sha256 ? "archive_failed" : outcome }] };
} }; };
const bucket = objs => ({ classes: {}, head: async k => objs[k] ? { byteSize: objs[k].length } : null, get: async k => objs[k],
  async setStorageClass(k, c) { this.classes[k] = c; } });

test("without storage the job does nothing and says so", async () => {
  assert.equal((await runHistoryPreservation({ db: fakeDb([]), storage: null })).storageReady, false);
});

test("verify: ok, mismatch, missing; archive only when a class is configured and the copy verifies", async () => {
  const a = Buffer.from("photo-a"), b = Buffer.from("photo-b");
  const due = [{ asset_id: "1", storage_key: "k1", sha256: sha(a), action: "verify" }, { asset_id: "2", storage_key: "k2", sha256: sha(a), action: "verify" },
    { asset_id: "3", storage_key: "k3", sha256: sha(a), action: "verify" }, { asset_id: "4", storage_key: "k4", sha256: sha(b), action: "archive" }];
  const storage = bucket({ k1: a, k2: b, k4: b });
  const db = fakeDb(due);
  let out = await runHistoryPreservation({ db, storage, archiveClass: "" });
  assert.deepEqual([out.ok, out.mismatch, out.missing, out.archived, out.skipped], [1, 1, 1, 0, 1]);
  assert.deepEqual(storage.classes, {}, "no class configured: nothing moves");
  out = await runHistoryPreservation({ db: fakeDb(due.slice(3)), storage, archiveClass: "GLACIER_IR" });
  assert.equal(out.archived, 1);
  assert.deepEqual(storage.classes, { k4: "GLACIER_IR" });
});

test("a storage outage is retried later, not reported as a lost photo", async () => {
  const db = fakeDb([{ asset_id: "1", storage_key: "k1", sha256: null, action: "verify" }]);
  const out = await runHistoryPreservation({ db, storage: { head: async () => { throw new Error("storage HEAD 503"); } } });
  assert.equal(out.errors, 1);
  assert.equal(db.calls.length, 0, "nothing recorded");
});

test("setStorageClass copies the object onto itself with the class, signed", async () => {
  let seen;
  const s3 = createS3Storage({ endpoint: "https://s3.example.test", region: "us-east-1", bucket: "b", accessKeyId: "AKTEST", secretAccessKey: "x".repeat(40), pathStyle: true,
    fetchImpl: async (url, init) => { seen = { url, init }; return new Response("<CopyObjectResult/>", { status: 200 }); } });
  await s3.setStorageClass("history/d/s/a b.jpeg", "STANDARD_IA");
  assert.equal(seen.init.method, "PUT");
  assert.equal(seen.url, "https://s3.example.test/b/history/d/s/a%20b.jpeg");
  assert.equal(seen.init.headers["x-amz-copy-source"], "/b/history/d/s/a%20b.jpeg");
  assert.equal(seen.init.headers["x-amz-storage-class"], "STANDARD_IA");
  assert.match(seen.init.headers.authorization, /SignedHeaders=[^,]*x-amz-copy-source[^,]*x-amz-storage-class/);
  const failing = createS3Storage({ endpoint: "https://s3.example.test", region: "us-east-1", bucket: "b", accessKeyId: "AKTEST", secretAccessKey: "x".repeat(40),
    fetchImpl: async () => new Response("<Error><Code>InternalError</Code></Error>", { status: 200 }) });
  await assert.rejects(failing.setStorageClass("k", "STANDARD_IA"), /COPY error/);
});
