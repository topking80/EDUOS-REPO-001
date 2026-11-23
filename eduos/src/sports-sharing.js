// SPORTS-01: pure helpers for MaxPreps / Hudl links and files.
const HOSTS = { maxpreps: "maxpreps.com", hudl: "hudl.com" };
export const SERVICES = Object.keys(HOSTS);
export const SERVICE_NAME = { maxpreps: "MaxPreps", hudl: "Hudl" };

/** The normalized https link if it's on that service's site, else null. */
export function serviceLink(service, url) {
  if (!HOSTS[service] || typeof url !== "string" || url.length > 500 || /\s/.test(url)) return null;
  let u; try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.username || u.password || u.port || !(host === HOSTS[service] || host.endsWith(`.${HOSTS[service]}`))) return null;
  return u.href;
}

/** A CSV cell: quoted, and never read as a formula by a spreadsheet. */
export function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csv = (header, rows) => [header, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

/** "Ana María López" → ["Ana", "María López"]. */
export function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/);
  return [parts[0] || "", parts.slice(1).join(" ")];
}
