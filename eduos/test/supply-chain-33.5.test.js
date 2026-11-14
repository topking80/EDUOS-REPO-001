import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("SPDX SBOM and license inventory are generated from the lockfile", () => {
  const run = spawnSync(process.execPath, ["scripts/generate-sbom-and-license-inventory.js", "--check"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const base = path.join(process.cwd(), "artifacts", "supply-chain");
  const sbom = JSON.parse(fs.readFileSync(path.join(base, "eduos-sbom.spdx.json"), "utf8"));
  const license = JSON.parse(fs.readFileSync(path.join(base, "license-inventory.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.equal(sbom.packages.length, Object.keys(lock.packages).filter(x => x.startsWith("node_modules/")).length);
  assert.equal(license.packageCount, sbom.packages.length);
  assert.ok(Array.isArray(license.unknownLicensePackages));
  assert.ok(Array.isArray(license.restrictedLicensePackages));
});
