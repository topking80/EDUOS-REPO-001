// EduOS 32.7.0 EDEN shared runtime: trust material from the environment,
// system transactions for the hub / node agent, and signed HTTP.
import { readFile, writeFile, mkdir, rename, chmod } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { withTenantTransaction } from "../db.js";
import { decodeCert, verifyCertificate, signRequest, canonical } from "./crypto.js";

export const SYSTEM_USER = "eeeeeeee-0000-4000-8000-000000000001";
const PKG = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
export const APP_VERSION = PKG.version;

/** Transaction as the hub process ("eden_hub") or the node agent ("eden_agent"). */
export function withSystem(role, districtId, schoolId, fn) {
  if (!["eden_hub", "eden_agent"].includes(role)) throw new TypeError("unknown system role");
  return withTenantTransaction({ districtId, userId: SYSTEM_USER, role, schoolId: schoolId || null }, fn);
}

let rootCache;
/** The pinned root certificate (EDEN_ROOT_CERT), verified self-signed. */
export function pinnedRoot() {
  if (rootCache !== undefined) return rootCache;
  const root = decodeCert(config.edenRootCert);
  rootCache = root && verifyCertificate(root, { root }).ok ? root : null;
  return rootCache;
}
/** District hub trust material: its certificate (root-signed) and private key. */
export function districtIdentity() {
  const root = pinnedRoot();
  const cert = decodeCert(config.edenDistrictCert);
  if (!root || !cert || !config.edenDistrictKey) return null;
  const v = verifyCertificate(cert, { root });
  if (!v.ok || cert.subject.kind !== "district") return null;
  let key;
  try { key = JSON.parse(Buffer.from(config.edenDistrictKey, "base64").toString("utf8")); } catch { return null; }
  if (!key?.signPrivate) return null;
  return { cert, root, signPrivate: key.signPrivate, districtId: cert.subject.districtId };
}

// ---- node identity file (private keys never go in the database) ----------
export async function loadNodeIdentity(file = config.edenIdentityFile) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
export async function saveNodeIdentity(identity, file = config.edenIdentityFile) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

/** Signed request from a node to its district hub. Returns { status, body }. */
export async function hubRequest(identity, method, apiPath, payload) {
  if (!config.edenHubUrl) throw Object.assign(new Error("EDEN_HUB_URL is not set"), { code: "no_hub" });
  const body = payload === undefined ? "" : canonical(payload);
  const headers = { ...signRequest({ nodeId: identity.nodeId, signPrivate: identity.keys.signPrivate, method, path: apiPath, body }) };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${config.edenHubUrl}${apiPath}`, { method, headers, body: body || undefined, signal: AbortSignal.timeout(config.edenHttpTimeoutMs), redirect: "error" });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json, bytes: Buffer.byteLength(body) };
}
/** Unsigned request (enrollment, before the node has a certificate). */
export async function hubPost(apiPath, payload) {
  const res = await fetch(`${config.edenHubUrl}${apiPath}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.edenHttpTimeoutMs), redirect: "error" });
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}
