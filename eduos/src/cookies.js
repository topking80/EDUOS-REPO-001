// Small RFC 6265 cookie helpers. Keeps authentication parsing deterministic and
// avoids loading an optional package merely to import the auth middleware.
export function parse(header = "") {
  const result = Object.create(null);
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key || Object.hasOwn(result, key)) continue;
    const raw = part.slice(index + 1).trim();
    try { result[key] = decodeURIComponent(raw); } catch { result[key] = raw; }
  }
  return result;
}

export function serialize(name, value, options = {}) {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new TypeError("Invalid cookie name");
  const encoded = encodeURIComponent(String(value)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const parts = [`${name}=${encoded}`];
  if (options.maxAge !== undefined) {
    const age = Math.floor(Number(options.maxAge));
    if (!Number.isFinite(age)) throw new TypeError("Invalid cookie maxAge");
    parts.push(`Max-Age=${age}`);
  }
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.expires) parts.push(`Expires=${new Date(options.expires).toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) {
    const sameSite = String(options.sameSite).toLowerCase();
    const normalized = sameSite === "strict" ? "Strict" : sameSite === "none" ? "None" : "Lax";
    parts.push(`SameSite=${normalized}`);
  }
  return parts.join("; ");
}
