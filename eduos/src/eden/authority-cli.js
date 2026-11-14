#!/usr/bin/env node
// EduOS 32.7.0 EDEN trust root ("authority") command-line tool.
//
// The ROOT key signs district certificates and root bundles. Keep it OFFLINE:
// generate it on an air-gapped machine, back it up, and only bring signed
// outputs (certificates, bundles) to the district hub. The edge platform's
// Python authority client (edge-platform/eduos/authority/client.py) is still
// a stub; this tool is the working trust root for 32.7.0.
//
//   node src/eden/authority-cli.js init           --dir DIR [--name "State of X"]
//   node src/eden/authority-cli.js issue-district --dir DIR --district-id UUID --name NAME [--days 730]
//   node src/eden/authority-cli.js env            --dir DIR --district-id UUID      (prints EDEN_* lines)
//   node src/eden/authority-cli.js sign-bundle    --dir DIR --kind content --version N --payload FILE --out FILE
//   node src/eden/authority-cli.js verify         --dir DIR --cert FILE [--chain FILE]
//   node src/eden/authority-cli.js dev-init       --dir DIR --district-id UUID --env-file FILE   (local evaluation)
import { readFile, writeFile, mkdir, access, appendFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateIdentityKeys, issueCertificate, verifyCertificate, signBundle, encodeCert, certificateFingerprint, BUNDLE_KINDS } from "./crypto.js";

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { out[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i]; }
    else out._.push(argv[i]);
  }
  return out;
}
const exists = p => access(p).then(() => true, () => false);
const readJson = async p => JSON.parse(await readFile(p, "utf8"));
async function writeSecret(p, obj) { await writeFile(p, JSON.stringify(obj, null, 2), { mode: 0o600 }); await chmod(p, 0o600); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function init(dir, name = "EduOS EDEN root") {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const certPath = path.join(dir, "root.cert.json"), keyPath = path.join(dir, "root.key.json");
  if (await exists(certPath)) return { created: false, cert: await readJson(certPath) };
  const keys = generateIdentityKeys({ box: false });
  const cert = issueCertificate({ kind: "root", id: "eden-root", name, signPublic: keys.signPublic, days: 3650, issuerPrivate: keys.signPrivate });
  await writeSecret(keyPath, { signPrivate: keys.signPrivate, signPublic: keys.signPublic });
  await writeFile(certPath, JSON.stringify(cert, null, 2));
  return { created: true, cert };
}
export async function issueDistrict(dir, districtId, name, days = 730) {
  if (!UUID.test(districtId)) throw new Error("--district-id must be a UUID");
  const root = await readJson(path.join(dir, "root.cert.json"));
  const rootKey = await readJson(path.join(dir, "root.key.json"));
  const keys = generateIdentityKeys();
  const cert = issueCertificate({ kind: "district", id: `district-${districtId}`, name, districtId, signPublic: keys.signPublic, boxPublic: keys.boxPublic,
    days, issuer: root, issuerPrivate: rootKey.signPrivate });
  await writeSecret(path.join(dir, `district-${districtId}.key.json`), keys);
  await writeFile(path.join(dir, `district-${districtId}.cert.json`), JSON.stringify(cert, null, 2));
  return cert;
}
export async function envLines(dir, districtId) {
  const root = await readJson(path.join(dir, "root.cert.json"));
  const cert = await readJson(path.join(dir, `district-${districtId}.cert.json`));
  const key = await readJson(path.join(dir, `district-${districtId}.key.json`));
  return [`EDEN_ROOT_CERT=${encodeCert(root)}`, `EDEN_DISTRICT_CERT=${encodeCert(cert)}`,
    `EDEN_DISTRICT_KEY=${Buffer.from(JSON.stringify({ signPrivate: key.signPrivate, signPublic: key.signPublic })).toString("base64")}`];
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0], dir = a.dir || ".eden-dev";
  if (cmd === "init") {
    const r = await init(dir, a.name || undefined);
    console.log(`${r.created ? "created" : "exists"}: root certificate ${certificateFingerprint(r.cert).slice(0, 16)} in ${dir} (keep root.key.json offline)`);
  } else if (cmd === "issue-district") {
    const cert = await issueDistrict(dir, a["district-id"], a.name || "District", Number(a.days || 730));
    console.log(`issued district certificate serial ${cert.serial}, valid until ${cert.notAfter}`);
  } else if (cmd === "env") {
    for (const l of await envLines(dir, a["district-id"])) console.log(l);
  } else if (cmd === "sign-bundle") {
    if (!BUNDLE_KINDS.includes(a.kind)) throw new Error(`--kind must be one of ${BUNDLE_KINDS.join(", ")}`);
    const root = await readJson(path.join(dir, "root.cert.json")), key = await readJson(path.join(dir, "root.key.json"));
    const bundle = signBundle({ kind: a.kind, version: Number(a.version), payload: await readJson(a.payload), signerCert: root, signPrivate: key.signPrivate, scope: "root" });
    await writeFile(a.out, JSON.stringify(bundle, null, 2));
    console.log(`signed ${a.kind} v${bundle.version} -> ${a.out}`);
  } else if (cmd === "verify") {
    const root = await readJson(path.join(dir, "root.cert.json"));
    const chain = a.chain ? [await readJson(a.chain)] : [];
    const v = verifyCertificate(await readJson(a.cert), { root, chain });
    console.log(v.ok ? `OK ${v.subject.kind} ${v.subject.id}` : `FAIL ${v.reason}`);
    process.exitCode = v.ok ? 0 : 1;
  } else if (cmd === "dev-init") {
    const id = a["district-id"], envFile = a["env-file"];
    if (!envFile) throw new Error("--env-file is required");
    await init(dir, "EduOS EDEN root (LOCAL EVALUATION)");
    if (!(await exists(path.join(dir, `district-${id}.cert.json`)))) await issueDistrict(dir, id, "Demo district hub (LOCAL EVALUATION)");
    const current = await readFile(envFile, "utf8").catch(() => "");
    const has = k => new RegExp(`^${k}=.`, "m").test(current);
    const lines = [...(await envLines(dir, id)), "EDUOS_NODE_TIER=district", "EDEN_NODE_OFFLINE_AFTER_SECONDS=20"].filter(l => !has(l.slice(0, l.indexOf("="))));
    if (!lines.length) { console.log(`EDEN trust material already in ${envFile}`); return; }
    await appendFile(envFile, `# 32.7.0 EDEN district hub (LOCAL EVALUATION; root key in ${dir}/, git-ignored)\n${lines.join("\n")}\n`);
    console.log(`added ${lines.map(l => l.slice(0, l.indexOf("="))).join(", ")} to ${envFile}`);
  } else {
    console.log("usage: authority-cli.js init|issue-district|env|sign-bundle|verify|dev-init --dir DIR ...");
    process.exitCode = cmd ? 1 : 0;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch(e => { console.error(e.message); process.exit(1); });
