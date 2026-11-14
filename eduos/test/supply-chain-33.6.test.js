import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("release provenance records lockfile and SBOM hashes without claiming signature", () => {
  const gen = spawnSync(process.execPath, ["scripts/generate-sbom-and-license-inventory.js", "--check"], { encoding: "utf8" });
  assert.equal(gen.status, 0, gen.stderr || gen.stdout);
  const run = spawnSync(process.execPath, ["scripts/generate-release-provenance.js"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const record = JSON.parse(fs.readFileSync(path.join("artifacts", "supply-chain", "release-provenance.json"), "utf8"));
  assert.equal(record.schemaVersion, "1.0");
  assert.match(record.lockfileSha256, /^[a-f0-9]{64}$/);
  assert.equal(record.materials["package-lock.json"], record.lockfileSha256);
  assert.equal(record.signing.status, "not-signed");
  assert.ok(record.project && record.version);
});
