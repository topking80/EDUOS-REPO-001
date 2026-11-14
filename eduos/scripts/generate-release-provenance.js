import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = fs.readFileSync(path.join(root, "package-lock.json"));
const files = ["package.json", "package-lock.json", "artifacts/supply-chain/eduos-sbom.spdx.json"];
const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
const hashFile = name => {
  const full = path.join(root, name);
  return fs.existsSync(full) ? sha256(fs.readFileSync(full)) : null;
};
let commit = process.env.GITHUB_SHA ?? null;
if (!commit) {
  try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { commit = null; }
}
const record = {
  schemaVersion: "1.0",
  project: pkg.name,
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  sourceRevision: commit,
  sourceRevisionStatus: commit ? "identified" : "unavailable",
  builder: { workflow: process.env.GITHUB_WORKFLOW ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
    runnerOs: process.env.RUNNER_OS ?? process.platform, node: process.version },
  materials: Object.fromEntries(files.map(name => [name, hashFile(name)])),
  lockfileSha256: sha256(lock),
  signing: { status: "not-signed", note: "This record is hash-based provenance evidence, not a cryptographic signature or SLSA attestation." }
};
const out = path.join(root, "artifacts", "supply-chain", "release-provenance.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
console.log(`Wrote ${path.relative(root, out)}; source revision ${record.sourceRevisionStatus}; signing not configured.`);
