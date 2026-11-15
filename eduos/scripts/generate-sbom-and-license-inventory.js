import fs from "node:fs";
import path from "node:path";

// Write via a temp file and rename, so a reader (another test running the
// generator at the same time) never sees a half-written file.
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const root = process.cwd();
const lockPath = path.join(root, "package-lock.json");
const pkgPath = path.join(root, "package.json");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const outDir = path.join(root, "artifacts", "supply-chain");
fs.mkdirSync(outDir, { recursive: true });

const direct = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);
const packages = Object.entries(lock.packages ?? {})
  .filter(([p]) => p && !p.startsWith("node_modules/") ? false : Boolean(p))
  .map(([p, data]) => {
    const name = data.name ?? p.replace(/^node_modules\//, "").replace(/.*\/node_modules\//, "");
    return { path: p, name, version: data.version ?? "UNKNOWN", license: data.license ?? null,
      direct: p.startsWith("node_modules/") && direct.has(name), resolved: data.resolved ?? null,
      integrity: data.integrity ?? null };
  })
  .filter(x => x.version !== "UNKNOWN")
  .sort((a,b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const spdxId = x => `SPDXRef-Package-${Buffer.from(`${x.name}@${x.version}`).toString("hex").slice(0,48)}`;
const sbom = {
  spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT",
  name: `${pkg.name}-${pkg.version}`, documentNamespace: `https://eduos.invalid/spdx/${pkg.name}/${pkg.version}/${Date.now()}`,
  creationInfo: { creators: ["Tool: eduos-sbom-generator-33.5.0"], created: new Date().toISOString() },
  packages: packages.map(x => ({
    name: x.name, SPDXID: spdxId(x), versionInfo: x.version,
    downloadLocation: x.resolved ?? "NOASSERTION",
    filesAnalyzed: false, licenseConcluded: "NOASSERTION",
    licenseDeclared: x.license ?? "NOASSERTION",
    copyrightText: "NOASSERTION",
    externalRefs: x.integrity ? [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl",
      referenceLocator: `pkg:npm/${encodeURIComponent(x.name)}@${x.version}` }] : []
  })),
  relationships: packages.map(x => ({ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: spdxId(x) }))
};
writeAtomic(path.join(outDir, "eduos-sbom.spdx.json"), JSON.stringify(sbom, null, 2) + "\n");

const restricted = /^(AGPL-\d(?:\\.\d)?|GPL-\d(?:\\.\d)?|SSPL-\d(?:\\.\d)?|BUSL-\d(?:\\.\d)?)/i;
const unknown = packages.filter(x => !x.license);
const flagged = packages.filter(x => x.license && restricted.test(x.license));
const report = {
  generatedAt: new Date().toISOString(), project: pkg.name, version: pkg.version,
  source: "package-lock.json metadata only; not a legal determination",
  packageCount: packages.length, directDependencyNames: [...direct].sort(),
  unknownLicenseCount: unknown.length,
  unknownLicensePackages: unknown.map(({name,version}) => ({name,version})),
  restrictedLicenseCount: flagged.length,
  restrictedLicensePackages: flagged.map(({name,version,license}) => ({name,version,license})),
  policy: "Restricted licenses are flagged for legal review; unknown licenses are reported but do not automatically fail."
};
writeAtomic(path.join(outDir, "license-inventory.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`SBOM: ${packages.length} locked packages; ${unknown.length} unknown licenses; ${flagged.length} restricted-license candidates.`);
if (process.argv.includes("--check") && flagged.length) process.exitCode = 1;
